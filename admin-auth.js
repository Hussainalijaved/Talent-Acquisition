/**
 * Talent Admin — Supabase Auth + role-based access
 */
(function (global) {
    'use strict';

    const VIEW_ROLES = {
        overview: ['super_admin', 'recruiter', 'hiring_manager', 'viewer'],
        candidates: ['super_admin', 'recruiter', 'hiring_manager', 'viewer'],
        pipeline: ['super_admin', 'recruiter', 'hiring_manager', 'viewer'],
        jobs: ['super_admin', 'recruiter'],
        screen: ['super_admin', 'recruiter'],
        onsite: ['super_admin', 'recruiter'],
        settings: ['super_admin'],
        users: ['super_admin'],
        audit: ['super_admin'],
    };

    const PERMS = {
        delete_candidate: ['super_admin'],
        delete_job: ['super_admin'],
        save_webhooks: ['super_admin'],
        edit_jobs: ['super_admin', 'recruiter'],
        screen_cv: ['super_admin', 'recruiter'],
        onsite_write: ['super_admin', 'recruiter'],
        manage_users: ['super_admin'],
        view_audit: ['super_admin'],
    };

    let _client = null;
    let _profile = null;

    function cfg() {
        return global.TA_CONFIG || {};
    }

    function client() {
        if (_client) return _client;
        const c = cfg();
        if (!global.supabase?.createClient) throw new Error('Supabase JS not loaded');
        _client = global.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true,
            },
        });
        return _client;
    }

    function profile() {
        return _profile;
    }

    function hasRole(...roles) {
        return !!_profile && roles.includes(_profile.role);
    }

    function can(perm) {
        const roles = PERMS[perm];
        return roles ? hasRole(...roles) : false;
    }

    function canView(view) {
        const roles = VIEW_ROLES[view];
        return roles ? hasRole(...roles) : false;
    }

    function roleLabel(role) {
        const map = {
            super_admin: 'Super Admin',
            recruiter: 'Recruiter',
            hiring_manager: 'Hiring Manager',
            viewer: 'Viewer',
        };
        return map[role] || role;
    }

    async function getSession() {
        const { data, error } = await client().auth.getSession();
        if (error) throw error;
        return data.session;
    }

    async function loadProfile() {
        const session = await getSession();
        if (!session) return null;
        const { data, error } = await client()
            .from('profiles')
            .select('id, email, full_name, role, is_active, created_at')
            .eq('id', session.user.id)
            .maybeSingle();
        if (error) throw error;
        if (!data || !data.is_active) {
            await signOut();
            global.location.href = 'login.html?error=inactive';
            return null;
        }
        _profile = data;
        return data;
    }

    async function requireAuth(loginPath) {
        const session = await getSession();
        if (!session) {
            const redirect = encodeURIComponent(global.location.pathname + global.location.search);
            global.location.href = (loginPath || 'login.html') + '?redirect=' + redirect;
            return null;
        }
        return session;
    }

    async function signIn(email, password) {
        const { data, error } = await client().auth.signInWithPassword({
            email: String(email || '').trim().toLowerCase(),
            password: String(password || ''),
        });
        if (error) throw error;
        return data;
    }

    async function signUp(email, password, meta) {
        const { data, error } = await client().auth.signUp({
            email: String(email || '').trim().toLowerCase(),
            password: String(password || ''),
            options: { data: meta || {} },
        });
        if (error) throw error;
        return data;
    }

    /** Invite without replacing the current admin session */
    async function inviteUser(email, password, meta) {
        const c = cfg();
        const temp = global.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                storageKey: 'ta-invite-session',
            },
        });
        const { data, error } = await temp.auth.signUp({
            email: String(email || '').trim().toLowerCase(),
            password: String(password || ''),
            options: { data: meta || {} },
        });
        if (error) throw error;
        return data;
    }

    async function signOut() {
        _profile = null;
        await client().auth.signOut();
    }

    async function needsBootstrap() {
        const { data, error } = await client().rpc('needs_admin_bootstrap');
        if (error) {
            console.warn('needs_admin_bootstrap', error);
            return false;
        }
        return !!data;
    }

    async function canBootstrap(secret) {
        const { data, error } = await client().rpc('can_bootstrap_admin', { p_secret: secret });
        if (error) return false;
        return !!data;
    }

    async function logAudit(action, entityType, entityId, meta) {
        if (!_profile) return;
        try {
            await client().from('audit_log').insert({
                actor_id: _profile.id,
                action,
                entity_type: entityType || null,
                entity_id: entityId ? String(entityId) : null,
                meta: meta || {},
            });
        } catch (e) {
            console.warn('audit_log insert failed', e);
        }
    }

    function applyRoleNav() {
        const role = _profile?.role;
        if (!role) return;
        global.document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
            const view = btn.dataset.view;
            const allowed = (VIEW_ROLES[view] || []).includes(role);
            btn.style.display = allowed ? '' : 'none';
        });
        const badge = global.document.getElementById('userBadge');
        if (badge) {
            badge.innerHTML =
                '<span class="user-name">' +
                esc(_profile.full_name || _profile.email) +
                '</span><span class="user-role">' +
                esc(roleLabel(_profile.role)) +
                '</span>';
        }
        const delBtn = global.document.getElementById('drawerDeleteBtn');
        if (delBtn) delBtn.style.display = can('delete_candidate') ? 'inline-flex' : 'none';
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function guardView(view) {
        if (!canView(view)) {
            return 'overview';
        }
        return view;
    }

    async function boot() {
        const session = await requireAuth();
        if (!session) return false;
        const prof = await loadProfile();
        if (!prof) return false;
        applyRoleNav();
        return true;
    }

    global.TAAuth = {
        client,
        profile,
        getSession,
        loadProfile,
        requireAuth,
        signIn,
        signUp,
        inviteUser,
        signOut,
        needsBootstrap,
        canBootstrap,
        logAudit,
        applyRoleNav,
        hasRole,
        can,
        canView,
        guardView,
        roleLabel,
        boot,
        VIEW_ROLES,
    };
})(typeof window !== 'undefined' ? window : globalThis);

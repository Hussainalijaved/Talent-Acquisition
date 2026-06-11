/**
 * Talent Admin — Supabase Auth + role-based access
 * Full-access mode: all roles see all tabs (permissions tightened later).
 */
(function (global) {
    'use strict';

    const ALL_ROLES = [
        'super_admin',
        'hr_head',
        'hiring_manager_head',
        'interviewer',
        'recruiter',
        'hiring_manager',
        'viewer',
    ];

    const ROLE_LABELS = {
        super_admin: 'Super Admin',
        hr_head: 'HR Head',
        hiring_manager_head: 'Hiring Manager Head',
        interviewer: 'Interviewer',
        recruiter: 'Recruiter / HR',
        hiring_manager: 'Hiring Manager',
        viewer: 'Viewer',
    };

    /** Who can invite which roles */
    const INVITE_ROLES = {
        super_admin: ALL_ROLES,
        hr_head: ['recruiter', 'interviewer'],
        hiring_manager_head: ['hiring_manager', 'interviewer'],
    };

    const ALL_VIEWS = [
        'overview', 'candidates', 'pipeline',
        'jobs', 'jobs-create',
        'screen', 'onsite',
        'settings', 'users', 'users-invite', 'audit',
    ];

    const ALL_PERMS = [
        'delete_candidate', 'delete_job', 'save_webhooks', 'edit_jobs',
        'screen_cv', 'onsite_write', 'add_candidate_notes',
        'manage_job_assignments', 'manage_users', 'view_audit',
    ];

    // Full-access mode — every role gets every view & permission for now
    const VIEW_ROLES = Object.fromEntries(ALL_VIEWS.map((v) => [v, ALL_ROLES]));
    const PERMS = Object.fromEntries(ALL_PERMS.map((p) => [p, ALL_ROLES]));

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
        return ROLE_LABELS[role] || String(role || '').replace(/_/g, ' ');
    }

    /** Roles the current user may assign when inviting or editing users */
    function assignableRoles() {
        if (!_profile) return [];
        const list = INVITE_ROLES[_profile.role];
        if (list) return list;
        if (hasRole('super_admin')) return ALL_ROLES;
        return [];
    }

    function canAssignRole(targetRole) {
        if (hasRole('super_admin')) return true;
        return assignableRoles().includes(targetRole);
    }

    function canManageUsers() {
        return hasRole('super_admin', 'hr_head', 'hiring_manager_head');
    }

    function canEditUserRole(targetUser) {
        if (!_profile || !targetUser) return false;
        if (targetUser.id === _profile.id) return false;
        if (hasRole('super_admin')) return true;
        if (targetUser.role === 'super_admin') return false;
        if (hasRole('hr_head')) return ['recruiter', 'interviewer', 'viewer'].includes(targetUser.role);
        if (hasRole('hiring_manager_head')) return ['hiring_manager', 'interviewer'].includes(targetUser.role);
        return false;
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
            if ((view === 'users' || view === 'users-invite') && !canManageUsers()) {
                btn.style.display = 'none';
                return;
            }
            const allowed = (VIEW_ROLES[view] || []).includes(role);
            btn.style.display = allowed ? '' : 'none';
        });
        global.document.querySelectorAll('.nav-group').forEach((group) => {
            const items = group.querySelectorAll('.nav-item[data-view]');
            const anyVisible = [...items].some((el) => el.style.display !== 'none');
            group.style.display = anyVisible ? '' : 'none';
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
        if ((view === 'users' || view === 'users-invite') && !canManageUsers()) return 'overview';
        if (!canView(view)) return 'overview';
        return view;
    }

    /** Job scoping disabled in full-access mode — re-enable for hiring_manager later */
    function isJobScopedRole() {
        return false;
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
        isJobScopedRole,
        roleLabel,
        assignableRoles,
        canAssignRole,
        canManageUsers,
        canEditUserRole,
        boot,
        ALL_ROLES,
        ROLE_LABELS,
        VIEW_ROLES,
    };
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * Shared scheduling portal — Supabase state + fire-and-forget n8n webhooks.
 * Used by interviewer.html and candidate-pick.html
 */
(function (global) {
    'use strict';

    const SUPABASE_URL = 'https://vnxstyadacgntnsvcvzn.supabase.co';
    const SUPABASE_ANON_KEY =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZueHN0eWFkYWNnbnRuc3ZjdnpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjAwMjAsImV4cCI6MjA5MzYzNjAyMH0.4rJRI_f6HyQNGYLHaw2ZH6q7060ey8ftUVxzvzWEwD4';

    // Update when ngrok restarts (free tier gets a new subdomain each time).
    const N8N_WEBHOOK_BASE = 'https://randy-gaunt-bradley.ngrok-free.dev/webhook';
    const PORTAL_BASE = 'https://talent-acquisition-six.vercel.app';
    const SUCCESS_PAGE = PORTAL_BASE + '/scheduling-success.html';

    const SESSION_SELECT =
        'id,candidate_email,score,result,status,config,requisition_id,scheduling_status,proposed_slots,chosen_slot,gmail_thread_id';

    let _client = null;

    function client() {
        if (_client) return _client;
        if (!global.supabase?.createClient) {
            throw new Error('Supabase JS not loaded.');
        }
        _client = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        return _client;
    }

    function parseSessionId() {
        const params = new URLSearchParams(global.location.search);
        return String(params.get('session') || params.get('session_id') || '').trim();
    }

    function parseConfig(raw) {
        if (!raw) return {};
        if (typeof raw === 'object') return raw;
        try {
            return JSON.parse(raw);
        } catch (_) {
            return {};
        }
    }

    function nameFromEmail(email) {
        const e = String(email || '').trim().toLowerCase();
        if (!e) return 'Candidate';
        const local = e.split('@')[0] || e;
        return (
            local
                .replace(/[._-]+/g, ' ')
                .replace(/\b\w/g, (c) => c.toUpperCase())
                .trim() || e
        );
    }

    function normalizeSlots(raw) {
        if (!raw) return [];
        let slots = raw;
        if (typeof slots === 'string') {
            try {
                slots = JSON.parse(slots);
            } catch (_) {
                return [];
            }
        }
        if (!Array.isArray(slots)) return [];
        return slots
            .map((s, i) => ({
                start_iso: s.start_iso || s.start || '',
                end_iso: s.end_iso || s.end || '',
                label: s.label || s.start_iso || `Slot ${i + 1}`,
            }))
            .filter((s) => s.start_iso || s.label);
    }

    async function loadSession(sessionId) {
        const id = String(sessionId || '').trim();
        if (!id) throw new Error('Session ID missing — use the link from your email.');

        const { data, error } = await client()
            .from('assessment_sessions')
            .select(SESSION_SELECT)
            .eq('id', id)
            .maybeSingle();

        if (error) throw new Error(error.message || 'Could not load session.');
        if (!data) throw new Error('Session not found. Ask HR to send a fresh scheduling email.');

        const cfg = parseConfig(data.config);
        return {
            ...data,
            config: cfg,
            candidate_name: nameFromEmail(data.candidate_email),
            role: cfg.requisition_title || data.requisition_id || 'Open role',
            proposed_slots: normalizeSlots(data.proposed_slots),
            chosen_slot: data.chosen_slot || null,
        };
    }

    async function saveProposedSlots(sessionId, slots) {
        const now = new Date().toISOString();
        const { error } = await client()
            .from('assessment_sessions')
            .update({
                proposed_slots: slots,
                scheduling_status: 'slots_proposed',
                scheduling_updated_at: now,
                updated_at: now,
            })
            .eq('id', sessionId);

        if (error) throw new Error(error.message || 'Could not save slots.');
    }

    async function saveChosenSlot(sessionId, slot) {
        const now = new Date().toISOString();
        const { error } = await client()
            .from('assessment_sessions')
            .update({
                chosen_slot: slot,
                scheduling_status: 'confirmed',
                scheduling_updated_at: now,
                updated_at: now,
            })
            .eq('id', sessionId);

        if (error) throw new Error(error.message || 'Could not save your choice.');
    }

    async function postWebhook(path, sessionId) {
        const url = N8N_WEBHOOK_BASE.replace(/\/+$/, '') + '/' + path.replace(/^\//, '');
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': '1',
                },
                body: JSON.stringify({ session_id: sessionId }),
            });
            if (!res.ok) {
                console.warn('Scheduling webhook HTTP', res.status, path);
                return false;
            }
            return true;
        } catch (err) {
            console.warn('Scheduling webhook failed', path, err);
            return false;
        }
    }

    function notifySlotsReady(sessionId) {
        return postWebhook('talent/scheduling-slots', sessionId);
    }

    function notifyConfirmed(sessionId) {
        return postWebhook('talent/scheduling-confirmed', sessionId);
    }

    function goSuccess(role, extra) {
        const q = new URLSearchParams({ role: role || 'user', ...(extra || {}) });
        global.location.replace(SUCCESS_PAGE + '?' + q.toString());
    }

    function schedulingWaitUrl(sessionId) {
        const id = String(sessionId || '').trim();
        return id ? PORTAL_BASE + '/scheduling-wait.html?session=' + encodeURIComponent(id) : PORTAL_BASE;
    }

    function candidatePickUrl(sessionId) {
        const id = String(sessionId || '').trim();
        return id ? PORTAL_BASE + '/candidate-pick.html?session=' + encodeURIComponent(id) : PORTAL_BASE;
    }

    async function pollScheduling(sessionId) {
        const id = String(sessionId || '').trim();
        if (!id) return { status: 'none', slots: [], chosen: null };

        const { data, error } = await client()
            .from('assessment_sessions')
            .select('scheduling_status, proposed_slots, chosen_slot')
            .eq('id', id)
            .maybeSingle();

        if (error) throw new Error(error.message || 'Could not check scheduling status.');
        if (!data) return { status: 'none', slots: [], chosen: null };

        const slots = normalizeSlots(data.proposed_slots);
        const chosen = data.chosen_slot || null;
        let status = String(data.scheduling_status || 'none');

        if (chosen || status === 'confirmed') status = 'confirmed';
        else if (slots.length > 0 || status === 'slots_proposed' || status === 'candidate_invited') {
            status = 'slots_ready';
        } else if (status === 'pending_interviewer' || status === 'none') {
            status = 'waiting_interviewer';
        }

        return { status, slots, chosen, raw: data };
    }

    global.SchedulingPortal = {
        SUPABASE_URL,
        N8N_WEBHOOK_BASE,
        PORTAL_BASE,
        SUCCESS_PAGE,
        parseSessionId,
        loadSession,
        saveProposedSlots,
        saveChosenSlot,
        notifySlotsReady,
        notifyConfirmed,
        goSuccess,
        schedulingWaitUrl,
        candidatePickUrl,
        pollScheduling,
        normalizeSlots,
        nameFromEmail,
    };
})(window);

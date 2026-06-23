const DEFAULT_SUPABASE_URL = 'https://vnxstyadacgntnsvcvzn.supabase.co';

export function supabaseEnv() {
    const url = String(
        process.env.SUPABASE_URL || process.env.TA_SUPABASE_URL || DEFAULT_SUPABASE_URL
    ).replace(/\/+$/, '').trim();
    const key = String(
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_KEY ||
        ''
    ).trim();
    return { url, key };
}

export function buildHeaders(key) {
    return {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
    };
}

export function parseJsonSafe(raw, fallback) {
    if (raw == null) return fallback;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
}

export async function loadSession(sbUrl, sbKey, sessionId) {
    const res = await fetch(
        `${sbUrl}/rest/v1/assessment_sessions?id=eq.${encodeURIComponent(sessionId)}&select=id,candidate_email,proctor_report,current_phase,config`,
        { headers: buildHeaders(sbKey) }
    );
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`session_load_failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : null;
}

export function normalizeReport(raw) {
    const base = parseJsonSafe(raw, {});
    const entries = Array.isArray(base.entries) ? base.entries.slice() : [];
    return {
        entries,
        summary: typeof base.summary === 'string' ? base.summary : '',
        finalized_at: base.finalized_at || null,
        suspicious_count: Number(base.suspicious_count) || 0,
    };
}

export function appendEntry(report, entry) {
    const next = normalizeReport(report);
    next.entries.push(entry);
    if (entry.suspicious) {
        next.suspicious_count = (Number(next.suspicious_count) || 0) + 1;
    }
    return next;
}

export async function saveReport(sbUrl, sbKey, sessionId, report) {
    const res = await fetch(
        `${sbUrl}/rest/v1/assessment_sessions?id=eq.${encodeURIComponent(sessionId)}`,
        {
            method: 'PATCH',
            headers: buildHeaders(sbKey),
            body: JSON.stringify({ proctor_report: report }),
        }
    );
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`proctor_report_save_failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
}

export async function appendProctorEntry(sbUrl, sbKey, sessionId, {
    phase = null,
    category = 'activity',
    summary = '',
    suspicious = false,
    meta = null,
}) {
    const session = await loadSession(sbUrl, sbKey, sessionId);
    if (!session?.id) {
        throw new Error('session_not_found');
    }
    const cleanSummary = String(summary || '').trim();
    if (!cleanSummary) {
        throw new Error('summary_required');
    }
    const entry = {
        at: new Date().toISOString(),
        phase: phase != null ? Number(phase) : null,
        category: String(category || 'activity').slice(0, 64),
        summary: cleanSummary.slice(0, 1200),
        suspicious: !!suspicious,
    };
    if (meta && typeof meta === 'object') entry.meta = meta;
    const report = appendEntry(session.proctor_report, entry);
    await saveReport(sbUrl, sbKey, sessionId, report);
    return { entry, report };
}

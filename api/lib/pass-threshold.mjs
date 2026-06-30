const DEFAULT_PASS_THRESHOLDS = { junior: 55, mid: 60, senior: 70 };
const DEFAULT_PASS_FALLBACK = 60;
const PASS_THRESHOLDS_CONFIG_KEY = 'default_pass_score_thresholds';
const DEFAULT_PASS_CONFIG_KEY = 'default_pass_score_threshold';

export function detectSeniority(title) {
    const t = String(title || '').toLowerCase();
    if (/\b(intern|trainee|graduate|entry[\s-]?level)\b/.test(t)) return 'intern';
    if (/\b(junior|jr\.?)\b/.test(t)) return 'junior';
    if (/\b(senior|sr\.?|lead|principal|staff|architect|head)\b/.test(t)) return 'senior';
    return 'mid';
}

export function seniorityPassKey(seniority) {
    const s = String(seniority || '').toLowerCase();
    if (s === 'intern' || s === 'junior') return 'junior';
    if (s === 'senior') return 'senior';
    return 'mid';
}

export function parseScoreThreshold(raw, fallback = DEFAULT_PASS_FALLBACK) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(100, Math.max(0, Math.round(n)));
}

export function normalizePassThresholds(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        junior: parseScoreThreshold(src.junior ?? src.intern, DEFAULT_PASS_THRESHOLDS.junior),
        mid: parseScoreThreshold(src.mid, DEFAULT_PASS_THRESHOLDS.mid),
        senior: parseScoreThreshold(src.senior, DEFAULT_PASS_THRESHOLDS.senior),
    };
}

export function resolvePassThresholdForTitle(title, thresholds) {
    const t = normalizePassThresholds(thresholds || DEFAULT_PASS_THRESHOLDS);
    const key = seniorityPassKey(detectSeniority(title));
    return parseScoreThreshold(t[key], DEFAULT_PASS_FALLBACK);
}

export async function loadPassThresholdsFromSupabase(sbUrl, sbKey) {
    const base = String(sbUrl || '').replace(/\/+$/, '');
    const key = String(sbKey || '').trim();
    if (!base || !key) return { ...DEFAULT_PASS_THRESHOLDS };

    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    async function fetchValue(configKey) {
        const url =
            `${base}/rest/v1/app_config?key=eq.${encodeURIComponent(configKey)}&select=value&limit=1`;
        const res = await fetch(url, { headers });
        if (!res.ok) return null;
        const rows = await res.json();
        return Array.isArray(rows) && rows[0]?.value != null ? rows[0].value : null;
    }

    try {
        const tierRaw = await fetchValue(PASS_THRESHOLDS_CONFIG_KEY);
        if (tierRaw) {
            return normalizePassThresholds(JSON.parse(tierRaw));
        }
    } catch (_) {
        /* legacy fallback */
    }

    const legacy = await fetchValue(DEFAULT_PASS_CONFIG_KEY);
    const single = parseScoreThreshold(legacy, DEFAULT_PASS_FALLBACK);
    return { junior: single, mid: single, senior: single };
}

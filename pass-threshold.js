/**
 * Global assessment pass thresholds (Settings) — resolved by job title seniority.
 * CV shortlist threshold stays per-job only.
 */
(function (global) {
    'use strict';

    const DEFAULT_PASS_THRESHOLDS = { junior: 55, mid: 60, senior: 70 };
    const DEFAULT_PASS_FALLBACK = 60;
    const PASS_THRESHOLDS_CONFIG_KEY = 'default_pass_score_thresholds';
    const DEFAULT_PASS_CONFIG_KEY = 'default_pass_score_threshold';

    let cachedThresholds = { ...DEFAULT_PASS_THRESHOLDS };

    function detectSeniority(title) {
        const t = String(title || '').toLowerCase();
        if (/\b(intern|trainee|graduate|entry[\s-]?level)\b/.test(t)) return 'intern';
        if (/\b(junior|jr\.?)\b/.test(t)) return 'junior';
        if (/\b(senior|sr\.?|lead|principal|staff|architect|head)\b/.test(t)) return 'senior';
        return 'mid';
    }

    function seniorityPassKey(seniority) {
        const s = String(seniority || '').toLowerCase();
        if (s === 'intern' || s === 'junior') return 'junior';
        if (s === 'senior') return 'senior';
        return 'mid';
    }

    function parseScoreThreshold(raw, fallback) {
        const n = Number(raw);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(100, Math.max(0, Math.round(n)));
    }

    function normalizePassThresholds(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        return {
            junior: parseScoreThreshold(src.junior ?? src.intern, DEFAULT_PASS_THRESHOLDS.junior),
            mid: parseScoreThreshold(src.mid, DEFAULT_PASS_THRESHOLDS.mid),
            senior: parseScoreThreshold(src.senior, DEFAULT_PASS_THRESHOLDS.senior),
        };
    }

    function resolvePassThresholdForTitle(title, thresholds) {
        const t = normalizePassThresholds(thresholds || cachedThresholds);
        const key = seniorityPassKey(detectSeniority(title));
        return parseScoreThreshold(t[key], DEFAULT_PASS_FALLBACK);
    }

    function setCachedThresholds(thresholds) {
        cachedThresholds = normalizePassThresholds(thresholds);
        return cachedThresholds;
    }

    function getCachedThresholds() {
        return { ...cachedThresholds };
    }

    async function loadFromSupabase(sb) {
        if (!sb) return getCachedThresholds();
        let loaded = null;
        try {
            const { data: tierRow } = await sb
                .from('app_config')
                .select('value')
                .eq('key', PASS_THRESHOLDS_CONFIG_KEY)
                .maybeSingle();
            if (tierRow?.value) {
                loaded = normalizePassThresholds(JSON.parse(tierRow.value));
            }
        } catch (_) {
            loaded = null;
        }
        if (!loaded) {
            try {
                const { data: legacyRow } = await sb
                    .from('app_config')
                    .select('value')
                    .eq('key', DEFAULT_PASS_CONFIG_KEY)
                    .maybeSingle();
                const single = parseScoreThreshold(legacyRow?.value, DEFAULT_PASS_FALLBACK);
                loaded = { junior: single, mid: single, senior: single };
            } catch (_) {
                loaded = { ...DEFAULT_PASS_THRESHOLDS };
            }
        }
        return setCachedThresholds(loaded);
    }

    global.TAPassThreshold = {
        DEFAULT_PASS_THRESHOLDS,
        DEFAULT_PASS_FALLBACK,
        PASS_THRESHOLDS_CONFIG_KEY,
        DEFAULT_PASS_CONFIG_KEY,
        detectSeniority,
        seniorityPassKey,
        parseScoreThreshold,
        normalizePassThresholds,
        resolvePassThresholdForTitle,
        setCachedThresholds,
        getCachedThresholds,
        loadFromSupabase,
    };
})(typeof window !== 'undefined' ? window : globalThis);

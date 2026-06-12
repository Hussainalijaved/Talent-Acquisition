/**
 * Apply page hiring post templates (admin picks per job).
 */
(function (global) {
    'use strict';

    const DEFAULT = 'hiring-top';

    const OPTIONS = [
        {
            id: 'hiring-top',
            label: 'Hiring banner top',
            hint: 'Light blue — "We\'re hiring" and Apply now at the top, then job details',
        },
        {
            id: 'hiring-bottom',
            label: 'Apply at bottom',
            hint: 'Light lavender — job details first, hiring CTA and Apply now at the bottom',
        },
        {
            id: 'hiring-card',
            label: 'LinkedIn-style card',
            hint: 'Warm cream card — hiring header with Apply now, content below',
        },
    ];

    const LEGACY_MAP = {
        classic: 'hiring-top',
        executive: 'hiring-card',
        modern: 'hiring-top',
        minimal: 'hiring-bottom',
        bold: 'hiring-card',
        fresh: 'hiring-bottom',
    };

    function isValid(id) {
        return OPTIONS.some((o) => o.id === id);
    }

    function normalize(id) {
        const key = String(id || '').trim();
        if (isValid(key)) return key;
        if (LEGACY_MAP[key]) return LEGACY_MAP[key];
        return DEFAULT;
    }

    function buildSelectOptions(selected) {
        const sel = normalize(selected);
        return OPTIONS.map((o) =>
            '<option value="' + o.id + '"' + (o.id === sel ? ' selected' : '') + '>' + o.label + '</option>'
        ).join('');
    }

    global.TAJobStyles = {
        DEFAULT,
        OPTIONS,
        isValid,
        normalize,
        buildSelectOptions,
        ids: () => OPTIONS.map((o) => o.id),
    };
})(typeof window !== 'undefined' ? window : globalThis);

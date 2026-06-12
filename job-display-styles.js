/**
 * Shared job display styles for apply page + admin job form.
 */
(function (global) {
    'use strict';

    const DEFAULT = 'classic';

    const OPTIONS = [
        { id: 'classic', label: 'Classic — CONVO blue', hint: 'White panel, brand blue accents (default)' },
        { id: 'executive', label: 'Executive — dark & gold', hint: 'Premium dark panel with gold highlights' },
        { id: 'modern', label: 'Modern — gradient', hint: 'Soft blue gradient, rounded cards' },
        { id: 'minimal', label: 'Minimal — clean', hint: 'Light, airy layout with subtle borders' },
        { id: 'bold', label: 'Bold — high contrast', hint: 'Dark panel, large type, vivid accent' },
        { id: 'fresh', label: 'Fresh — teal', hint: 'Mint/teal tones, friendly feel' },
    ];

    function isValid(id) {
        return OPTIONS.some((o) => o.id === id);
    }

    function normalize(id) {
        return isValid(id) ? id : DEFAULT;
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

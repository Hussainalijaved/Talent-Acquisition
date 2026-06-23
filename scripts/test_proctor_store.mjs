/**
 * Unit tests for proctor report store helpers.
 */
import {
    appendEntry,
    normalizeReport,
} from '../api/lib/proctor-store.mjs';

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

let passed = 0;
function ok(name, fn) {
    try {
        fn();
        passed += 1;
        console.log('  ok   -', name);
    } catch (err) {
        console.error('  FAIL -', name, err.message);
        process.exitCode = 1;
    }
}

console.log('=== proctor-store ===');

ok('normalizeReport empty', () => {
    const r = normalizeReport(null);
    assert(Array.isArray(r.entries) && r.entries.length === 0, 'entries');
    assert(r.summary === '', 'summary');
});

ok('appendEntry adds suspicious count', () => {
    const r = appendEntry(null, {
        at: '2026-01-01T00:00:00Z',
        category: 'snipping_tool',
        summary: 'Blocked snip',
        suspicious: true,
    });
    assert(r.entries.length === 1, 'one entry');
    assert(r.suspicious_count === 1, 'count');
});

ok('appendEntry preserves prior entries', () => {
    const base = { entries: [{ summary: 'a', suspicious: false }], suspicious_count: 0 };
    const r = appendEntry(base, { summary: 'b', suspicious: false });
    assert(r.entries.length === 2, 'two entries');
});

console.log(passed ? `\nALL PASS (${passed})` : '\nFAILED');

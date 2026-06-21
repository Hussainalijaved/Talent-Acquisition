/**
 * Repair an assessment session where live speech finished but DB was not finalized.
 * Usage: node scripts/repair_session_finalize.mjs <session_id> [portal_base_url]
 */
const sessionId = process.argv[2];
const portalBase = (process.argv[3] || 'https://talent-acquisition-six.vercel.app').replace(/\/+$/, '');

if (!sessionId) {
    console.error('Usage: node scripts/repair_session_finalize.mjs <session_id> [portal_base_url]');
    process.exit(1);
}

const res = await fetch(`${portalBase}/api/live-speech-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        partial: false,
        finalize_only: true,
        session_id: sessionId,
        max_questions: 5,
    }),
});

const text = await res.text();
let json = {};
try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }

console.log('HTTP', res.status);
console.log(JSON.stringify(json, null, 2));
process.exit(res.ok ? 0 : 1);

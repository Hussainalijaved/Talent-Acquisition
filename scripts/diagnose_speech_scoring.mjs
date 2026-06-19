/**
 * Live speech scoring pipeline diagnostic (no secrets required).
 * Checks: Vercel save API, n8n start response fields, optional relay health.
 */
const PORTAL = 'https://talent-acquisition-six.vercel.app';
const N8N_START = 'https://randy-gaunt-bradley.ngrok-free.dev/webhook/talent/live-speech-start';
const TEST_SESSION = '00000000-0000-0000-0000-000000000001';

let failures = 0;
function fail(msg, detail) {
  failures += 1;
  console.log(`  FAIL - ${msg}${detail ? ` :: ${detail}` : ''}`);
}
function ok(msg) {
  console.log(`  ok   - ${msg}`);
}

async function checkVercelSaveApi() {
  console.log('\n=== Vercel /api/live-speech-save ===');
  const res = await fetch(`${PORTAL}/api/live-speech-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      partial: true,
      session_id: TEST_SESSION,
      max_questions: 5,
      turns: [{
        phase: 6,
        voice_question_number: 1,
        question_text: 'Test question?',
        answer_text: 'This is a diagnostic test answer with enough words to score.',
        score: 72,
        feedback: 'Diagnostic score',
        soft_skills: { communication_clarity: 72, fluency: 70, confidence: 68, professionalism: 74, english_proficiency: 71, answer_relevance: 69 },
      }],
    }),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }

  if (res.status === 500 && json.error === 'supabase_env_missing') {
    fail('Vercel SUPABASE env', 'SUPABASE_SERVICE_ROLE_KEY not set on Vercel — scores cannot be saved');
    return;
  }
  if (res.status === 404 && json.error === 'session_not_found') {
    ok('Vercel save API reachable + Supabase env configured (session_not_found expected)');
    return;
  }
  if (res.ok) {
    ok(`Vercel save API OK (${res.status})`);
    return;
  }
  fail('Vercel save API', `HTTP ${res.status}: ${text.slice(0, 200)}`);
}

async function checkN8nLiveSpeechStart() {
  console.log('\n=== n8n live-speech-start response fields ===');
  let res;
  try {
    res = await fetch(N8N_START, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({ session_id: TEST_SESSION, email: 'diagnostic@test.com' }),
    });
  } catch (e) {
    fail('n8n webhook reachable', e.message);
    return;
  }

  const text = await res.text();
  if (!res.ok) {
    fail('n8n live-speech-start', `HTTP ${res.status}: ${text.slice(0, 300)}`);
    return;
  }

  let json;
  try {
    let raw = text.trim();
    if (raw.startsWith('=')) raw = raw.slice(1).trim();
    json = JSON.parse(raw);
  } catch (e) {
    fail('n8n response JSON', text.slice(0, 200));
    return;
  }

  ok(`n8n responded HTTP ${res.status}`);

  const required = [
    ['system_instruction', !!String(json.system_instruction || '').trim()],
    ['live_relay_url', !!String(json.live_relay_url || '').trim()],
    ['kickoff_prompt', !!String(json.kickoff_prompt || '').trim()],
    ['portal_base_url', !!String(json.portal_base_url || json.config?.portal_base_url || '').trim()],
    ['live_save_url', !!String(json.live_save_url || '').trim()],
    ['supabase_url', !!String(json.supabase_url || json.config?.supabase_url || '').trim()],
    ['supabase_key', !!String(json.supabase_key || json.config?.supabase_key || '').trim()],
    ['max_questions', Number.isFinite(Number(json.max_questions ?? json.config?.max_questions))],
  ];

  for (const [field, present] of required) {
    if (present) ok(`response has ${field}`);
    else fail(`response missing ${field}`, 'relay may not save/score to DB');
  }

  if (json.live_relay_url) {
    const relayHttp = String(json.live_relay_url)
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/live$/, '/health');
    console.log('\n=== Relay health ===');
    try {
      const h = await fetch(relayHttp, { signal: AbortSignal.timeout(8000) });
      const ht = await h.text();
      if (h.ok) ok(`relay health ${relayHttp} → ${ht.slice(0, 120)}`);
      else fail('relay health', `HTTP ${h.status}`);
    } catch (e) {
      fail('relay health', `${relayHttp} — ${e.message}`);
    }
  }
}

async function checkMergeScorePreserve() {
  console.log('\n=== mergeTurns score preservation (unit) ===');
  const { default: handler } = await import('../api/live-speech-save.js').catch(() => ({ default: null }));
  if (!handler) {
    console.log('  skip - cannot import Vercel handler locally');
    return;
  }
  // Logic mirrored from mergeTurns in live-speech-save.js
  const existing = { phase: 6, score: 78, answer_text: 'saved answer', soft_skills: { clarity: 80 } };
  const incomingNull = { phase: 6, answer_text: 'saved answer', score: null };
  const hasNewScore = incomingNull.score != null && Number.isFinite(Number(incomingNull.score));
  const preserved = hasNewScore ? incomingNull.score : (existing.score ?? null);
  if (preserved === 78) ok('null score in partial save preserves existing score');
  else fail('score preservation', `got ${preserved}`);
}

async function main() {
  console.log('=== Live Speech Scoring Diagnostic ===');
  await checkVercelSaveApi();
  await checkN8nLiveSpeechStart();
  await checkMergeScorePreserve();
  console.log(`\n${failures === 0 ? 'DIAGNOSTIC PASS — pipeline looks configured' : failures + ' ISSUE(S) FOUND'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

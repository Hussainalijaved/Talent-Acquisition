// Integration test for the live-speech parse node: verifies a partial (per-turn)
// save produces a valid Supabase PATCH body that persists the voice transcript + score.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function runParse({ fetchSession, nodes }) {
  const src = fs.readFileSync(path.join(root, 'n8n_code_parse_live_speech_result.js'), 'utf8');
  const $input = { first: () => ({ json: fetchSession }) };
  const $ = (name) => ({ first: () => ({ json: nodes[name] ?? {} }) });
  const fn = new Function('$input', '$', src);
  return fn($input, $);
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}`);
  else { failures += 1; console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`); }
}

const cfg = {
  supabase_url: 'https://example.supabase.co',
  supabase_key: 'key',
  max_questions: 5,
  speech_phases: 5,
  table_assessment_sessions: 'assessment_sessions',
};

const session = {
  id: 'sess-1',
  candidate_email: 'cand@example.com',
  technical_score: 86,
  config: cfg,
  interview_history: [
    { phase: 6, mode: 'speech', question_text: 'Tell me about a conflict you resolved.', answer_text: null, score: null },
  ],
};

console.log('=== live-speech partial save (voice turn 1) ===');
const partialTurn = {
  phase: 6,
  voice_question_number: 1,
  question_text: 'Tell me about a conflict you resolved.',
  answer_text: 'I once disagreed with a teammate on an API design and resolved it by walking through trade-offs together.',
  score: 78,
  clarity: 80, confidence: 75, professionalism: 82, relevance: 76,
  feedback: 'Clear, structured answer.',
  received_at: new Date().toISOString(),
};

const out = runParse({
  fetchSession: session,
  nodes: {
    'CODE - Normalize Live Speech Complete': {
      session_id: 'sess-1',
      candidate_email: 'cand@example.com',
      partial: true,
      turns: [partialTurn],
      config: cfg,
    },
    'CFG - Live Speech Config (complete)': cfg,
  },
});

const j = out[0].json;
const body = j._session_patch_body;
const row6 = body.interview_history.find((h) => Number(h.phase) === 6);
check('partial flagged', j.partial === true, JSON.stringify({ partial: j.partial }));
check('not final', j.isFinal === false);
check('PATCH url valid', /^https:\/\/example\.supabase\.co\/rest\/v1\/assessment_sessions\?id=eq\.sess-1$/.test(j._session_patch_url), j._session_patch_url);
check('phase 6 transcript saved', row6?.answer_text?.includes('API design'), row6?.answer_text);
check('phase 6 score saved', row6?.score === 78, String(row6?.score));
check('phase 6 soft_skills saved', row6?.soft_skills?.clarity === 80, JSON.stringify(row6?.soft_skills));
check('stage live_speech', body.assessment_stage === 'live_speech', body.assessment_stage);
check('current_phase 6', body.current_phase === 6, String(body.current_phase));
check('not completed yet', body.status !== 'completed', body.status);

console.log('\n=== live-speech missing supabase_url throws clearly ===');
let threw = false;
try {
  runParse({
    fetchSession: { ...session, config: { ...cfg, supabase_url: '' } },
    nodes: {
      'CODE - Normalize Live Speech Complete': {
        session_id: 'sess-1', candidate_email: 'cand@example.com', partial: true, turns: [partialTurn],
        config: { ...cfg, supabase_url: '' },
      },
      'CFG - Live Speech Config (complete)': { ...cfg, supabase_url: '' },
    },
  });
} catch (e) {
  threw = /supabase_url/.test(e.message);
}
check('throws on missing supabase_url', threw);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

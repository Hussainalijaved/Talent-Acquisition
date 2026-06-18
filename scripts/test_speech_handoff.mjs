// Integration test: runs the full assessment parse nodes with mocked n8n globals
// to verify the final technical phase hands off to the speech round.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function runParseNode(file, { llmJson, nodes }) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const $input = { first: () => ({ json: llmJson }) };
  const $ = (name) => ({
    first: () => ({ json: nodes[name] ?? {} }),
  });
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
  speech_enabled: true,
  pass_score_threshold: 60,
  requisition_title: 'Associate .NET Developer',
  requisition_requirements: 'C#, ASP.NET Core, SQL',
};

function sessionWithHistory() {
  const history = [];
  for (let p = 1; p <= 5; p++) {
    history.push({
      phase: p,
      question_text: `Technical question ${p}?`,
      answer_text: p === 5 ? null : `Answer ${p} with EF Core and Dapper trade-offs.`,
      score: p === 5 ? null : 70,
      sent_at: new Date().toISOString(),
    });
  }
  return { id: 'sess-1', interview_history: history, config: cfg };
}

for (const file of ['n8n_code_parse_assessment_result.js', 'n8n_code_parse_technical_result.js']) {
  console.log(`\n=== ${file} (final phase → speech handoff) ===`);
  const session = sessionWithHistory();
  const norm = {
    session_id: 'sess-1',
    current_phase: 5,
    answer: 'EF Core is a full ORM; Dapper is a micro-ORM for raw SQL. Choose by perf vs productivity.',
    candidate_email: 'cand@example.com',
    config: cfg,
  };
  const built = { session, norm, current_question_text: 'Technical question 5?' };

  const out = runParseNode(file, {
    llmJson: { choices: [{ message: { content: JSON.stringify({
      status: 'finished', result: 'FAIL', score: 35,
      feedback: 'Weak overall.', suggested_answer: 'x', next_question: '',
      first_speech_question: 'Tell me about a time you resolved a conflict.',
    }) } }] },
    nodes: {
      'CODE - Build LLM context': built,
      'CODE - Normalize Data': norm,
      'CFG - Assessment Config': cfg,
      'HTTP - Fetch Session': session,
    },
  });

  const json = out[0].json;
  const body = json._session_patch_body;
  const speechRow = body.interview_history.find((h) => Number(h.phase) === 6);

  check('startSpeech is true even on technical FAIL', json.startSpeech === true, `startSpeech=${json.startSpeech}`);
  check('isFinal is false (speech still to run)', json.isFinal === false, `isFinal=${json.isFinal}`);
  check('assessment_stage set to speech', body.assessment_stage === 'speech', body.assessment_stage);
  check('phase 6 speech row created', !!speechRow, JSON.stringify(speechRow));
  check('phase 6 mode is speech', speechRow?.mode === 'speech', speechRow?.mode);
  check('phase 6 has question text', !!String(speechRow?.question_text || '').trim());
  check('current_phase advanced to 6', body.current_phase === 6, `current_phase=${body.current_phase}`);
  check('nextQuestion is the speech opener', /conflict|stakeholder|pressure|interested|mistake|setback/i.test(json.nextQuestion || ''), json.nextQuestion);
}

// Text-only (speech disabled) must still finalize, not start speech.
console.log('\n=== speech disabled → finalize ===');
const cfgNoSpeech = { ...cfg, speech_phases: 0, speech_enabled: false };
const session2 = sessionWithHistory();
session2.config = cfgNoSpeech;
const norm2 = {
  session_id: 'sess-1',
  current_phase: 5,
  answer: 'Solid final answer about OAuth flows.',
  candidate_email: 'cand@example.com',
  config: cfgNoSpeech,
};
const out2 = runParseNode('n8n_code_parse_assessment_result.js', {
  llmJson: { choices: [{ message: { content: JSON.stringify({
    status: 'finished', result: 'PASS', score: 80, feedback: 'Good.', suggested_answer: 'x', next_question: '',
  }) } }] },
  nodes: {
    'CODE - Build LLM context': { session: session2, norm: norm2, current_question_text: 'Technical question 5?' },
    'CODE - Normalize Data': norm2,
    'CFG - Assessment Config': cfgNoSpeech,
    'HTTP - Fetch Session': session2,
  },
});
const j2 = out2[0].json;
check('no-speech: startSpeech false', j2.startSpeech === false, `startSpeech=${j2.startSpeech}`);
check('no-speech: isFinal true', j2.isFinal === true, `isFinal=${j2.isFinal}`);
check('no-speech: stage completed', j2._session_patch_body.assessment_stage === 'completed', j2._session_patch_body.assessment_stage);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

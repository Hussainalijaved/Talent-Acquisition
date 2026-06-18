// Regression test for robust LLM output parsing in the assessment parse nodes.
// Extracts the pure helper functions (everything before extractJdThemes) from the
// real n8n code files and exercises parseLlmContent against malformed model output.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadParser(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const marker = 'function extractJdThemes';
  const idx = src.indexOf(marker);
  if (idx < 0) throw new Error(`marker not found in ${file}`);
  const helpers = src.slice(0, idx);
  const factory = new Function(`${helpers}\nreturn { parseLlmContent, extractLlmText };`);
  return factory();
}

function groqEnvelope(content) {
  return { choices: [{ message: { content } }] };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   - ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

for (const file of ['n8n_code_parse_assessment_result.js', 'n8n_code_parse_technical_result.js']) {
  console.log(`\n=== ${file} ===`);
  const { parseLlmContent } = loadParser(file);

  // 1) Clean valid JSON
  let c = parseLlmContent(groqEnvelope(JSON.stringify({
    score: 88, feedback: 'Great', suggested_answer: 'x', next_question: 'Q2?', time_limit_seconds: 180, complexity_tier: 'B',
  })));
  check('valid json keeps score', c.score === 88, `score=${c.score}`);
  check('valid json keeps next_question', (c.next_question || c.nextQuestion) === 'Q2?');

  // 2) Truncated JSON (cut mid suggested_answer) — score+feedback must survive
  const truncated = '{"score":90,"feedback":"Strong, accurate comparison of EF Core vs Dapper.","suggested_answer":"EF Core is a full ORM with change tracking while Dapper is a micro-ORM that maps raw S';
  c = parseLlmContent(groqEnvelope(truncated));
  check('truncated json recovers score', c.score === 90, `score=${c.score}`);
  check('truncated json recovers feedback', /Strong, accurate/.test(c.feedback || ''), c.feedback);
  check('truncated json not flagged failed', c._scoring_failed !== true);

  // 3) Markdown-fenced JSON
  c = parseLlmContent(groqEnvelope('```json\n{"score":70,"feedback":"ok","next_question":"Why REST?"}\n```'));
  check('fenced json parses score', c.score === 70, `score=${c.score}`);

  // 4) Prose preamble before JSON
  c = parseLlmContent(groqEnvelope('Here is my evaluation:\n{"score":65,"feedback":"decent","next_question":"What is DI?"}'));
  check('preamble json parses score', c.score === 65, `score=${c.score}`);

  // 5) Trailing comma + prose after
  c = parseLlmContent(groqEnvelope('{"score":55,"feedback":"fine","next_question":"Idempotency?",}\nThanks.'));
  check('trailing comma json parses score', c.score === 55, `score=${c.score}`);

  // 6) Truncated mid next_question but score+feedback present
  const truncMid = '{"score":42,"feedback":"Partial answer.","suggested_answer":"...","next_question":"An API returns 500 under lo';
  c = parseLlmContent(groqEnvelope(truncMid));
  check('truncated mid-question recovers score', c.score === 42, `score=${c.score}`);

  // 7) Total garbage — must NOT score zero, must flag failure
  c = parseLlmContent(groqEnvelope('I cannot help with that request.'));
  check('garbage yields null score (not 0)', c.score == null, `score=${c.score}`);
  check('garbage flags _scoring_failed', c._scoring_failed === true);

  // 8) Empty output
  c = parseLlmContent(groqEnvelope(''));
  check('empty yields null score', c.score == null, `score=${c.score}`);
  check('empty flags _scoring_failed', c._scoring_failed === true);

  // 9) Final-phase with first_speech_question, truncated after it
  const finalTrunc = '{"status":"finished","result":"PASS","score":80,"feedback":"Solid overall.","suggested_answer":"...","next_question":"","first_speech_question":"Tell me about a time you handled conflic';
  c = parseLlmContent(groqEnvelope(finalTrunc));
  check('final truncated recovers score', c.score === 80, `score=${c.score}`);
  check('final truncated recovers result', String(c.result || '').toUpperCase() === 'PASS', c.result);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

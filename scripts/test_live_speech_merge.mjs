// Verifies live-speech-save merge preserves existing question/answer when incoming turn is partial.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'live-speech-save.js'), 'utf8');

// Extract mergeTurns by eval in isolated scope (not exported from module).
const mergeTurns = new Function(`${src.match(/function mergeTurns[\s\S]*?^}/m)[0]}; return mergeTurns;`)();

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}`);
  else { failures += 1; console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`); }
}

const history = [
  {
    phase: 6,
    mode: 'speech',
    question_text: 'How do you handle communication under pressure?',
    answer_text: null,
    score: null,
  },
];

console.log('=== mergeTurns preserves handoff question when relay sends empty question_text ===');
const merged1 = mergeTurns(history, [{
  phase: 6,
  voice_question_number: 1,
  question_text: '',
  answer_text: 'I stay calm and communicate clearly with my team.',
  score: 72,
  soft_skills: { clarity: 70, confidence: 75, professionalism: 72, relevance: 71 },
}], 5);
const row6 = merged1.find((h) => Number(h.phase) === 6);
check('question preserved', row6?.question_text?.includes('communication under pressure'), row6?.question_text);
check('answer saved', row6?.answer_text?.includes('communicate clearly'), row6?.answer_text);
check('score saved', row6?.score === 72, String(row6?.score));
check('mode live_speech', row6?.mode === 'live_speech', row6?.mode);

console.log('\n=== mergeTurns preserves existing answer when re-score sends null score ===');
const merged2 = mergeTurns(merged1, [{
  phase: 6,
  question_text: '',
  answer_text: '',
  score: null,
}], 5);
const row6b = merged2.find((h) => Number(h.phase) === 6);
check('answer still present', row6b?.answer_text?.includes('communicate clearly'), row6b?.answer_text);
check('score preserved', row6b?.score === 72, String(row6b?.score));

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

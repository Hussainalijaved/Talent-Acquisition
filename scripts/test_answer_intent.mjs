import { classifyAnswerIntent, isRepeatRequest } from '../relay/lib/answer-intent.mjs';

let failures = 0;
const ok = (l) => console.log(`  ok   - ${l}`);
const fail = (l, d = '') => { failures += 1; console.log(`  FAIL - ${l}${d ? ` :: ${d}` : ''}`); };

console.log('=== answer intent classification ===\n');

if (isRepeatRequest('Can you repeat the question please?')) ok('repeat — English phrase');
else fail('repeat — English phrase');

if (isRepeatRequest('question repeat karo')) ok('repeat — Urdu/English mix');
else fail('repeat — Urdu/English mix');

if (!isRepeatRequest("I don't know the answer to that")) ok('"I don\'t know" is not a repeat');
else fail('"I don\'t know" is not a repeat');

if (classifyAnswerIntent("I don't know", { hasVoice: true }) === 'answer') ok('I don\'t know counts as answer');
else fail('I don\'t know counts as answer', classifyAnswerIntent("I don't know", { hasVoice: true }));

if (classifyAnswerIntent('', { hasVoice: false }) === 'no_speech') ok('no voice → no_speech');
else fail('no voice → no_speech');

if (classifyAnswerIntent('میرا جواب یہ ہے', { hasVoice: true }) === 'non_english') ok('Urdu script → non_english');
else fail('Urdu script → non_english');

if (classifyAnswerIntent('Could you say that again?', { hasVoice: true }) === 'repeat_request') {
  ok('repeat wins over hasVoice');
} else fail('repeat wins over hasVoice');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

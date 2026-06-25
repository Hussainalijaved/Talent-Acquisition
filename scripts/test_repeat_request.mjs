import { isRepeatRequest, mightBeRepeatRequest } from '../relay/lib/repeat-request.mjs';

let failures = 0;
const ok = (l) => console.log(`  ok   - ${l}`);
const fail = (l, d = '') => { failures += 1; console.log(`  FAIL - ${l}${d ? ` :: ${d}` : ''}`); };

console.log('=== repeat request detection ===\n');

if (isRepeatRequest('Can you repeat the question please?')) ok('repeat — English phrase');
else fail('repeat — English phrase');

if (isRepeatRequest('question repeat karo')) ok('repeat — Urdu/English mix');
else fail('repeat — Urdu/English mix');

if (!isRepeatRequest("I don't know the answer to that")) ok('"I don\'t know" is not a repeat');
else fail('"I don\'t know" is not a repeat');

if (mightBeRepeatRequest('can you repeat')) ok('partial repeat phrase detected');
else fail('partial repeat phrase detected');

if (!mightBeRepeatRequest('I worked on a large dotnet project with my team last year')) {
  ok('long answer is not partial repeat');
} else fail('long answer is not partial repeat');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

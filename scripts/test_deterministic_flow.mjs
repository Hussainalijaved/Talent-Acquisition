/**
 * Relay-level test for the DETERMINISTIC question driver.
 *
 * Proves the relay drives Q1..Q5 entirely on its own:
 *  - speakQuestion(n) commits the question text + emits question/awaiting events
 *  - progression to the next question happens on the candidate's answer, NOT on
 *    any Gemini "next question" signal (the root cause of the old "stuck at Q2")
 *  - the answer window opens deterministically (turnComplete OR safety timeout)
 */
import assert from 'assert';
import { GeminiLiveBridge } from '../relay/lib/gemini-live.mjs';

function makeBridge() {
  const events = [];
  const bridge = new GeminiLiveBridge({
    apiKey: '',
    context: { speech_phases: 5, max_questions: 5, requisition_title: 'Support Engineer', voice_only: true },
    onEvent: (e) => events.push(e),
    onTurnSaved: () => Promise.resolve(),
  });
  // Stub the Gemini socket so sendSpokenPrompt/sendClientText are no-ops that succeed.
  bridge.ready = true;
  bridge.closed = false;
  const sent = [];
  bridge.geminiWs = { readyState: 1, send: (s) => sent.push(s) };
  // Don't fire background AI timer refinement / question generation in a unit test.
  bridge.refineQuestionTimeLimit = () => {};
  bridge.generateQuestionBank = () => Promise.resolve();
  return { bridge, events, sent };
}

function lastOf(events, type, number) {
  return events.filter((e) => e.type === type && (number === undefined || e.number === number));
}

console.log('=== deterministic Q1..Q5 driver ===\n');
let failures = 0;
const ok = (l) => console.log(`  ok   - ${l}`);
const fail = (l, d = '') => { failures += 1; console.log(`  FAIL - ${l}${d ? ` :: ${d}` : ''}`); };

{
  const { bridge, events } = makeBridge();

  // Simulate the intro hand-off the relay performs: warmup done -> drive Q1.
  bridge.warmupPhase = null;
  bridge.speakQuestion(1);

  // Q1 question is committed immediately; mic does NOT open until audio finishes.
  if (lastOf(events, 'question', 1).length === 1) ok('Q1 question committed by relay'); else fail('Q1 question committed by relay');
  if (lastOf(events, 'next_question_ready', 1).length === 1) ok('Q1 next_question_ready'); else fail('Q1 next_question_ready');
  if (lastOf(events, 'awaiting_answer', 1).length === 0) ok('Q1 mic stays closed during question audio'); else fail('Q1 mic stays closed during question audio');
  if (bridge.questions[0] && bridge.questions[0].length > 8) ok('Q1 text non-empty'); else fail('Q1 text non-empty', bridge.questions[0]);

  // Walk all five questions: TTS finishes -> awaiting_answer -> candidate answers -> next.
  for (let q = 1; q <= 5; q += 1) {
    assert.strictEqual(bridge.ttsOnlyTurn, true, `Q${q} should be a TTS-only turn`);
    assert.strictEqual(bridge.ttsForQ, q, `ttsForQ should be ${q}`);

    // Gemini finished speaking the question text.
    bridge.onModelTurnComplete();
    if (lastOf(events, 'awaiting_answer', q).length === 1) ok(`Q${q} answer window opened on TTS completion`);
    else fail(`Q${q} answer window opened on TTS completion`, JSON.stringify(lastOf(events, 'awaiting_answer', q)));

    // Candidate answered -> relay advances deterministically (no Gemini signal).
    bridge.proceedAfterAnswer(q);

    if (q < 5) {
      if (bridge.currentQ === q + 1) ok(`Q${q} -> Q${q + 1} advanced by relay`); else fail(`Q${q} -> Q${q + 1} advanced`, `currentQ=${bridge.currentQ}`);
      if (lastOf(events, 'question', q + 1).length === 1) ok(`Q${q + 1} committed`); else fail(`Q${q + 1} committed`);
    }
  }

  // After Q5 the relay finishes the interview.
  if (lastOf(events, 'interview_closing').length === 1) ok('interview closes after Q5'); else fail('interview closes after Q5');
  // Never asked a 6th question.
  if (lastOf(events, 'question', 6).length === 0) ok('no phantom Q6'); else fail('no phantom Q6');

  bridge.closed = true;
}

{
  // Safety: if Gemini never fires turnComplete, the answer window still opens.
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = null;
  let timerFn = null;
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { if (ms === 14000) { timerFn = fn; return 0; } return realSetTimeout(fn, ms); };
  bridge.speakQuestion(1);
  global.setTimeout = realSetTimeout;
  assert.ok(timerFn, 'safety timer scheduled');
  // Fire the safety timer WITHOUT a turnComplete.
  timerFn();
  if (lastOf(events, 'awaiting_answer', 1).length === 1) ok('safety timer opens answer window without turnComplete');
  else fail('safety timer opens answer window without turnComplete');
  bridge.closed = true;
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);

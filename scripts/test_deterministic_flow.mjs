/**
 * Relay-level tests for deterministic question flow + voice PCM capture.
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
  bridge.ready = true;
  bridge.closed = false;
  const sent = [];
  bridge.geminiWs = { readyState: 1, send: (s) => sent.push(s) };
  bridge.refineQuestionTimeLimit = () => {};
  bridge.generateQuestionBank = () => Promise.resolve();
  return { bridge, events, sent };
}

function lastOf(events, type, number) {
  return events.filter((e) => e.type === type && (number === undefined || e.number === number));
}

function loudPcmB64() {
  const buf = Buffer.alloc(640);
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(8000, i);
  return buf.toString('base64');
}

/** Mock Gemini returning spoken audio for a deterministic question TTS turn. */
function completeQuestionTts(bridge) {
  bridge.modelAudioThisTurn = true;
  bridge.onModelTurnComplete();
}

/** Mock Gemini acknowledging activityEnd after the candidate submits. */
function completeActivityEnd(bridge) {
  bridge.onModelTurnComplete();
}

console.log('=== deterministic Q1..Q5 driver ===\n');
let failures = 0;
const ok = (l) => console.log(`  ok   - ${l}`);
const fail = (l, d = '') => { failures += 1; console.log(`  FAIL - ${l}${d ? ` :: ${d}` : ''}`); };

{
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = null;
  bridge.speakQuestion(1);

  if (lastOf(events, 'question', 1).length === 1) ok('Q1 question committed by relay'); else fail('Q1 question committed by relay');
  if (lastOf(events, 'next_question_ready', 1).length === 1) ok('Q1 next_question_ready'); else fail('Q1 next_question_ready');
  if (lastOf(events, 'awaiting_answer', 1).length === 0) ok('Q1 mic stays closed until TTS completes'); else fail('Q1 mic stays closed until TTS completes');
  if (bridge.answerPromptOpen === false) ok('Q1 answer window closed during TTS'); else fail('Q1 answer window closed during TTS');

  for (let q = 1; q <= 5; q += 1) {
    completeQuestionTts(bridge);
    bridge.startUserTurn();
    bridge.sendAudio(loudPcmB64());
    bridge.endUserTurn();
    completeActivityEnd(bridge);
    await new Promise((r) => setTimeout(r, 500));
    if (lastOf(events, 'answer', q).length >= 1) ok(`Q${q} answer recorded`); else fail(`Q${q} answer recorded`);
    if (q < 5 && bridge.currentQ === q + 1) ok(`Q${q} -> Q${q + 1} advanced`); else if (q < 5) fail(`Q${q} -> Q${q + 1} advanced`, `currentQ=${bridge.currentQ}`);
  }

  if (lastOf(events, 'interview_closing').length === 1) ok('interview closes after Q5'); else fail('interview closes after Q5');
  bridge.closed = true;
}

{
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = null;
  bridge.speakQuestion(1);
  completeQuestionTts(bridge);
  bridge.startUserTurn();
  bridge.userBuf = 'Can you repeat the question please';
  bridge.sendAudio(loudPcmB64());
  bridge.endUserTurn();
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 700));
  if (bridge.currentQ === 1) ok('repeat request stays on Q1'); else fail('repeat request stays on Q1', `currentQ=${bridge.currentQ}`);
  if (bridge.answers.length === 0) ok('repeat does not count as answer'); else fail('repeat does not count as answer');
  if (events.some((e) => e.type === 'question_repeat' && e.number === 1)) ok('question_repeat event emitted');
  else fail('question_repeat event emitted');
  bridge.closed = true;
}

{
  const { bridge } = makeBridge();
  bridge.warmupPhase = 'intro';
  bridge.currentQ = 0;
  bridge.awaitingAnswer = true;
  bridge.answerPromptOpen = true;
  bridge.userBuf = 'Can you repeat the question please';
  bridge.sendAudio(loudPcmB64());
  bridge.completeAnswerTurn();
  if (bridge.warmupPhase === null && bridge.currentQ === 1 && !bridge.questionRepeatUsed[1]) {
    ok('intro repeat phrase does not trigger speech repeat');
  } else {
    fail('intro repeat phrase does not trigger speech repeat', `warmup=${bridge.warmupPhase} currentQ=${bridge.currentQ}`);
  }
  bridge.closed = true;
}

{
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = null;
  bridge.answers = ['[Voice response recorded]'];
  bridge.speakQuestion(2);
  completeQuestionTts(bridge);
  bridge.startUserTurn();
  bridge.userBuf = 'Can you repeat the question please';
  bridge.sendAudio(loudPcmB64());
  bridge.endUserTurn();
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 700));
  if (bridge.questionRepeatUsed[2]) ok('first repeat marks questionRepeatUsed');
  else fail('first repeat marks questionRepeatUsed');
  completeQuestionTts(bridge);
  bridge.startUserTurn();
  bridge.userBuf = 'Can you repeat the question please';
  bridge.sendAudio(loudPcmB64());
  bridge.endUserTurn();
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 700));
  if ((bridge.questionRepeatCount[2] || 0) >= 2) ok('second repeat triggers another re-speak');
  else fail('second repeat triggers another re-speak', `count=${bridge.questionRepeatCount[2]}`);
  if (bridge.answers.length === 1 && bridge.currentQ === 2) ok('second repeat stays on Q2 without recording an answer');
  else fail('second repeat stays on Q2 without recording an answer', `len=${bridge.answers.length} currentQ=${bridge.currentQ}`);
  bridge.closed = true;
}

{
  const { bridge } = makeBridge();
  bridge.warmupPhase = null;
  bridge.speakQuestion(2);
  completeQuestionTts(bridge);
  // Simulate missed user_turn_start — audio alone should still buffer + detect voice.
  bridge.sendAudio(loudPcmB64());
  if (bridge.answerPcmChunks.length > 0) ok('PCM buffered without user_turn_start'); else fail('PCM buffered without user_turn_start');
  if (bridge.voiceDetectedThisTurn) ok('voice energy detected from PCM'); else fail('voice energy detected from PCM');
  if (bridge.userTurnActive) ok('user turn auto-started from PCM'); else fail('user turn auto-started from PCM');
  bridge.closed = true;
}

{
  // Voice-only finalize must proceed even if userTurnActive is still true (no STT wait).
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = null;
  bridge.answers = ['[Voice response recorded]', '[Voice response recorded]'];
  bridge.speakQuestion(3);
  completeQuestionTts(bridge);
  bridge.startUserTurn();
  bridge.sendAudio(loudPcmB64());
  bridge.endUserTurn();
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 500));
  if (lastOf(events, 'answer', 3).length >= 1) ok('voice-only finalize proceeds after Q3 submit'); else fail('voice-only finalize proceeds after Q3 submit');
  if (bridge.currentQ === 4) ok('Q3 answer advances to Q4 without STT wait'); else fail('Q3 answer advances to Q4', `currentQ=${bridge.currentQ}`);
  if (lastOf(events, 'question', 4).length >= 1) ok('Q4 question committed after Q3'); else fail('Q4 question committed after Q3');
  bridge.closed = true;
}

{
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = null;
  let timerFn = null;
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { if (ms === 16000) { timerFn = fn; return 0; } return realSetTimeout(fn, ms); };
  bridge.speakQuestion(1);
  global.setTimeout = realSetTimeout;
  assert.ok(timerFn, 'TTS safety timer scheduled');
  timerFn();
  if (lastOf(events, 'awaiting_answer', 1).length === 1) ok('TTS safety opens answer window without turnComplete');
  else fail('TTS safety opens answer window without turnComplete');
  bridge.closed = true;
}

{
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = null;
  for (let q = 1; q <= 4; q += 1) {
    bridge.speakQuestion(q);
    completeQuestionTts(bridge);
    bridge.startUserTurn();
    bridge.sendAudio(loudPcmB64());
    bridge.endUserTurn();
    completeActivityEnd(bridge);
    await new Promise((r) => setTimeout(r, 500));
  }
  bridge.speakQuestion(5);
  completeQuestionTts(bridge);
  bridge.endUserTurn();
  await new Promise((r) => setTimeout(r, 300));
  if (lastOf(events, 'interview_closing').length === 0) ok('Q5 stays open after stale user_turn_end');
  else fail('Q5 stays open after stale user_turn_end');
  if (bridge.answers.length === 4) ok('Q5 stale end did not record empty answer');
  else fail('Q5 stale end did not record empty answer', `len=${bridge.answers.length}`);
  bridge.startUserTurn();
  bridge.sendAudio(loudPcmB64());
  bridge.endUserTurn();
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 500));
  if (lastOf(events, 'interview_closing').length === 1) ok('interview closes after real Q5 answer');
  else fail('interview closes after real Q5 answer');
  bridge.closed = true;
}

{
  const { bridge } = makeBridge();
  bridge.warmupPhase = null;
  bridge.pendingUserActivityEnd = true;
  bridge.speakQuestion(4, { prefaceAppreciation: true });
  if (bridge.deferredSpeakRequest?.qNum === 4) ok('next question TTS deferred while activityEnd pending');
  else fail('next question TTS deferred while activityEnd pending');
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 0));
  if (bridge.currentQ === 4 && !bridge.deferredSpeakRequest) ok('deferred Q4 speak runs after activityEnd turnComplete');
  else fail('deferred Q4 speak runs after activityEnd turnComplete', `currentQ=${bridge.currentQ}`);
  bridge.closed = true;
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);

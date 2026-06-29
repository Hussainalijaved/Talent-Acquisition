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

/** Wait for post-answer delay before the next question TTS is sent. */
async function awaitNextQuestionSpeak(bridge) {
  if (!bridge.voiceOnly || bridge.answers.length === 0) return;
  await new Promise((r) => setTimeout(r, 1300));
}

/** Mock Gemini returning spoken audio for a deterministic question TTS turn. */
async function completeQuestionTts(bridge) {
  await awaitNextQuestionSpeak(bridge);
  const qNum = bridge.ttsForQ || bridge.currentQ || 1;
  const text = bridge.questions[qNum - 1] || 'Tell me about your experience with customer support.';
  bridge.modelAudioThisTurn = true;
  bridge.lastModelAudioSentAt = Date.now() - 2500;
  bridge.ttsAudioBytesThisTurn = bridge.estimateMinTtsBytes(text, bridge.ttsSpeakOpts || {});
  bridge.onModelTurnComplete();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !bridge.answerPromptOpen) {
    await new Promise((r) => setTimeout(r, 25));
  }
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
    await completeQuestionTts(bridge);
    bridge.startUserTurn();
    bridge.sendAudio(loudPcmB64());
    bridge.endUserTurn();
    completeActivityEnd(bridge);
    await new Promise((r) => setTimeout(r, 2000));
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
  await completeQuestionTts(bridge);
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
  await new Promise((r) => setTimeout(r, 1400));
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
  await completeQuestionTts(bridge);
  bridge.startUserTurn();
  bridge.userBuf = 'Can you repeat the question please';
  bridge.sendAudio(loudPcmB64());
  bridge.endUserTurn();
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 700));
  if (bridge.questionRepeatUsed[2]) ok('first repeat marks questionRepeatUsed');
  else fail('first repeat marks questionRepeatUsed');
  await completeQuestionTts(bridge);
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
  await completeQuestionTts(bridge);
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
  await completeQuestionTts(bridge);
  bridge.startUserTurn();
  bridge.sendAudio(loudPcmB64());
  bridge.endUserTurn();
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 2000));
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
  global.setTimeout = (fn, ms) => { if (ms === 25000) { timerFn = fn; return 0; } return realSetTimeout(fn, ms); };
  bridge.speakQuestion(1);
  global.setTimeout = realSetTimeout;
  assert.ok(timerFn, 'TTS safety timer scheduled');
  const text = bridge.questions[0] || '';
  bridge.ttsAudioBytesThisTurn = bridge.estimateMinTtsBytes(text, bridge.ttsSpeakOpts || {});
  bridge.ttsTurnCompleteReceived = true;
  bridge.lastModelAudioSentAt = Date.now() - 3000;
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
    await completeQuestionTts(bridge);
    bridge.startUserTurn();
    bridge.sendAudio(loudPcmB64());
    bridge.endUserTurn();
    completeActivityEnd(bridge);
    await new Promise((r) => setTimeout(r, 2000));
  }
  bridge.speakQuestion(5);
  await completeQuestionTts(bridge);
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
  await new Promise((r) => setTimeout(r, 3000));
  if (lastOf(events, 'interview_closing').length === 1) ok('interview closes after real Q5 answer');
  else fail('interview closes after real Q5 answer');
  bridge.closed = true;
}

{
  const { bridge } = makeBridge();
  bridge.voiceOnly = false;
  bridge.warmupPhase = null;
  bridge.pendingUserActivityEnd = true;
  bridge.speakQuestion(4, { prefaceAppreciation: true });
  if (bridge.deferredSpeakRequest?.qNum === 4) ok('next question TTS deferred while activityEnd pending');
  else fail('next question TTS deferred while activityEnd pending');
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 500));
  if (bridge.currentQ === 4 && !bridge.deferredSpeakRequest) ok('deferred Q4 speak runs after activityEnd turnComplete');
  else fail('deferred Q4 speak runs after activityEnd turnComplete', `currentQ=${bridge.currentQ}`);
  bridge.closed = true;
}

{
  const { bridge } = makeBridge();
  bridge.voiceOnly = true;
  bridge.warmupPhase = null;
  bridge.pendingUserActivityEnd = true;
  bridge.speakQuestion(3);
  if (bridge.currentQ === 3 && !bridge.deferredSpeakRequest) ok('voice-only does not defer next question TTS');
  else fail('voice-only does not defer next question TTS', `currentQ=${bridge.currentQ}`);
  bridge.closed = true;
}

{
  const { bridge, events, sent } = makeBridge();
  bridge.warmupPhase = null;
  bridge.speakQuestion(2);
  const sentBefore = sent.length;
  await completeQuestionTts(bridge);
  bridge.modelAudioThisTurn = true;
  bridge.ttsAudioBytesThisTurn = 4000;
  bridge.ttsTurnCompleteReceived = true;
  bridge.lastModelAudioSentAt = Date.now() - 3000;
  bridge.clientPlaybackIdleForQ = 2;
  bridge.tryOpenTtsAnswerWindow(2);
  await new Promise((r) => setTimeout(r, 100));
  if ((bridge.questionSpeakRetries[2] || 0) === 0) ok('partial Q2 TTS opens mic without re-speak');
  else fail('partial Q2 TTS opens mic without re-speak', `retries=${bridge.questionSpeakRetries[2]}`);
  if (lastOf(events, 'awaiting_answer', 2).length >= 1) ok('partial Q2 TTS opens answer window');
  else fail('partial Q2 TTS opens answer window');
  if (sent.length === sentBefore) ok('partial Q2 TTS does not send second prompt');
  else fail('partial Q2 TTS does not send second prompt', `sent=${sent.length - sentBefore}`);
  bridge.closed = true;
}

{
  const { bridge, sent } = makeBridge();
  bridge.warmupPhase = null;
  bridge.speakQuestion(2);
  const prompt = bridge.buildQuestionSpeechPrompt(2, bridge.questions[1], { directOnly: true });
  if (prompt.includes('Let me ask this question clearly') || prompt.includes('prefaceReliable')) fail('directOnly prompt has no lead-in filler');
  else ok('directOnly prompt has no lead-in filler');
  bridge.answers = ['[Voice response recorded]'];
  const sentBefore = sent.length;
  bridge.speakQuestion(3);
  await new Promise((r) => setTimeout(r, 1400));
  const newPrompts = sent.slice(sentBefore).filter((s) => s.includes('clientContent'));
  if (newPrompts.length === 1) ok('post-answer Q3 sends exactly one TTS prompt');
  else fail('post-answer Q3 sends exactly one TTS prompt', `count=${newPrompts.length}`);
  if (!newPrompts[0]?.includes('Let me ask this question clearly')) ok('post-answer Q3 prompt has no prefaceReliable lead-in');
  else fail('post-answer Q3 prompt has no prefaceReliable lead-in');
  bridge.closed = true;
}

{
  const { bridge, events, sent } = makeBridge();
  bridge.warmupPhase = null;
  bridge.speakQuestion(2);
  await completeQuestionTts(bridge);
  bridge.answerPromptOpen = false;
  bridge.awaitingAnswer = false;
  bridge.ttsAudioBytesThisTurn = 0;
  bridge.ttsTurnCompleteReceived = true;
  bridge.modelAudioThisTurn = false;
  const awaitingBefore = lastOf(events, 'awaiting_answer', 2).length;
  bridge.tryOpenTtsAnswerWindow(2);
  await new Promise((r) => setTimeout(r, 100));
  if ((bridge.questionSpeakRetries[2] || 0) >= 1) ok('zero-byte TTS re-speaks before mic open');
  else fail('zero-byte TTS re-speaks before mic open', `retries=${bridge.questionSpeakRetries[2]}`);
  if (lastOf(events, 'awaiting_answer', 2).length === awaitingBefore) ok('zero-byte TTS does not open mic early');
  else fail('zero-byte TTS does not open mic early');
  bridge.closed = true;
}

{
  // Candidate explicitly asks to skip → relay records a no-answer and advances.
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = null;
  bridge.speakQuestion(1);
  await completeQuestionTts(bridge);
  bridge.startUserTurn();
  bridge.userBuf = "I don't know this one, let's move on to the next question";
  bridge.sendAudio(loudPcmB64());
  bridge.endUserTurn();
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 2000));
  if (bridge.answers.length === 1) ok('skip records a no-answer turn'); else fail('skip records a no-answer turn', `len=${bridge.answers.length}`);
  if (bridge.skippedTurns && bridge.skippedTurns[1]) ok('skip flags the turn as skipped'); else fail('skip flags the turn as skipped');
  if (bridge.currentQ === 2) ok('skip advances to next question'); else fail('skip advances to next question', `currentQ=${bridge.currentQ}`);
  if (events.some((e) => e.type === 'answer' && e.number === 1 && e.skipped)) ok('skip emits a skipped answer event');
  else fail('skip emits a skipped answer event');
  bridge.closed = true;
}

{
  // A real "I don't know because…" answer must NOT be treated as a skip.
  const { bridge } = makeBridge();
  bridge.warmupPhase = null;
  bridge.speakQuestion(1);
  await completeQuestionTts(bridge);
  bridge.startUserTurn();
  bridge.userBuf = "I don't know the exact figure but I would estimate it around twenty percent based on my experience";
  bridge.sendAudio(loudPcmB64());
  bridge.endUserTurn();
  completeActivityEnd(bridge);
  await new Promise((r) => setTimeout(r, 700));
  if (!(bridge.skippedTurns && bridge.skippedTurns[1])) ok('genuine uncertain answer is not skipped');
  else fail('genuine uncertain answer is not skipped');
  bridge.closed = true;
}

{
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = 'intro';
  bridge.warmupTtsOnly = true;
  bridge.warmupTtsPhase = 'intro';
  bridge.warmupDisplayText = 'Could you briefly introduce yourself?';
  bridge.voiceActivityEndPending = true;
  bridge.modelAudioThisTurn = true;
  bridge.onModelTurnComplete();
  if (bridge.modelAudioThisTurn) ok('activityEnd ack preserves warmup TTS audio');
  else fail('activityEnd ack preserves warmup TTS audio');
  bridge.onModelTurnComplete();
  if (lastOf(events, 'awaiting_answer', 0).length >= 1) ok('intro warmup opens answer window after audio');
  else fail('intro warmup opens answer window after audio');
  if (bridge.answerPromptOpen) ok('intro answer prompt open on relay');
  else fail('intro answer prompt open on relay');
  bridge.closed = true;
}

{
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = 'intro';
  bridge.emitWarmupFallback('intro');
  if (lastOf(events, 'awaiting_answer', 0).length === 1) ok('warmup fallback emits awaiting_answer');
  else fail('warmup fallback emits awaiting_answer');
  if (!bridge.warmupTtsOnly) ok('warmup fallback clears warmupTtsOnly');
  else fail('warmup fallback clears warmupTtsOnly');
  bridge.warmupTtsOnly = true;
  bridge.warmupTtsPhase = 'intro';
  bridge.retryWarmupSpeak('intro');
  if (bridge.answerPromptOpen && bridge.warmupAnswerLatched === 'intro') {
    ok('warmup latch blocks retry after mic window opened');
  } else {
    fail('warmup latch blocks retry after mic window opened');
  }
  bridge.closed = true;
}

{
  const { bridge, events } = makeBridge();
  bridge.warmupPhase = 'intro';
  bridge.scheduleIntroMicOpen('Intro please', 50);
  await new Promise((r) => setTimeout(r, 120));
  if (lastOf(events, 'awaiting_answer', 0).length === 1) ok('intro mic deadline opens answer window');
  else fail('intro mic deadline opens answer window');
  bridge.closed = true;
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);

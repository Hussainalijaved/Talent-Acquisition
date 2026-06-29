import WebSocket from 'ws';
import {
  appendTranscriptionChunk,
  cleanUserAnswerText,
  displayUserTranscript,
  extractInterviewQuestion,
  fallbackInterviewQuestion,
  isClosingOnlyMessage,
  isEnglishTranscript,
  resolveCommittedQuestionText,
  sanitizeTranscript,
} from './transcript-utils.mjs';
import {
  aiDeriveQuestionTimeLimit,
  buildTimerConfig,
  deriveTimeLimitSeconds,
  fallbackTimeLimit,
} from './time-limit.mjs';
import { isRepeatRequest, isSkipRequest, mightBeRepeatRequest } from './repeat-request.mjs';

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TEXT_MODEL_DEFAULT = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const MODEL_FALLBACKS = [
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-2.0-flash-live-001',
];
const SETUP_TIMEOUT_MS = 15000;
/** Gemini turnComplete often arrives before the last audio chunk — wait this long after the final chunk. */
const TTS_AUDIO_QUIET_MS = 2000;
/** Minimum PCM bytes (24 kHz mono int16) expected for a spoken question.
 *  24000 samples/s * 2 bytes = 48000 bytes per second of speech. We require a
 *  conservative MINIMUM so a clearly truncated ("half") reading is re-spoken,
 *  while a complete reading (which is always longer) passes on the first try. */
const TTS_MIN_BASE_BYTES = 24000 * 2; // ~1s floor
const TTS_BYTES_PER_WORD = 7000;      // ~0.29s/word minimum acceptable
const DEFAULT_KICKOFF =
  'Begin the interview now. In the SAME turn, greet the candidate in one short sentence and then ask interview question 1. Ask exactly one question, then stop talking and wait. Do not say anything else.';

function modelCandidates(context) {
  const preferred = String(
    context?.gemini_live_model || process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL
  ).replace(/^models\//, '').trim();
  return [...new Set([preferred, ...MODEL_FALLBACKS, DEFAULT_MODEL].filter(Boolean))];
}

// Strip "Question 1:", "Question 1 -", "Q1:", etc. that Gemini sometimes prefixes.
function stripQuestionNumbering(text) {
  return String(text || '').replace(
    /^(?:(?:interview\s+)?question\s*\d+\s*[:\-–—]?\s*|q\s*\d+\s*[:\-–—]\s*)/i,
    ''
  ).trim();
}

function stripLeadingGreeting(text) {
  // Only strip a short standalone greeting sentence, not the question body.
  const t = String(text || '').trim();
  const greetingOnly = t.match(
    /^(?:hi|hello|hey|welcome|good (?:morning|afternoon|evening)|thanks for joining|thank you for joining)[,!.\s-]+/i
  );
  if (!greetingOnly) return t;
  const rest = t.slice(greetingOnly[0].length).trim();
  // Keep stripping only while the remainder still looks like filler, not the real question.
  if (rest.length < 20) return t;
  return rest;
}

function cleanUserAnswer(text) {
  return cleanUserAnswerText(text);
}

export class GeminiLiveBridge {
  constructor({ apiKey, context, onEvent, onTurnSaved }) {
    this.apiKey = apiKey;
    this.context = context || {};
    this.onEvent = onEvent || (() => {});
    this.onTurnSaved = onTurnSaved || (() => Promise.resolve());
    this.model = String(
      context.gemini_live_model || process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL
    ).replace(/^models\//, '');

    this.geminiWs = null;
    this.ready = false;
    this.closed = false;
    this.interviewEnded = false;
    this.startedAt = Date.now();

    this.questions = [];
    this.answers = [];
    // Deterministic question flow: the relay OWNS the question list and drives
    // progression (Q1→QN) itself. Gemini Live is used only as a TTS voice that
    // reads the exact question text — progression NEVER depends on Gemini's
    // conversational turn-taking, which is what kept stalling between questions.
    this.questionBank = [];
    this.currentQ = 0;
    this.ttsOnlyTurn = false;   // current model turn is just speaking a question
    this.ttsForQ = 0;
    this.ttsSpeakOpts = {};
    this.ttsAudioBytesThisTurn = 0;
    this.ttsTurnCompleteReceived = false;
    this.lastModelAudioSentAt = 0;
    this.clientPlaybackIdleForQ = 0;
    this.ttsAnswerWindowTimer = null;
    this.questionAudioSafety = null;
    this.questionSpeakWatchdog = null;

    this.modelBuf = '';
    this.userBuf = '';
    this.lateUserBuf = '';

    this.roundQuestionEmitted = false;
    this.awaitingAnswer = false;
    this.answerPromptOpen = false;
    this.answerPromptFor = 0;
    this.answerPromptGeneration = 0;
    this.activeAnswerGeneration = 0;
    this.pendingAnswerGeneration = null;
    this.answerWindowOpenedAt = 0;
    this.blockModelOutput = false;
    this.userTurnActive = false;
    this.answerTimer = null;
    this.pendingFinalize = null;
    this.userTurnEndedAt = 0;
    this.pendingAudioChunks = [];
    this.allowModelAudio = false;

    this.maxTurns = Number(context.speech_phases || 5);
    this.maxQuestions = Number(context.max_questions || 5);
    // Seed the deterministic question bank with reliable fallbacks immediately so
    // the interview can ALWAYS progress, even if AI generation is slow or fails.
    for (let i = 1; i <= this.maxTurns; i += 1) {
      this.questionBank.push(fallbackInterviewQuestion(i, this.maxTurns));
    }
    this.prematureClosingReprompts = 0;
    this.nextQuestionWatchdog = null;
    this.answerWindowSafetyTimer = null;
    this.questionTimeLimits = {};
    this.timerRefineTokens = {};
    this.streamingQuestionText = '';
    this.streamingQuestionNum = 0;

    // Follow-up / coaching (Micro1-style). Decisions are heuristic on the
    // transcript so the next question is never delayed by the scoring API.
    this.followUpUsed = {};
    this.inFollowUpFor = 0;
    this.lastAnswerWeak = false;
    this.coachingConfig = {
      // Require ≥ 30 words to avoid triggering on short-but-real answers.
      // Silence-auto-submit yields "[No spoken response captured]" which isWeakAnswer()
      // already guards against, but a short 5-word answer would slip through at 12.
      minWords: Number(context.followup_min_words ?? 30),
      // Default OFF — follow-ups confuse candidates who expect Q2.
      // Enable explicitly in the n8n workflow via follow_up_enabled: true.
      followUpEnabled: Boolean(context.follow_up_enabled),
      coachingEnabled: Boolean(context.coaching_enabled),
    };

    // Relay-side silence detection. Driven by transcript growth (authoritative)
    // rather than client mic level, so a quiet-but-speaking candidate is never
    // cut off. nudge → speak; sustained silence after the nudge → auto-submit.
    this.inNudgePlayback = false;
    this.lastUserActivityAt = 0;
    this.silenceMonitor = null;
    this.silenceNudged = false;
    this.silenceNudgedAt = 0;
    const nudgeSec = Number(context.silence_nudge_seconds ?? 5);
    const autoSec = Number(context.silence_auto_submit_seconds ?? 6);
    this.silenceConfig = {
      nudgeMs: Number.isFinite(nudgeSec) && nudgeSec > 0 ? nudgeSec * 1000 : 5000,
      autoMs: Number.isFinite(autoSec) && autoSec > 0 ? autoSec * 1000 : 6000,
      enabled: context.silence_handling_enabled !== false,
    };

    // Two-phase warm-up:
    //   'mic_check' (-1) — AI asks candidate to say anything to verify mic.
    //                       Auto-advances as soon as ANY speech is transcribed.
    //   'intro'     (0)  — AI asks candidate to introduce themselves.
    //                       Candidate presses Submit when done; no auto-submit.
    //   null             — actual numbered interview questions.
    this.warmupPhase = context.intro_enabled !== false ? 'mic_check' : null;
    this.micCheckAdvanceTimer = null;
    this.introQuestionAsked = false;

    // Per-answer PCM buffer for audio-primary scoring.
    // Chunks are 16-bit LE signed PCM at 16 kHz, stored as base64 strings.
    // Cleared at the start of each new real question; captured only during
    // actual interview turns (not warmup). Max ~120 s kept to bound memory.
    this.answerPcmChunks = [];
    this.answerPcmChunksByTurn = {}; // aNum → chunks[], for buildTurnPairs fallback
    this._answerPcmSampleRate = 16000;
    // Voice-only: candidate speech is NEVER transcribed. Flow and scoring use PCM audio.
    this.voiceOnly = context.voice_only !== false;
    this.voiceDetectedThisTurn = false;
    // Transcription-free UI: flow must not depend on output captions. Track
    // whether the model actually spoke audio this turn so we can still commit
    // questions and open the mic when captions are empty.
    this.modelAudioThisTurn = false;
    this.interviewClosing = false;
    this.warmupSpeakRetries = { mic_check: 0, intro: 0 };
    this.questionSpeakRetries = {};
    this.warmupAudioDelivered = { mic_check: false, intro: false };
    // Defer next-question TTS until Gemini acknowledges activityEnd — sending
    // speakQuestion too early yields silent turnComplete on Q3+ (repeat works
    // because the user delay gives Gemini time to settle).
    this.pendingUserActivityEnd = false;
    this.activityEndTurnTimer = null;
    this.deferredSpeakRequest = null;
    this.closingReprompts = 0;
    this.closingCompleteTimer = null;
    // Speech Q1–Q5 only: realistic "repeat the question" + "continue in English"
    // handling. Both keep the candidate on the SAME question (no phase advance).
    this.questionRepeatUsed = {};        // legacy flag (kept for back-compat)
    this.questionRepeatCount = {};       // qNum → times the question was re-spoken
    this.nonEnglishNudgeCount = {};      // qNum → times we asked to continue in English
    // How many times a candidate may ask to repeat a single question before the
    // relay simply waits for their answer (avoids an endless repeat loop).
    this.maxQuestionRepeats = Math.max(1, Number(context.max_question_repeats ?? 3));
    // How many times the relay re-asks the SAME question in English before it
    // accepts whatever audio it has and moves on (scoring still runs at the end).
    this.maxNonEnglishNudges = Math.max(1, Number(context.max_non_english_nudges ?? 2));
    // Off-topic guard: if the candidate answers in English but clearly off-topic
    // (e.g. a random counter-question), gently redirect and stay on the SAME
    // question. Bounded so a false positive only costs ONE gentle re-ask.
    this.relevanceGuardEnabled = context.relevance_guard_enabled !== false;
    this.maxIrrelevantRedirects = Math.max(0, Number(context.max_irrelevant_redirects ?? 1));
    this.irrelevantRedirectCount = {};   // qNum → times we redirected for off-topic
    this.relevanceChecking = false;      // guard: a relevance check is in flight
    // Brief, varied acknowledgement of the previous answer before the next
    // question ("Thank you for sharing that." etc.) — warmer, production feel.
    this.appreciationEnabled = context.appreciation_enabled !== false;
    // Turns answered in a non-English language (after nudges) → scored ZERO at the
    // end. The interview must be conducted in English.
    this.nonEnglishTurns = {};           // aNum → true when recorded answer was non-English
  }

  timerConfig() {
    return buildTimerConfig(this.context);
  }

  syncQuestionTimeLimit(questionText) {
    return deriveTimeLimitSeconds(null, null, questionText, this.timerConfig());
  }

  emitAwaitingAnswer(qNum, questionText, opts = {}) {
    // Always emit — client may have missed a prior awaiting_answer during audio handoff.
    if (qNum >= 1) this.answerPcmChunks = [];
    const isWarmup = !!(opts.warmup || qNum <= 0);
    const limits = isWarmup
      ? { seconds: Number(this.context.intro_answer_seconds || 90), tier: 'warmup' }
      : this.syncQuestionTimeLimit(questionText);
    this.questionTimeLimits[qNum] = limits;
    this.answerPromptOpen = true;
    this.answerPromptFor = qNum;
    this.activeAnswerGeneration = this.answerPromptGeneration;
    this.answerWindowOpenedAt = Date.now();
    // Do NOT block model audio here — turnComplete can arrive before the last
    // audio chunk; blocking here causes clipped/garbled interviewer speech.
    const ev = {
      type: 'awaiting_answer',
      number: qNum,
      maxTurns: this.maxTurns,
      time_limit_seconds: limits.seconds,
      complexity_tier: limits.tier,
    };
    if (isWarmup) ev.warmup = opts.warmup || this.warmupPhase;
    this.onEvent(ev);
    if (qNum >= 1) this.refineQuestionTimeLimit(qNum, questionText);
  }

  flushClientPlayback() {
    this.onEvent({ type: 'flush_playback' });
  }

  cancelTtsAnswerWindow() {
    if (this.ttsAnswerWindowTimer) {
      clearTimeout(this.ttsAnswerWindowTimer);
      this.ttsAnswerWindowTimer = null;
    }
  }

  estimateMinTtsBytes(questionText, opts = {}) {
    const words = String(questionText || '').split(/\s+/).filter(Boolean).length;
    let prefaceWords = 0;
    if (opts.prefaceEnglishNudge) prefaceWords = 18;
    else if (opts.prefaceRepeat) prefaceWords = 12;
    else if (opts.prefaceIrrelevant) prefaceWords = 15;
    else if (opts.prefaceAppreciation) prefaceWords = 10;
    const totalWords = words + prefaceWords + 8;
    return Math.max(TTS_MIN_BASE_BYTES, Math.floor(totalWords * TTS_BYTES_PER_WORD));
  }

  openTtsAnswerWindow(qNum, questionText) {
    if (this.answerPromptOpen || this.interviewEnded || this.closed) return;
    this.cancelTtsAnswerWindow();
    this.ttsOnlyTurn = false;
    this.ttsTurnCompleteReceived = false;
    this.clientPlaybackIdleForQ = 0;
    this.modelBuf = '';
    this.modelAudioThisTurn = false;
    this.emitAwaitingAnswer(qNum, questionText);
  }

  tryOpenTtsAnswerWindow(qNum) {
    const questionText = this.questions[qNum - 1] || '';
    if (this.answerPromptOpen || this.interviewEnded || this.closed) return;
    if (this.ttsForQ !== qNum || !this.ttsTurnCompleteReceived) return;

    const sinceAudio = Date.now() - (this.lastModelAudioSentAt || 0);
    const clientReady = this.clientPlaybackIdleForQ === qNum;
    const quietTarget = clientReady ? 800 : TTS_AUDIO_QUIET_MS;
    if (sinceAudio < quietTarget) {
      this.scheduleTtsAnswerWindow(qNum, questionText);
      return;
    }

    // Accept whatever audio Gemini produced — never re-speak a "truncated" clip here.
    // Re-speaking after partial audio is what caused half-then-full double questions.
    this.openTtsAnswerWindow(qNum, questionText);
  }

  scheduleTtsAnswerWindow(qNum, questionText) {
    this.cancelTtsAnswerWindow();
    const sinceAudio = Date.now() - (this.lastModelAudioSentAt || 0);
    const clientReady = this.clientPlaybackIdleForQ === qNum;
    const quietTarget = clientReady ? 800 : TTS_AUDIO_QUIET_MS;
    const delay = Math.max(50, quietTarget - sinceAudio);
    this.ttsAnswerWindowTimer = setTimeout(() => this.tryOpenTtsAnswerWindow(qNum), delay);
  }

  handleClientPlaybackIdle(qNum) {
    if (this.interviewEnded || this.closed || qNum < 1) return;
    if (this.ttsForQ !== qNum) return;
    this.clientPlaybackIdleForQ = qNum;
    if (this.ttsTurnCompleteReceived) this.tryOpenTtsAnswerWindow(qNum);
  }

  scheduleActivityEndTurnFallback() {
    if (this.activityEndTurnTimer) clearTimeout(this.activityEndTurnTimer);
    this.activityEndTurnTimer = setTimeout(() => {
      this.activityEndTurnTimer = null;
      if (!this.pendingUserActivityEnd) return;
      console.warn('[relay] activityEnd turnComplete timeout — flushing deferred question TTS');
      this.pendingUserActivityEnd = false;
      this.flushDeferredSpeak();
    }, 3500);
  }

  flushDeferredSpeak() {
    if (!this.deferredSpeakRequest) return;
    const { qNum, opts } = this.deferredSpeakRequest;
    this.deferredSpeakRequest = null;
    setTimeout(() => {
      if (this.interviewEnded || this.closed) return;
      this.speakQuestion(qNum, opts);
    }, 450);
  }

  sendSpokenPrompt(text, { flushFirst = true } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    this.modelAudioThisTurn = false;
    this.blockModelOutput = false;
    this.allowModelAudio = true;
    if (flushFirst) this.flushClientPlayback();
    const spoken = /^\[Speak out loud/i.test(clean)
      ? clean
      : `[Speak out loud in clear English — the candidate must HEAR you. One short turn only, then stop and wait.] ${clean}`;
    this.sendClientText(spoken, true);
  }

  retryWarmupSpeak(phase) {
    if (this.interviewEnded || this.closed || this.warmupPhase !== phase) return;
    const key = phase === 'mic_check' ? 'mic_check' : 'intro';
    this.warmupSpeakRetries[key] = (this.warmupSpeakRetries[key] || 0) + 1;
    if (this.warmupSpeakRetries[key] > 3) {
      console.warn(`[relay] warmup ${phase} speak retries exhausted — using fallback prompt`);
      this.emitWarmupFallback(phase);
      return;
    }
    console.warn(`[relay] warmup ${phase} had no audible output — retry #${this.warmupSpeakRetries[key]}`);
    this.blockModelOutput = false;
    this.allowModelAudio = true;
    this.modelAudioThisTurn = false;
    this.modelBuf = '';
    this.pendingAudioChunks = [];
    this.sendSpokenPrompt(
      phase === 'mic_check' ? this.buildMicCheckPrompt() : this.buildIntroPrompt()
    );
    this.scheduleWarmupWatchdog(phase);
  }

  emitWarmupFallback(phase) {
    const wNum = phase === 'mic_check' ? -1 : 0;
    const fallbackText = phase === 'mic_check'
      ? 'Please say a few words so I can confirm your microphone is working.'
      : 'Could you please tell me a bit about yourself — your name, background, and what brings you here?';
    if (phase === 'intro') this.introQuestionAsked = true;
    this.clearNextQuestionWatchdog();
    this.onEvent({ type: 'question', number: wNum, text: fallbackText, warmup: phase });
    this.emitAwaitingAnswer(wNum, fallbackText, { warmup: phase });
  }

  clearAnswerPromptWindow() {
    this.answerPromptOpen = false;
    this.answerPromptFor = 0;
    this.answerWindowOpenedAt = 0;
  }

  answerWindowAgeMs() {
    return this.answerWindowOpenedAt ? Date.now() - this.answerWindowOpenedAt : 0;
  }

  hasAnswerContent(pcmChunks = this.answerPcmChunks) {
    if (this.hasVoiceCapture(pcmChunks)) return true;
    if (this.voiceOnly) return false;
    return Boolean(this.getInternalUserTranscript());
  }

  minAnswerWindowMsFor(qNum) {
    return qNum === this.maxTurns ? 2500 : 800;
  }

  shouldRejectPrematureAnswerEnd(qNum) {
    if (this.warmupPhase || qNum <= 0) return false;
    if (!this.answerPromptOpen || qNum !== this.answerPromptFor) return true;
    if (this.hasAnswerContent()) return false;
    return this.answerWindowAgeMs() < this.minAnswerWindowMsFor(qNum);
  }

  refineQuestionTimeLimit(qNum, questionText) {
    const token = Symbol('timer_refine');
    this.timerRefineTokens[qNum] = token;
    void aiDeriveQuestionTimeLimit({
      apiKey: this.apiKey,
      questionText,
      config: this.context,
      role: String(this.context.requisition_title || 'the role'),
      previousLimit: qNum > 1 ? this.questionTimeLimits[qNum - 1] : null,
    })
      .then((refined) => {
        if (this.closed || this.timerRefineTokens[qNum] !== token) return;
        const prev = this.questionTimeLimits[qNum];
        if (!prev || prev.seconds === refined.seconds) {
          this.questionTimeLimits[qNum] = refined;
          return;
        }
        this.questionTimeLimits[qNum] = refined;
        this.onEvent({
          type: 'time_limit_update',
          number: qNum,
          time_limit_seconds: refined.seconds,
          complexity_tier: refined.tier,
        });
      })
      .catch((err) => {
        console.warn(`[relay] Q${qNum} timer AI refine skipped:`, err.message);
      });
  }

  buildMicCheckPrompt() {
    const org = String(this.context.organization_name || 'CONVO');
    return (
      this.context.mic_check_prompt ||
      `Greet the candidate warmly in one short sentence, welcome them to ${org}. Then tell them you want to do a quick microphone check and ask them to say just a few words — anything at all — so you can confirm you can hear them clearly. Do NOT ask them to introduce themselves yet. Stop after the microphone check request and wait.`
    );
  }

  buildIntroPrompt() {
    const role = String(this.context.requisition_title || 'this role');
    return (
      this.context.intro_prompt ||
      `The microphone is working. Now please ask the candidate to briefly introduce themselves — their name, their background, and what brings them to apply for ${role}. Keep your prompt warm and to one or two sentences. Then stop and wait for their answer.`
    );
  }

  buildFirstQuestionPrompt() {
    return (
      `The candidate has finished their introduction. Now begin the interview. Ask interview question 1 of ${this.maxTurns} in clear, professional English. ` +
      'Do NOT thank them or repeat anything from the introduction — start the question directly. ' +
      'Do NOT say "Question 1" or any number aloud. Ask exactly one behavioural or scenario-based question, then stop talking and wait.'
    );
  }

  async generateQuestionBank() {
    const apiKey = this.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) return;
    const role = String(this.context.requisition_title || 'this role').trim();
    const jd = String(this.context.job_description || this.context.requirements || '').slice(0, 1500).trim();
    const n = this.maxTurns;
    const prompt =
      `You are designing a spoken behavioural interview for the role: "${role}".` +
      (jd ? `\n\nRole context:\n${jd}` : '') +
      `\n\nWrite exactly ${n} interview questions that assess soft skills (communication, teamwork, ` +
      `problem solving, composure under pressure, motivation). Each question must be ONE or TWO sentences, ` +
      `clear, spoken-English friendly, and answerable out loud in under a minute. Do NOT number them and do ` +
      `NOT add any preamble. Return ONLY a JSON array of ${n} strings.`;
    const model = String(
      this.context.gemini_text_model || process.env.GEMINI_TEXT_MODEL || TEXT_MODEL_DEFAULT
    ).replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.6, responseMimeType: 'application/json' },
        }),
      }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`gen ${res.status}`);
      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      let arr = null;
      try { arr = JSON.parse(raw); } catch (_) {
        const m = raw.match(/\[[\s\S]*\]/);
        if (m) { try { arr = JSON.parse(m[0]); } catch (_) {} }
      }
      if (!Array.isArray(arr)) throw new Error('bad shape');
      const cleaned = arr
        .map((q) => stripQuestionNumbering(String(q || '').trim()))
        .filter((q) => q.length > 8);
      // Only overwrite slots that have not been asked yet.
      for (let i = 0; i < this.maxTurns; i += 1) {
        if (i + 1 <= this.currentQ) continue;
        if (cleaned[i]) this.questionBank[i] = cleaned[i];
      }
      console.log(`[relay] question bank ready — ${cleaned.length}/${this.maxTurns} AI questions`);
    } catch (err) {
      console.warn('[relay] question generation failed, using fallbacks:', err.message);
    }
  }

  // ── Deterministic question driver ──────────────────────────────────────────
  // Commit the question text, send it to the client, have Gemini SPEAK it, then
  // open the answer window when the spoken audio completes (or a safety timeout).
  // Progression never waits on Gemini to "decide" to ask the next question.
  speakQuestion(qNum, opts = {}) {
    if (this.interviewEnded || this.interviewClosing || this.closed) return;
    if (this.pendingUserActivityEnd) {
      this.deferredSpeakRequest = { qNum, opts };
      console.log(`[relay] deferring Q${qNum} TTS until activityEnd turnComplete`);
      return;
    }
    if (qNum > this.maxTurns) {
      this.finishInterview();
      return;
    }
    const text =
      (this.questionBank[qNum - 1] || '').trim() ||
      fallbackInterviewQuestion(qNum, this.maxTurns);
    this.questions[qNum - 1] = text;
    this.currentQ = qNum;
    this.answerPromptGeneration += 1;
    this.pendingAnswerGeneration = null;

    // Reset all turn state so nothing from the previous answer leaks in.
    this.clearAnswerPromptWindow();
    if (this.nextQuestionWatchdog) { clearTimeout(this.nextQuestionWatchdog); this.nextQuestionWatchdog = null; }
    if (this.answerWindowSafetyTimer) { clearTimeout(this.answerWindowSafetyTimer); this.answerWindowSafetyTimer = null; }
    if (this.pendingFinalize) { clearTimeout(this.pendingFinalize); this.pendingFinalize = null; }
    if (this.answerTimer) { clearTimeout(this.answerTimer); this.answerTimer = null; }
    if (this.questionSpeakWatchdog) { clearTimeout(this.questionSpeakWatchdog); this.questionSpeakWatchdog = null; }
    this.awaitingAnswer = false;
    this.answerPromptOpen = false;
    this.userTurnActive = false;
    this.userBuf = '';
    this.lateUserBuf = '';
    this.modelBuf = '';
    this.modelAudioThisTurn = false;
    this.voiceDetectedThisTurn = false;
    this.roundQuestionEmitted = true;
    this.streamingQuestionText = '';
    this.streamingQuestionNum = 0;
    this.inFollowUpFor = 0;
    this.blockModelOutput = false;
    this.allowModelAudio = true;
    this.pendingAudioChunks = [];
    this.answerPcmChunks = [];
    this.ttsOnlyTurn = true;
    this.ttsForQ = qNum;
    this.ttsSpeakOpts = opts;
    this.ttsAudioBytesThisTurn = 0;
    this.ttsTurnCompleteReceived = false;
    this.lastModelAudioSentAt = 0;
    this.clientPlaybackIdleForQ = 0;
    this.cancelTtsAnswerWindow();
    this.questionSpeakRetries[qNum] = 0;

    this.flushClientPlayback();
    this.onEvent({ type: 'next_question_ready', number: qNum });
    this.onEvent({ type: 'transcript', speaker: 'model', text, partial: false, number: qNum });
    this.onEvent({ type: 'question', number: qNum, text });
    this.computeAndEmitTimer(qNum, text);

    this.sendSpokenPrompt(this.buildQuestionSpeechPrompt(qNum, text, opts), { flushFirst: false });

    // CRITICAL: open the mic ONLY after Gemini finishes speaking the question.
    // Emitting awaiting_answer before TTS completes caused the client mic to open
    // while answering=true, which blocked output_audio — candidate heard nothing.
    if (this.questionAudioSafety) clearTimeout(this.questionAudioSafety);
    this.questionAudioSafety = setTimeout(() => {
      this.questionAudioSafety = null;
      if (this.ttsForQ !== qNum || this.interviewEnded || this.closed) return;
      if (!this.answerPromptOpen) {
        console.warn(`[relay] question ${qNum} TTS safety — opening answer window without turnComplete`);
        this.openTtsAnswerWindow(qNum, text);
      }
    }, 22000);

    this.scheduleQuestionSpeakWatchdog(qNum, text);
  }

  // Single source of truth for the spoken-question prompt. Both the first speak
  // and every retry/repeat use THIS, so a retry is exactly as reliable as the
  // "repeat" path (which the candidate confirmed always works).
  buildQuestionSpeechPrompt(qNum, text, opts = {}) {
    const lastQuestionHint =
      qNum === this.maxTurns
        ? ' This is the LAST interview question — do NOT thank the candidate, do NOT say goodbye, and do NOT say the interview is complete. '
        : ' ';
    // ONE short spoken preface before the question is read, depending on context.
    let preface = '';
    let prefaceDesc = '';
    if (opts.prefaceEnglishNudge) {
      preface =
        'In ONE short, warm, polite sentence, let the candidate know this interview must be in English and ask them to please answer in English (for example: "I\'m sorry, this interview is in English — could you please answer in English?"). Then ';
      prefaceDesc = ' brief request and the';
    } else if (opts.prefaceRepeat) {
      preface =
        'In ONE short, warm sentence, reassure the candidate that it is no problem and you will repeat the question (for example: "No problem — let me repeat the question."). Then ';
      prefaceDesc = ' brief reassurance and the';
    } else if (opts.prefaceIrrelevant) {
      preface =
        'In ONE short, warm, encouraging sentence, gently let the candidate know that response seems off-topic and you would like them to focus on the question being asked (for example: "That seems a little off-topic — let\'s focus on this question."). Do NOT be harsh. Then ';
      prefaceDesc = ' brief redirection and the';
    } else if (opts.prefaceAppreciation) {
      preface =
        "In ONE short, warm, professional sentence, briefly acknowledge the candidate's previous answer using natural, varied wording (for example: \"Thank you for sharing that.\", \"Great, I appreciate the detail.\", or \"Understood, thank you.\"). Do NOT rate, score, critique, or give feedback on the answer. Then ";
      prefaceDesc = ' brief acknowledgement and the';
    } else {
      return (
        `You are the interviewer speaking out loud directly to the candidate, who can only HEAR you.` +
        `${lastQuestionHint}` +
        `Read this interview question clearly and completely, word for word, in a warm professional tone.` +
        ` Speak the ENTIRE question in one go — never stop partway, never repeat it, and do not add anything before or after.` +
        ` Say ONLY this question — no numbering, no preamble, no follow-up:\n"${text}"`
      );
    }
    return (
      `You are the interviewer speaking out loud directly to the candidate, who can only HEAR you. ${preface}` +
      `say this interview question out loud, clearly and completely, word for word, in a warm professional tone.` +
      `${lastQuestionHint}` +
      `Speak the ENTIRE question — never stop partway. Say ONLY this${prefaceDesc} question and nothing else — no numbering, no second question, no follow-up:\n"${text}"`
    );
  }

  scheduleQuestionSpeakWatchdog(qNum, text) {
    if (this.questionSpeakWatchdog) clearTimeout(this.questionSpeakWatchdog);
    this.questionSpeakWatchdog = setTimeout(() => {
      this.questionSpeakWatchdog = null;
      if (this.ttsForQ !== qNum || this.interviewEnded || this.closed) return;
      if (this.answerPromptOpen) return;
      const bytes = this.ttsAudioBytesThisTurn || 0;
      if (this.ttsTurnCompleteReceived && bytes > 0) return;
      if (!this.ttsTurnCompleteReceived && bytes > 0) return;
      console.warn(`[relay] question ${qNum} had no TTS audio — watchdog retry`);
      this.retryQuestionSpeak(qNum, text, { flushFirst: true });
    }, 6000);
  }

  retryQuestionSpeak(qNum, text, opts = {}) {
    if (this.interviewEnded || this.closed || this.ttsForQ !== qNum) return;
    if (this.answerPromptOpen) return;
    const questionText = String(text || this.questions[qNum - 1] || '').trim()
      || fallbackInterviewQuestion(qNum, this.maxTurns);
    const retries = (this.questionSpeakRetries[qNum] || 0) + 1;
    this.questionSpeakRetries[qNum] = retries;
    if (retries > 4) {
      // Exhausted: open the window anyway. The question text is already on screen
      // (emitted by speakQuestion), so the candidate can still read and answer it.
      console.warn(`[relay] Q${qNum} TTS retries exhausted — opening window with on-screen question`);
      if (!this.answerPromptOpen && !this.interviewEnded && !this.closed) {
        this.openTtsAnswerWindow(qNum, questionText);
      }
      return;
    }
    const delayMs = Math.min(800, 200 + retries * 150);
    setTimeout(() => {
      if (this.interviewEnded || this.closed || this.ttsForQ !== qNum) return;
      if (this.answerPromptOpen) return;
      this.modelBuf = '';
      this.modelAudioThisTurn = false;
      this.ttsAudioBytesThisTurn = 0;
      this.ttsTurnCompleteReceived = false;
      this.clientPlaybackIdleForQ = 0;
      this.lastModelAudioSentAt = 0;
      this.blockModelOutput = false;
      this.allowModelAudio = true;
      this.pendingAudioChunks = [];
      this.ttsOnlyTurn = true;
      this.ttsForQ = qNum;
      // Use the SAME strong, prefaced prompt as the first speak / repeat path —
      // a bare "read this" prompt is what the native model tends to ignore on Q3+.
      this.sendSpokenPrompt(
        this.buildQuestionSpeechPrompt(qNum, questionText, this.ttsSpeakOpts || {}),
        { flushFirst: opts.flushFirst !== false }
      );
      this.scheduleQuestionSpeakWatchdog(qNum, questionText);
    }, delayMs);
  }

  computeAndEmitTimer(qNum, text) {
    try {
      const qLimits =
        this.questionTimeLimits[qNum] || fallbackTimeLimit(text || '', this.context);
      this.questionTimeLimits[qNum] = qLimits;
    } catch (_) {}
  }

  buildNextQuestionPrompt(aNum, nextQ) {
    if (nextQ >= this.maxTurns) {
      return (
        `The candidate finished answering question ${aNum}. You MUST ask interview question ${nextQ} of ${this.maxTurns} now — this is the LAST question before the interview ends. ` +
        'Ask exactly ONE behavioural interview question in clear English — no coaching, no preamble, no second question. Do NOT thank the candidate. Do NOT say the interview is complete. Do NOT say goodbye or "we will be in touch". Ask the question only, then stop and wait.'
      );
    }
    return (
      `The candidate finished answering question ${aNum}. Now ask interview question ${nextQ} of ${this.maxTurns} in clear English. ` +
      'Ask exactly ONE question only — no coaching, no acknowledgment, no follow-up probe, and no second question in the same turn. Then stop talking and wait for the candidate. Do not thank or close the interview yet.'
    );
  }

  buildFollowUpPrompt(qNum, questionText, answerText) {
    return (
      `The candidate's answer to question ${qNum} was brief or unclear (internal note — never mention scoring). ` +
      `Original question: "${String(questionText || '').slice(0, 220)}" ` +
      `Their answer: "${String(answerText || '').slice(0, 280)}" ` +
      `Ask ONE short follow-up probe on the SAME topic so they can clarify or give a concrete example. ` +
      `Do NOT move to question ${qNum + 1} yet. One follow-up only, then stop and wait.`
    );
  }

  // Heuristic only — runs instantly so the next question is never blocked on the
  // scoring API. A genuinely empty/no-response answer does NOT trigger a follow-up.
  isWeakAnswer(userText) {
    if (this.voiceOnly) return false;
    const t = String(userText || '').trim();
    if (!t || /^\[(no spoken|non-english|no speech|noise)/i.test(t)) return false;
    const words = t.split(/\s+/).filter(Boolean).length;
    if (words < this.coachingConfig.minWords) return true;
    if (/^(i don'?t know|not sure|no idea|i'?m not sure|pass)\b/i.test(t)) return true;
    return false;
  }

  buildClosingReprompt(expectedQ) {
    return (
      `You spoke a closing or thank-you message too early. The interview is NOT finished yet. ` +
      `Ask interview question ${expectedQ} of ${this.maxTurns} now — one clear behavioural question only. ` +
      'Do NOT thank the candidate. Do NOT say the interview is complete. Then stop and wait.'
    );
  }

  scheduleWarmupWatchdog(phase) {
    if (this.nextQuestionWatchdog) clearTimeout(this.nextQuestionWatchdog);
    this.nextQuestionWatchdog = setTimeout(() => {
      this.nextQuestionWatchdog = null;
      if (this.interviewEnded || this.closed || this.warmupPhase !== phase) return;
      if (phase === 'intro' && this.introQuestionAsked && this.answerPromptOpen && this.warmupAudioDelivered.intro) return;
      console.warn(`[relay] warmup watchdog — ${phase} not heard, retrying speak`);
      this.retryWarmupSpeak(phase);
    }, 16000);
  }

  scheduleNextQuestionWatchdog(nextQ) {
    if (this.nextQuestionWatchdog) clearTimeout(this.nextQuestionWatchdog);
    this.nextQuestionWatchdog = setTimeout(() => {
      this.nextQuestionWatchdog = null;
      if (this.interviewEnded || this.closed || this.questions.length >= nextQ) return;
      const streamed = this.streamingQuestionNum === nextQ ? this.streamingQuestionText : '';
      const streamQ = extractInterviewQuestion(streamed) || streamed;
      if (streamQ.includes('?') && streamQ.split(/\s+/).filter(Boolean).length >= 6) {
        console.warn(`[relay] next-question watchdog — committing streamed Q${nextQ}`);
        this.commitQuestionText(nextQ, streamQ);
        return;
      }
      console.warn(`[relay] next-question watchdog — Q${nextQ} not received, injecting fallback`);
      this.roundQuestionEmitted = false;
      this.modelBuf = '';
      this.blockModelOutput = false;
      this.allowModelAudio = true;
      const fallback = fallbackInterviewQuestion(nextQ, this.maxTurns);
      this.commitQuestionText(nextQ, fallback);
    }, 8000);
  }

  /** Force awaiting_answer if Gemini turnComplete never commits the question. */
  scheduleAnswerWindowSafety(nextQ) {
    if (this.answerWindowSafetyTimer) clearTimeout(this.answerWindowSafetyTimer);
    this.answerWindowSafetyTimer = setTimeout(() => {
      this.answerWindowSafetyTimer = null;
      if (this.interviewEnded || this.closed || this.warmupPhase) return;
      if (this.answerPromptOpen && this.answerPromptFor === nextQ) return;
      const streamed = this.streamingQuestionNum === nextQ ? this.streamingQuestionText : '';
      const qText = this.questions[nextQ - 1]
        || extractInterviewQuestion(streamed)
        || fallbackInterviewQuestion(nextQ, this.maxTurns);
      console.warn(`[relay] answer-window safety — forcing awaiting_answer for Q${nextQ}`);
      if (this.questions.length < nextQ) {
        this.commitQuestionText(nextQ, qText);
      } else {
        this.onEvent({ type: 'question', number: nextQ, text: this.questions[nextQ - 1] || qText });
        this.emitAwaitingAnswer(nextQ, this.questions[nextQ - 1] || qText);
      }
    }, 8000);
  }

  commitQuestionText(qNum, text, opts = {}) {
    const raw = stripQuestionNumbering(String(text || '').trim());
    const modelText = extractInterviewQuestion(raw) || raw;
    if (!modelText || qNum < 1 || qNum > this.maxTurns) return;

    if (!this.roundQuestionEmitted && this.questions.length < qNum) {
      while (this.questions.length < qNum - 1) {
        this.questions.push('');
      }
      if (this.questions.length === qNum - 1) {
        this.questions.push(modelText);
      } else if (this.questions.length >= qNum) {
        this.questions[qNum - 1] = modelText;
      }
      this.roundQuestionEmitted = true;
    } else if (this.questions.length >= qNum) {
      this.questions[qNum - 1] = modelText;
    } else {
      this.questions.push(modelText);
      this.roundQuestionEmitted = true;
    }

    if (this.kickoffWatchdog) {
      clearTimeout(this.kickoffWatchdog);
      this.kickoffWatchdog = null;
    }
    this.clearNextQuestionWatchdog();
    this.onEvent({ type: 'transcript', speaker: 'model', text: modelText, partial: false, number: qNum });
    this.onEvent({
      type: 'question',
      number: qNum,
      text: modelText,
      follow_up: !!opts.follow_up,
    });
    this.emitAwaitingAnswer(qNum, modelText, opts);
  }

  clearNextQuestionWatchdog() {
    if (this.nextQuestionWatchdog) {
      clearTimeout(this.nextQuestionWatchdog);
      this.nextQuestionWatchdog = null;
    }
  }

  async start() {
    const systemText = String(this.context.system_instruction || '').trim();
    if (!systemText) throw new Error('system_instruction missing in live speech context');

    const candidates = modelCandidates(this.context);
    let lastErr = null;
    for (const model of candidates) {
      try {
        this.model = model;
        this.ready = false;
        this.closed = false;
        await this.connectOnce(systemText);
        console.log(`[relay] Gemini Live ready — model ${model}`);
        // Generate role-specific questions in the background. Warmup (mic check +
        // intro) buys ~20-40s, so the bank is usually upgraded before Q1. If it is
        // not ready in time, the seeded fallback questions are used — either way
        // the interview always has every question ready before it is asked.
        void this.generateQuestionBank();
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[relay] Gemini model ${model} failed:`, err.message);
        this.teardownWs();
      }
    }
    throw lastErr || new Error('gemini_live_setup_failed');
  }

  teardownWs() {
    this.ready = false;
    if (this.geminiWs) {
      try { this.geminiWs.removeAllListeners(); } catch (_) {}
      try {
        if (this.geminiWs.readyState === WebSocket.OPEN) this.geminiWs.close();
      } catch (_) {}
    }
    this.geminiWs = null;
  }

  connectOnce(systemText) {
    const url = `${GEMINI_WS_BASE}?key=${encodeURIComponent(this.apiKey)}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(setupTimer);
        fn(value);
      };

      const setupTimer = setTimeout(() => {
        finish(reject, new Error(
          `gemini_setup_timeout (${SETUP_TIMEOUT_MS / 1000}s) — model ${this.model} did not return setupComplete. Check GEMINI_API_KEY and live model access.`
        ));
      }, SETUP_TIMEOUT_MS);

      this.geminiWs = new WebSocket(url);

      this.geminiWs.on('open', () => {
        const setup = {
          setup: {
            model: `models/${this.model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
              },
            },
            systemInstruction: { parts: [{ text: systemText }] },
            realtimeInputConfig: {
              automaticActivityDetection: { disabled: true },
            },
            // AudioTranscriptionConfig has no fields — empty object enables transcription.
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        };
        this.geminiWs.send(JSON.stringify(setup));
      });

      this.geminiWs.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch (_) {
          return;
        }
        this.handleGeminiMessage(msg, () => finish(resolve), (err) => finish(reject, err));
      });

      this.geminiWs.on('error', (err) => {
        if (!this.ready) finish(reject, err);
        else this.onEvent({ type: 'error', message: err.message || 'gemini_ws_error' });
      });

      this.geminiWs.on('close', () => {
        this.closed = true;
        if (!this.ready && !settled) {
          finish(reject, new Error(`gemini_ws_closed before setupComplete (model ${this.model})`));
        } else {
          this.onEvent({ type: 'gemini_closed' });
        }
      });
    });
  }

  handleGeminiMessage(msg, resolveSetup, rejectSetup) {
    if (msg.setupComplete) {
      this.ready = true;
      this.onEvent({ type: 'ready', model: this.model });
      resolveSetup();
      this.kickoffInterview();
      return;
    }

    if (msg.error) {
      const message = msg.error?.message || JSON.stringify(msg.error);
      if (!this.ready) rejectSetup(new Error(message));
      else this.onEvent({ type: 'error', message });
      return;
    }

    // After the final answer we still want the closing thank-you to stream
    // (audio + caption). Forward model output, but stop capturing new turns.
    if (this.interviewEnded) {
      const closingServer = msg.serverContent;
      if (!closingServer) return;
      if (closingServer.outputTranscription?.text) {
        this.modelBuf += closingServer.outputTranscription.text;
        const closingText = sanitizeTranscript(this.modelBuf, 'model');
        if (closingText) {
          this.onEvent({ type: 'transcript', speaker: 'model', text: closingText, partial: true, closing: true });
        }
      }
      const closingParts = closingServer.modelTurn?.parts || [];
      for (const part of closingParts) {
        const inline = part.inlineData || part.inline_data;
        if (inline?.data) {
          this.onEvent({
            type: 'output_audio',
            data: inline.data,
            mimeType: inline.mimeType || inline.mime_type || 'audio/pcm;rate=24000',
          });
        }
      }
      return;
    }

    // Capture the candidate's STT internally even in voice-only mode. It is NEVER
    // shown to the candidate (appendUserTranscription gates emission on !voiceOnly),
    // but the relay needs the text to detect "repeat the question" requests and
    // non-English speech so it can stay on the SAME question instead of advancing.
    if (msg.inputTranscription?.text || msg.serverContent?.inputTranscription?.text) {
      const top = msg.inputTranscription?.text;
      const nested = msg.serverContent?.inputTranscription?.text;
      if (top) this.appendUserTranscription(top);
      if (nested && nested !== top) this.appendUserTranscription(nested);
    }

    const server = msg.serverContent;
    if (!server) return;

    // While the candidate's answer is being finalized, ignore model audio/text.
    if (!this.blockModelOutput && server.outputTranscription?.text) {
      this.modelBuf += server.outputTranscription.text;
      this.emitModelPartialTranscript();
    }

    const parts = server.modelTurn?.parts || [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data && !this.blockModelOutput) {
        this.modelAudioThisTurn = true;
        if (this.ttsOnlyTurn && this.ttsForQ >= 1) {
          try {
            this.ttsAudioBytesThisTurn += Buffer.from(inline.data, 'base64').length;
          } catch (_) {}
          this.lastModelAudioSentAt = Date.now();
          if (this.ttsTurnCompleteReceived) {
            this.clientPlaybackIdleForQ = 0;
            this.scheduleTtsAnswerWindow(this.ttsForQ, this.questions[this.ttsForQ - 1] || '');
          }
        }
        if (this.warmupPhase === 'mic_check') this.warmupAudioDelivered.mic_check = true;
        if (this.warmupPhase === 'intro') this.warmupAudioDelivered.intro = true;
        const chunk = {
          type: 'output_audio',
          data: inline.data,
          mimeType: inline.mimeType || inline.mime_type || 'audio/pcm;rate=24000',
        };
        // Stream interviewer audio live (synced with partial question text).
        if (!this.allowModelAudio) {
          this.allowModelAudio = true;
          this.flushPendingAudio();
        }
        this.onEvent(chunk);
      }
    }

    if (server.turnComplete) this.onModelTurnComplete();
    if (server.interrupted) this.onEvent({ type: 'interrupted' });
  }

  // Stream the candidate's speech-to-text to the client as a live caption.
  appendUserTranscription(text) {
    const piece = String(text || '');
    if (!piece) return;
    if (this.userTurnActive) {
      this.userBuf = appendTranscriptionChunk(this.userBuf, piece);
      this.noteUserActivity();
    } else if (this.awaitingAnswer) {
      this.lateUserBuf = appendTranscriptionChunk(this.lateUserBuf, piece);
      this.noteUserActivity();
      if (this.pendingFinalize) this.scheduleFinalizeAnswer(true);
    }
    if (this.voiceOnly) return;
    this.emitUserPartialTranscript();
  }

  emitUserPartialTranscript() {
    if (this.voiceOnly) return;
    if (!this.userTurnActive && !this.awaitingAnswer) return;
    const combined = `${this.userBuf}${this.lateUserBuf}`;
    const clean = displayUserTranscript(combined);
    if (!clean) {
      const raw = combined.trim();
      if (raw.length > 8 && !isEnglishTranscript(raw)) {
        this.onEvent({ type: 'non_english_detected', hint: 'Please answer in English only.' });
      }
      return;
    }
    this.onEvent({ type: 'transcript', speaker: 'user', text: clean, partial: true });
  }

  // Stream the interviewer's question text as Gemini speaks (output transcription).
  emitModelPartialTranscript() {
    if (this.blockModelOutput || this.interviewEnded || this.inNudgePlayback) return;
    let modelText = sanitizeTranscript(this.modelBuf, 'model');
    if (!modelText) return;

    // Warmup phases: emit partial streaming for the active warmup step.
    if (this.warmupPhase === 'mic_check' || this.warmupPhase === 'intro') {
      const wNum = this.warmupPhase === 'mic_check' ? -1 : 0;
      this.onEvent({ type: 'transcript', speaker: 'model', text: modelText, partial: true, number: wNum });
      this.onEvent({ type: 'question_partial', number: wNum, text: modelText, warmup: this.warmupPhase });
      this.streamingQuestionText = modelText;
      this.streamingQuestionNum = wNum;
      return;
    }

    // Deterministic question TTS: the committed question text was already sent.
    // Suppress partial captions so they cannot race/cancel the answer window.
    if (this.ttsOnlyTurn) return;

    // Ignore late captions only when the mic is already open for THIS question.
    if (this.answerPromptOpen && !this.inFollowUpFor) {
      const nextQ = this.roundQuestionEmitted
        ? this.questions.length
        : this.questions.length + 1;
      if (this.answerPromptFor >= nextQ) return;
    }

    if (isClosingOnlyMessage(modelText) && this.answers.length < this.maxTurns) {
      this.onEvent({ type: 'interview_closing_premature', text: modelText });
      return;
    }

    const qNum = this.inFollowUpFor
      ? this.inFollowUpFor
      : (this.roundQuestionEmitted
        ? this.questions.length
        : this.questions.length + 1);
    if (!qNum || qNum > this.maxTurns) return;

    if (this.questions.length === 0 && !this.roundQuestionEmitted) {
      modelText = stripLeadingGreeting(modelText) || modelText;
    }
    modelText = stripQuestionNumbering(modelText);
    if (!modelText) return;

    const partialText = modelText.includes('?')
      ? (extractInterviewQuestion(modelText) || modelText)
      : modelText;

    this.onEvent({
      type: 'transcript',
      speaker: 'model',
      text: partialText,
      partial: true,
      number: qNum,
    });
    this.onEvent({ type: 'question_partial', number: qNum, text: partialText });
    this.streamingQuestionText = modelText;
    this.streamingQuestionNum = qNum;
  }

  onModelTurnComplete() {
    if (this.pendingUserActivityEnd) {
      this.pendingUserActivityEnd = false;
      if (this.activityEndTurnTimer) {
        clearTimeout(this.activityEndTurnTimer);
        this.activityEndTurnTimer = null;
      }
      this.modelBuf = '';
      this.modelAudioThisTurn = false;
      if (this.deferredSpeakRequest) {
        const { qNum, opts } = this.deferredSpeakRequest;
        this.deferredSpeakRequest = null;
        setTimeout(() => {
          if (this.interviewEnded || this.closed) return;
          this.speakQuestion(qNum, opts);
        }, 450);
      }
      return;
    }

    if (this.inNudgePlayback) {
      // Nudge finished speaking — re-open the mic and start the auto-submit
      // window. If the candidate stays silent through it, we auto-submit.
      this.inNudgePlayback = false;
      this.modelBuf = '';
      this.blockModelOutput = false;
      if (this.userTurnActive && this.geminiWs?.readyState === WebSocket.OPEN) {
        this.geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      }
      this.silenceNudgedAt = Date.now();
      return;
    }

    if (this.interviewClosing && !this.interviewEnded) {
      const closingText = sanitizeTranscript(this.modelBuf, 'model').trim();
      this.modelBuf = '';
      this.modelAudioThisTurn = false;
      const words = closingText.split(/\s+/).filter(Boolean).length;
      const fullClose = /completes? the voice interview|thank you for your time|that concludes/i.test(
        closingText
      );
      if (words > 0 && words < 6 && !fullClose) {
        this.closingReprompts += 1;
        if (this.closingReprompts <= 2) {
          this.flushClientPlayback();
          this.sendClientText(
            'You only said a brief thanks. Say this complete closing sentence once: "Thank you for your time — that completes the voice interview." Then stop.',
            true
          );
          return;
        }
      }
      if (this.closingCompleteTimer) clearTimeout(this.closingCompleteTimer);
      this.closingCompleteTimer = setTimeout(() => this.finalizeInterviewClosing(), 3500);
      return;
    }

    // Deterministic question TTS finished — open the answer window only after audio.
    if (this.ttsOnlyTurn) {
      const qNum = this.ttsForQ;
      const questionText = this.questions[qNum - 1] || '';
      const hadAudio = this.modelAudioThisTurn;

      if (this.questionAudioSafety) {
        clearTimeout(this.questionAudioSafety);
        this.questionAudioSafety = null;
      }
      if (this.questionSpeakWatchdog) {
        clearTimeout(this.questionSpeakWatchdog);
        this.questionSpeakWatchdog = null;
      }

      if (!hadAudio && !this.interviewEnded && !this.closed) {
        console.warn(`[relay] Q${qNum} turnComplete without TTS audio — retrying`);
        this.retryQuestionSpeak(qNum, questionText, { flushFirst: true });
        return;
      }

      this.modelBuf = '';
      this.ttsTurnCompleteReceived = true;
      if (this.clientPlaybackIdleForQ === qNum) {
        this.tryOpenTtsAnswerWindow(qNum);
      } else {
        this.scheduleTtsAnswerWindow(qNum, questionText);
      }
      return;
    }

    if (this.awaitingAnswer) {
      const qNum = this.warmupPhase === 'mic_check'
        ? -1
        : this.warmupPhase === 'intro'
          ? 0
          : (this.answerPromptFor >= 1 ? this.answerPromptFor : this.currentQ);
      if (qNum >= 1 && this.shouldRejectPrematureAnswerEnd(qNum)) {
        console.warn(
          `[relay] ignoring premature turnComplete finalize for Q${qNum} (${this.answerWindowAgeMs()}ms, no speech yet)`
        );
        this.awaitingAnswer = false;
        if (this.pendingFinalize) {
          clearTimeout(this.pendingFinalize);
          this.pendingFinalize = null;
        }
        if (this.answerTimer) {
          clearTimeout(this.answerTimer);
          this.answerTimer = null;
        }
        if (this.answerPromptOpen && qNum >= 1) {
          this.emitAwaitingAnswer(qNum, this.questions[qNum - 1] || '');
        }
        return;
      }
      this.scheduleFinalizeAnswer();
      return;
    }

    this.emitQuestionFromBuffer();
  }

  scheduleFinalizeAnswer(restart = false, maxWaitMs = 10000) {
    if (this.pendingFinalize) {
      if (!restart) return;
      clearTimeout(this.pendingFinalize);
      this.pendingFinalize = null;
    }
    // Voice-only: PCM is primary; wait briefly for internal STT only when a repeat
    // phrase may still be forming — normal answers still finalize quickly.
    if (this.voiceOnly) {
      const startedAt = Date.now();
      const minWaitMs = 400;
      const maxWaitMs = 2000;
      let lastLen = -1;
      let stableSince = 0;
      const tick = () => {
        const transcript = this.getInternalUserTranscript();
        const len = transcript.length;
        const now = Date.now();
        const elapsed = now - startedAt;
        const qNum = this.currentQ;

        if (
          qNum >= 1 &&
          qNum <= this.maxTurns &&
          !this.questionRepeatUsed[qNum] &&
          isRepeatRequest(transcript)
        ) {
          this.pendingFinalize = null;
          this.completeAnswerTurn();
          return;
        }

        if (len > 0 && len === lastLen) {
          if (!stableSince) stableSince = now;
          if (now - stableSince >= 450 && elapsed >= minWaitMs) {
            this.pendingFinalize = null;
            this.completeAnswerTurn();
            return;
          }
        } else {
          stableSince = 0;
          lastLen = len;
        }

        if (elapsed >= minWaitMs) {
          const repeatPending =
            qNum >= 1 &&
            qNum <= this.maxTurns &&
            !this.questionRepeatUsed[qNum] &&
            mightBeRepeatRequest(transcript);
          if (!repeatPending) {
            this.pendingFinalize = null;
            this.completeAnswerTurn();
            return;
          }
        }

        if (elapsed >= maxWaitMs) {
          this.pendingFinalize = null;
          this.completeAnswerTurn();
          return;
        }

        this.pendingFinalize = setTimeout(tick, 150);
      };
      this.pendingFinalize = setTimeout(tick, minWaitMs);
      return;
    }
    const startedAt = Date.now();
    let lastLen = -1;
    let stableSince = 0;

    const tick = () => {
      const combined = `${this.userBuf}${this.lateUserBuf}`;
      const len = combined.length;
      const now = Date.now();

      if (len > 0 && len === lastLen) {
        if (!stableSince) stableSince = now;
        // Transcript stable for 0.9s — safe to finalize.
        if (now - stableSince >= 900) {
          this.pendingFinalize = null;
          this.completeAnswerTurn();
          return;
        }
      } else {
        stableSince = 0;
        lastLen = len;
      }

      // Hard cap — never wait more than maxWaitMs for transcription flush.
      // Audio is already buffered for end-of-interview scoring, so a short cap
      // keeps the question-to-question gap snappy.
      if (now - startedAt >= maxWaitMs) {
        this.pendingFinalize = null;
        this.completeAnswerTurn();
        return;
      }

      this.pendingFinalize = setTimeout(tick, 200);
    };

    this.pendingFinalize = setTimeout(tick, 400);
  }

  hasVoiceCapture(pcmChunks = this.answerPcmChunks) {
    if (Array.isArray(pcmChunks) && pcmChunks.length > 0) return true;
    return this.voiceDetectedThisTurn;
  }

  resolveUserAnswerText(pcmChunks = this.answerPcmChunks) {
    if (this.voiceOnly) {
      return this.hasVoiceCapture(pcmChunks)
        ? '[Voice response recorded]'
        : '[No spoken response captured]';
    }
    const combined = `${this.userBuf}${this.lateUserBuf}`.trim();
    this.userBuf = '';
    this.lateUserBuf = '';
    return cleanUserAnswer(combined) || '[No spoken response captured]';
  }

  getInternalUserTranscript() {
    return `${this.userBuf}${this.lateUserBuf}`.trim();
  }

  resetAnswerTurnForRetry() {
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }
    if (this.pendingFinalize) {
      clearTimeout(this.pendingFinalize);
      this.pendingFinalize = null;
    }
    this.answerPcmChunks = [];
    this.userBuf = '';
    this.lateUserBuf = '';
    this.voiceDetectedThisTurn = false;
    this.awaitingAnswer = false;
    this.blockModelOutput = true;
    this.stopSilenceMonitor();
    this.clearAnswerPromptWindow();
    if (this.userTurnActive) {
      this.userTurnActive = false;
      if (this.geminiWs?.readyState === WebSocket.OPEN) {
        this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
      }
    }
  }

  handleRepeatRequest(qNum) {
    this.resetAnswerTurnForRetry();
    this.questionRepeatUsed[qNum] = true;
    this.questionRepeatCount[qNum] = (this.questionRepeatCount[qNum] || 0) + 1;
    console.log(
      `[relay] Q${qNum} repeat requested — re-speaking SAME question ` +
        `(${this.questionRepeatCount[qNum]}/${this.maxQuestionRepeats})`
    );
    this.onEvent({ type: 'question_repeat', number: qNum });
    // Stay on the same question number — speakQuestion(qNum) re-asks without
    // recording an answer or advancing the phase. Preface with a warm
    // "No problem, let me repeat the question." acknowledgement.
    this.speakQuestion(qNum, { prefaceRepeat: true });
  }

  tryHandleRepeatRequest(activeQ) {
    if (activeQ < 1 || activeQ > this.maxTurns) return false;
    if (this.warmupPhase) return false;
    if ((this.questionRepeatCount[activeQ] || 0) >= this.maxQuestionRepeats) return false;
    if (!isRepeatRequest(this.getInternalUserTranscript())) return false;
    this.handleRepeatRequest(activeQ);
    return true;
  }

  // Candidate explicitly asked to move on ("I don't know this — next question").
  // Record a no-answer for this question (scored as a non-attempt) and advance,
  // exactly like a normal answer so the 5-question flow and scoring stay intact.
  handleSkipRequest(qNum) {
    console.log(`[relay] Q${qNum} skipped by candidate — advancing to next question`);
    this.stopSilenceMonitor();
    this.awaitingAnswer = false;
    this.blockModelOutput = true;
    if (this.answerTimer) { clearTimeout(this.answerTimer); this.answerTimer = null; }
    if (this.pendingFinalize) { clearTimeout(this.pendingFinalize); this.pendingFinalize = null; }

    this.userBuf = '';
    this.lateUserBuf = '';
    this.voiceDetectedThisTurn = false;
    this.answerPcmChunks = [];

    const skipText = '[No answer — candidate chose to skip this question]';
    const qLimits = this.questionTimeLimits[qNum]
      || fallbackTimeLimit(this.questions[qNum - 1] || '', this.context);

    let aNum;
    if (this.inFollowUpFor && this.inFollowUpFor === this.answers.length) {
      aNum = this.inFollowUpFor;
      this.answers[aNum - 1] = `${this.answers[aNum - 1]}\n\n[Follow-up] ${skipText}`.trim();
      this.inFollowUpFor = 0;
    } else {
      this.answers.push(skipText);
      aNum = this.answers.length;
    }
    this.skippedTurns = this.skippedTurns || {};
    this.skippedTurns[aNum] = true;

    const turnPair = {
      phase: this.maxQuestions + aNum,
      voice_question_number: aNum,
      question_text: this.questions[aNum - 1] || '',
      answer_text: skipText,
      answer_pcm_chunks: [],
      answer_pcm_sample_rate: this._answerPcmSampleRate,
      sent_at: new Date(this.startedAt + (aNum - 1) * 60000).toISOString(),
      received_at: new Date().toISOString(),
      time_limit_seconds: qLimits.seconds,
      complexity_tier: qLimits.tier,
      is_follow_up: false,
      skipped: true,
      stt_source: this.voiceOnly ? 'voice_pcm' : 'gemini_live',
    };
    this.answerPcmChunksByTurn[aNum] = [];

    if (!this.voiceOnly) {
      this.onEvent({ type: 'transcript', speaker: 'user', text: skipText, partial: false });
    }
    this.onEvent({ type: 'answer', number: aNum, text: skipText, skipped: true });
    this.onEvent({ type: 'turn_complete', turn: aNum, maxTurns: this.maxTurns, answersGiven: aNum });
    this.onEvent({ type: 'saving_turn', number: aNum });
    void Promise.resolve(this.onTurnSaved(turnPair)).catch((err) => {
      console.warn('[relay] skip turn save failed:', err.message);
    });

    this.proceedAfterAnswer(aNum);
  }

  tryHandleSkipRequest(activeQ) {
    if (activeQ < 1 || activeQ > this.maxTurns) return false;
    if (this.warmupPhase) return false;
    if (!isSkipRequest(this.getInternalUserTranscript())) return false;
    this.handleSkipRequest(activeQ);
    return true;
  }

  // Candidate answered (or partly answered) in a non-English language. Keep them
  // on the SAME question: politely ask them to continue in English and re-read the
  // question. Never record this as their answer and never advance the phase.
  handleNonEnglishResponse(qNum) {
    this.resetAnswerTurnForRetry();
    this.nonEnglishNudgeCount[qNum] = (this.nonEnglishNudgeCount[qNum] || 0) + 1;
    console.log(
      `[relay] Q${qNum} non-English response — asking to continue in English, ` +
        `staying on SAME question (${this.nonEnglishNudgeCount[qNum]}/${this.maxNonEnglishNudges})`
    );
    // Reuse the existing client status handler ("Please answer in English only.").
    this.onEvent({ type: 'non_english_detected', number: qNum, hint: 'Please continue in English.' });
    this.onEvent({ type: 'language_nudge', number: qNum });
    this.speakQuestion(qNum, { prefaceEnglishNudge: true });
  }

  tryHandleNonEnglishResponse(activeQ) {
    if (activeQ < 1 || activeQ > this.maxTurns) return false;
    if (this.warmupPhase) return false;
    if ((this.nonEnglishNudgeCount[activeQ] || 0) >= this.maxNonEnglishNudges) return false;
    const transcript = this.getInternalUserTranscript();
    // Need real speech to classify — empty transcript = silence/STT miss, not a
    // language problem (handled by the silence nudge / no-response path instead).
    const words = transcript.split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;
    if (isEnglishTranscript(transcript)) return false;
    this.handleNonEnglishResponse(activeQ);
    return true;
  }

  // Candidate answered in English but clearly off-topic (e.g. a random
  // counter-question). Keep them on the SAME question with a warm redirection.
  handleIrrelevantResponse(qNum) {
    this.resetAnswerTurnForRetry();
    this.irrelevantRedirectCount[qNum] = (this.irrelevantRedirectCount[qNum] || 0) + 1;
    console.log(
      `[relay] Q${qNum} off-topic answer — redirecting to SAME question ` +
        `(${this.irrelevantRedirectCount[qNum]}/${this.maxIrrelevantRedirects})`
    );
    this.onEvent({ type: 'answer_off_topic', number: qNum });
    this.speakQuestion(qNum, { prefaceIrrelevant: true });
  }

  shouldCheckRelevance(qNum, transcript) {
    if (!this.relevanceGuardEnabled || this.maxIrrelevantRedirects < 1) return false;
    if (this.warmupPhase || qNum < 1 || qNum > this.maxTurns) return false;
    if ((this.irrelevantRedirectCount[qNum] || 0) >= this.maxIrrelevantRedirects) return false;
    const words = String(transcript || '').split(/\s+/).filter(Boolean);
    // Too little to judge → accept (silence/short answers handled elsewhere).
    if (words.length < 3) return false;
    // Non-English is handled by the language nudge, not the relevance guard.
    if (!isEnglishTranscript(transcript)) return false;
    return true;
  }

  // Fast on-topic check via the text model. Tight timeout; ACCEPTS (returns true)
  // on any failure so the interview never stalls on the classifier.
  async classifyAnswerRelevance(questionText, transcript) {
    const apiKey = this.apiKey || process.env.GEMINI_API_KEY;
    const q = String(questionText || '').trim();
    const a = String(transcript || '').trim();
    if (!apiKey || !q || !a) return true;
    const model = String(
      this.context.gemini_text_model || process.env.GEMINI_TEXT_MODEL || TEXT_MODEL_DEFAULT
    ).replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const prompt =
      `You are screening a spoken interview answer for basic on-topic relevance.\n` +
      `Interview question: "${q.slice(0, 300)}"\n` +
      `Candidate's answer (speech transcript, may be imperfect): "${a.slice(0, 500)}"\n\n` +
      `Decide if the answer is a genuine ATTEMPT to address the question. A weak, short, ` +
      `uncertain, rambling, or "I don't know" answer STILL counts as on-topic (relevant=true). ` +
      `Mark relevant=false ONLY when the response is clearly off-topic: unrelated chatter, a ` +
      `random counter-question, or something with nothing to do with the question (for example ` +
      `asking "who is the prime minister of Pakistan" when that was not the question).\n` +
      `Return JSON only: {"relevant": true} or {"relevant": false}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      }).finally(() => clearTimeout(t));
      if (!res.ok) return true;
      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
      }
      if (parsed && typeof parsed.relevant === 'boolean') return parsed.relevant;
      return true;
    } catch (_) {
      return true;
    }
  }

  async completeAnswerTurn() {
    if (!this.awaitingAnswer || this.relevanceChecking) return;
    if (
      this.pendingAnswerGeneration != null &&
      this.pendingAnswerGeneration !== this.activeAnswerGeneration
    ) {
      console.warn('[relay] stale answer finalize ignored — question changed');
      this.awaitingAnswer = false;
      return;
    }
    const activeQ = this.warmupPhase === 'mic_check'
      ? -1
      : this.warmupPhase === 'intro'
        ? 0
        : (this.answerPromptFor >= 1
          ? this.answerPromptFor
          : (this.currentQ >= 1 ? this.currentQ : Math.max(1, this.answers.length + 1)));
    if (this.shouldRejectPrematureAnswerEnd(activeQ)) {
      console.warn(
        `[relay] rejecting premature empty answer for Q${activeQ} (${this.answerWindowAgeMs()}ms)`
      );
      this.awaitingAnswer = false;
      if (this.pendingFinalize) {
        clearTimeout(this.pendingFinalize);
        this.pendingFinalize = null;
      }
      if (this.answerTimer) {
        clearTimeout(this.answerTimer);
        this.answerTimer = null;
      }
      if (this.answerPromptOpen && activeQ >= 1) {
        this.emitAwaitingAnswer(activeQ, this.questions[activeQ - 1] || '');
      }
      return;
    }
    this.stopSilenceMonitor();

    // Mic may still be open — close the Gemini activity window.
    if (this.userTurnActive) {
      this.userTurnActive = false;
      if (this.geminiWs?.readyState === WebSocket.OPEN) {
        this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
        // Establish the clean barrier: the model owes us a turnComplete for this
        // activityEnd. The next speakQuestion will DEFER behind it so the question
        // audio never mixes with the model's reaction to the answer (the cause of
        // "half question then the real question").
        this.pendingUserActivityEnd = true;
        this.scheduleActivityEndTurnFallback();
      }
      this.userTurnEndedAt = Date.now();
      // Voice-only: PCM is already buffered — never wait on Gemini STT flush.
      // Waiting here was causing Q3→Q4 stalls when activityEnd turnComplete lagged.
      if (!this.voiceOnly) {
        this.scheduleFinalizeAnswer();
        return;
      }
    }

    this.awaitingAnswer = false;
    this.blockModelOutput = true;
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }

    this.modelBuf = '';
    if (this.micCheckAdvanceTimer) {
      clearTimeout(this.micCheckAdvanceTimer);
      this.micCheckAdvanceTimer = null;
    }

    const pcmSnapshot = this.answerPcmChunks.slice();

    // ── Mic check phase: any speech = mic confirmed → advance to intro ──
    if (this.warmupPhase === 'mic_check') {
      this.userBuf = '';
      this.lateUserBuf = '';
      let userText = this.resolveUserAnswerText(pcmSnapshot);
      this.voiceDetectedThisTurn = false;
      this.clearAnswerPromptWindow();
      this.warmupPhase = 'intro';
      if (!this.voiceOnly) {
        this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
      }
      this.onEvent({ type: 'answer', number: -1, text: userText, warmup: 'mic_check' });
      this.onEvent({ type: 'warmup_phase', phase: 'intro' });
      this.roundQuestionEmitted = false;
      this.streamingQuestionText = '';
      this.streamingQuestionNum = 0;
      this.modelBuf = '';
      this.modelAudioThisTurn = false;
      this.introQuestionAsked = false;
      this.warmupAudioDelivered.intro = false;
      this.allowModelAudio = true;
      this.pendingAudioChunks = [];
      this.blockModelOutput = false;
      this.flushClientPlayback();
      const introPrompt = this.buildIntroPrompt();
      this.sendSpokenPrompt(introPrompt, { flushFirst: false });
      this.scheduleWarmupWatchdog('intro');
      return;
    }

    // ── Intro phase: candidate answered intro → start real questions ──
    if (this.warmupPhase === 'intro') {
      this.userBuf = '';
      this.lateUserBuf = '';
      let userText = this.resolveUserAnswerText(pcmSnapshot);
      this.voiceDetectedThisTurn = false;
      this.clearAnswerPromptWindow();
      this.warmupPhase = null;
      if (!this.voiceOnly) {
        this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
      }
      this.onEvent({ type: 'answer', number: 0, text: userText, warmup: 'intro' });
      this.roundQuestionEmitted = false;
      this.streamingQuestionText = '';
      this.streamingQuestionNum = 0;
      this.onEvent({ type: 'warmup_phase', phase: null });
      // Deterministic hand-off: the relay now drives Q1..QN itself.
      this.speakQuestion(1);
      return;
    }

    if (this.tryHandleRepeatRequest(activeQ)) return;
    // Candidate explicitly asked to skip → record a no-answer and advance.
    if (this.tryHandleSkipRequest(activeQ)) return;
    if (this.tryHandleNonEnglishResponse(activeQ)) return;

    // Capture the internal STT BEFORE buffers are cleared — used for the off-topic
    // relevance check and to flag non-English answers for zero-scoring.
    const internalTranscript = this.getInternalUserTranscript();

    // Off-topic guard: if the (English) answer is clearly unrelated to the
    // question, gently redirect and stay on the SAME question. Bounded so a
    // false positive only ever costs ONE gentle re-ask.
    if (this.shouldCheckRelevance(activeQ, internalTranscript)) {
      this.relevanceChecking = true;
      let relevant = true;
      try {
        relevant = await this.classifyAnswerRelevance(this.questions[activeQ - 1] || '', internalTranscript);
      } catch (_) {
        relevant = true;
      }
      this.relevanceChecking = false;
      if (this.interviewEnded || this.closed) return;
      if (!relevant) {
        this.handleIrrelevantResponse(activeQ);
        return;
      }
    }

    // A non-English answer that survived the language nudges is scored ZERO at the
    // end — the interview must be conducted in English.
    const answerWords = internalTranscript.split(/\s+/).filter(Boolean);
    const answerNonEnglish = answerWords.length >= 2 && !isEnglishTranscript(internalTranscript);

    this.userBuf = '';
    this.lateUserBuf = '';
    let userText = this.resolveUserAnswerText(pcmSnapshot);
    this.voiceDetectedThisTurn = false;

    let aNum;
    let isFollowUpResponse = false;

    if (this.inFollowUpFor && this.inFollowUpFor === this.answers.length) {
      isFollowUpResponse = true;
      aNum = this.inFollowUpFor;
      const idx = aNum - 1;
      const merged = `${this.answers[idx]}\n\n[Follow-up] ${userText}`.trim();
      this.answers[idx] = merged;
      userText = merged;
      this.inFollowUpFor = 0;
    } else {
      this.answers.push(userText);
      aNum = this.answers.length;
    }

    // Flag a non-English answer so the end-of-interview scoring gives it ZERO.
    if (answerNonEnglish) this.nonEnglishTurns[aNum] = true;

    // Snapshot + clear the PCM buffer for this answer turn.
    const pcmChunks = pcmSnapshot.length ? pcmSnapshot : this.answerPcmChunks.slice();
    this.answerPcmChunks = [];
    if (this.voiceOnly) {
      userText = this.resolveUserAnswerText(pcmChunks);
    }

    const qLimits = this.questionTimeLimits[aNum] || fallbackTimeLimit(this.questions[aNum - 1] || '', this.context);
    const turnPair = {
      phase: this.maxQuestions + aNum,
      voice_question_number: aNum,
      question_text: this.questions[aNum - 1] || '',
      answer_text: userText,
      answer_pcm_chunks: pcmChunks,
      answer_pcm_sample_rate: this._answerPcmSampleRate,
      sent_at: new Date(this.startedAt + (aNum - 1) * 60000).toISOString(),
      received_at: new Date().toISOString(),
      time_limit_seconds: qLimits.seconds,
      complexity_tier: qLimits.tier,
      is_follow_up: isFollowUpResponse,
      non_english: !!this.nonEnglishTurns[aNum],
      stt_source: this.voiceOnly ? 'voice_pcm' : 'gemini_live',
    };
    // Store for buildTurnPairs final-pass fallback.
    this.answerPcmChunksByTurn[aNum] = pcmChunks;

    if (!this.voiceOnly) {
      this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
    }
    this.onEvent({ type: 'answer', number: aNum, text: userText, follow_up: isFollowUpResponse });
    this.onEvent({
      type: 'turn_complete',
      turn: aNum,
      maxTurns: this.maxTurns,
      answersGiven: aNum,
      follow_up: isFollowUpResponse,
    });

    // Save + score in the background — NEVER block the next question on it.
    this.onEvent({ type: 'saving_turn', number: aNum, follow_up: isFollowUpResponse });
    void Promise.resolve(this.onTurnSaved(turnPair)).catch((err) => {
      console.warn('[relay] turn save/score failed:', err.message);
    });

    this.proceedAfterAnswer(aNum);
  }

  // Decide next step using a fast transcript heuristic (no score wait):
  //  - weak/short answer (not already followed-up) → one cross-question
  //  - otherwise → next numbered question (with optional coaching) or finish
  proceedAfterAnswer(aNum) {
    this.clearAnswerPromptWindow();
    this.roundQuestionEmitted = false;
    this.streamingQuestionText = '';
    this.streamingQuestionNum = 0;
    this.inFollowUpFor = 0;

    // Deterministic: move straight to the next question or finish. No follow-up
    // branch, no waiting on Gemini to decide — progression is relay-owned.
    if (aNum >= this.maxTurns) {
      if (this.answers.length < this.maxTurns) {
        console.warn(
          `[relay] blocked early finish — only ${this.answers.length}/${this.maxTurns} answers recorded`
        );
        return;
      }
      this.finishInterview();
      return;
    }
    this.speakQuestion(aNum + 1);
  }

  askFollowUp(qNum, questionText, answerText) {
    this.clearAnswerPromptWindow();
    this.modelBuf = '';
    this.allowModelAudio = true;
    this.pendingAudioChunks = [];
    this.blockModelOutput = false;
    this.awaitingAnswer = false;
    this.roundQuestionEmitted = false;
    this.sendSpokenPrompt(this.buildFollowUpPrompt(qNum, questionText, answerText));
    this.scheduleFollowUpWatchdog(qNum);
    // Safety: if emitQuestionFromBuffer never commits the follow-up (Gemini stalls),
    // force awaiting_answer so the candidate can still answer and the interview proceeds.
    this.scheduleAnswerWindowSafety(qNum);
  }

  scheduleFollowUpWatchdog(qNum) {
    if (this.nextQuestionWatchdog) clearTimeout(this.nextQuestionWatchdog);
    this.nextQuestionWatchdog = setTimeout(() => {
      this.nextQuestionWatchdog = null;
      if (this.interviewEnded || this.closed || this.inFollowUpFor !== qNum || this.awaitingAnswer) return;
      const fallback =
        `Could you walk me through a specific example related to your previous answer on question ${qNum}?`;
      this.commitQuestionText(qNum, fallback, { follow_up: true });
    }, 12000);
  }

  proceedToNextQuestion(aNum, nextQ) {
    this.modelBuf = '';
    this.allowModelAudio = true;
    this.pendingAudioChunks = [];
    this.blockModelOutput = false;
    this.sendSpokenPrompt(this.buildNextQuestionPrompt(aNum, nextQ));
    this.scheduleNextQuestionWatchdog(nextQ);
    this.scheduleAnswerWindowSafety(nextQ);
  }

  // ---- Relay-side silence handling (transcript-driven) -------------------
  // Mark the candidate as active whenever new speech is transcribed. This is
  // the authoritative "are they speaking?" signal — far more reliable than the
  // client's raw mic level, which stays low for soft-spoken candidates.
  noteUserActivity() {
    this.lastUserActivityAt = Date.now();
    if (this.silenceNudged) {
      this.silenceNudged = false;
      this.silenceNudgedAt = 0;
    }
    // Mic check: the moment any speech is transcribed, schedule auto-advance.
    // We give 1.5s buffer so the candidate can finish even one short phrase.
    if (
      this.warmupPhase === 'mic_check' &&
      this.userTurnActive &&
      !this.micCheckAdvanceTimer &&
      (this.voiceOnly ? this.voiceDetectedThisTurn : this.userBuf.trim().length > 0)
    ) {
      this.micCheckAdvanceTimer = setTimeout(() => {
        this.micCheckAdvanceTimer = null;
        if (this.warmupPhase === 'mic_check' && this.userTurnActive) {
          this.stopSilenceMonitor();
          this.endUserTurn();
        }
      }, 1500);
    }
  }

  cancelNudgeForUserSpeech() {
    if (!this.inNudgePlayback) return;
    this.inNudgePlayback = false;
    this.silenceNudged = false;
    this.silenceNudgedAt = 0;
    this.modelBuf = '';
    this.blockModelOutput = true;
    this.lastUserActivityAt = Date.now();
    if (this.userTurnActive && this.geminiWs?.readyState === WebSocket.OPEN) {
      this.geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    }
  }

  startSilenceMonitor() {
    this.stopSilenceMonitor();
    // During mic-check the advancement is handled by noteUserActivity — no timer needed.
    if (!this.silenceConfig.enabled || this.warmupPhase === 'mic_check') return;
    this.lastUserActivityAt = Date.now();
    this.silenceNudged = false;
    this.silenceNudgedAt = 0;
    this.silenceMonitor = setInterval(() => this.tickSilence(), 700);
  }

  stopSilenceMonitor() {
    if (this.silenceMonitor) {
      clearInterval(this.silenceMonitor);
      this.silenceMonitor = null;
    }
    this.silenceNudged = false;
    this.silenceNudgedAt = 0;
  }

  tickSilence() {
    if (this.interviewEnded || this.closed) {
      this.stopSilenceMonitor();
      return;
    }
    // Only watch while the mic is genuinely open and we are not mid-nudge.
    if (!this.userTurnActive || this.inNudgePlayback) return;

    const now = Date.now();
    const sinceActivity = now - this.lastUserActivityAt;

    if (!this.silenceNudged) {
      if (sinceActivity >= this.silenceConfig.nudgeMs) {
        this.speakSilenceNudge();
      }
      return;
    }

    // Already nudged. Auto-submit only if they stayed silent through the nudge.
    // During the intro warm-up, we never auto-submit — candidate must press Submit.
    if (
      this.warmupPhase !== 'intro' &&
      this.silenceNudgedAt &&
      now - this.silenceNudgedAt >= this.silenceConfig.autoMs &&
      this.lastUserActivityAt <= this.silenceNudgedAt
    ) {
      this.stopSilenceMonitor();
      this.onEvent({ type: 'silence_nudge', stage: 'auto_submit' });
      this.endUserTurn();
    }
  }

  // Speak the nudge in the interviewer's own voice. We briefly close the user
  // activity window so Gemini produces a clean spoken turn, then re-open it.
  speakSilenceNudge() {
    if (this.inNudgePlayback || !this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;
    this.silenceNudged = true;
    this.inNudgePlayback = true;
    const nudgeText = this.context.silence_nudge_text ||
      "Take your time — whenever you're ready, please go ahead and share your answer.";

    if (this.userTurnActive && this.geminiWs.readyState === WebSocket.OPEN) {
      this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    }
    this.modelBuf = '';
    this.blockModelOutput = false;
    this.allowModelAudio = true;
    this.pendingAudioChunks = [];
    // Tell the client to allow interviewer audio even though the mic is "open".
    this.onEvent({ type: 'silence_nudge', stage: 'nudge', text: nudgeText });
    this.sendClientText(
      `[SILENCE NUDGE — the candidate has gone quiet. Say ONLY this one warm, professional English sentence and nothing else: "${nudgeText}"]`,
      true
    );
  }

  resolveModelTextAfterTurn() {
    const hadAudio = this.modelAudioThisTurn;
    this.modelAudioThisTurn = false;
    let modelText = sanitizeTranscript(this.modelBuf, 'model');
    this.modelBuf = '';

    if (modelText) return { modelText, spokeThisTurn: hadAudio };

    const streamed = this.streamingQuestionText
      ? String(this.streamingQuestionText).trim()
      : '';
    if (streamed) {
      modelText = extractInterviewQuestion(streamed) || streamed;
      if (modelText) return { modelText, spokeThisTurn: hadAudio || true };
    }

    if (hadAudio && !this.inFollowUpFor && this.questions.length < this.maxTurns && !this.warmupPhase) {
      return {
        modelText: fallbackInterviewQuestion(this.questions.length + 1, this.maxTurns),
        spokeThisTurn: true,
      };
    }

    return { modelText: '', spokeThisTurn: hadAudio };
  }

  emitQuestionFromBuffer() {
    let { modelText, spokeThisTurn } = this.resolveModelTextAfterTurn();
    if (!modelText) {
      if (this.warmupPhase === 'mic_check' || this.warmupPhase === 'intro') {
        this.retryWarmupSpeak(this.warmupPhase);
      }
      return;
    }

    // ── Warmup phases ────────────────────────────────────────────────────────
    if (this.warmupPhase === 'mic_check' || this.warmupPhase === 'intro') {
      if (!spokeThisTurn) {
        this.retryWarmupSpeak(this.warmupPhase);
        return;
      }
      const wNum = this.warmupPhase === 'mic_check' ? -1 : 0;
      if (this.warmupPhase === 'intro') this.introQuestionAsked = true;
      if (this.kickoffWatchdog) {
        clearTimeout(this.kickoffWatchdog);
        this.kickoffWatchdog = null;
      }
      this.clearNextQuestionWatchdog();
      this.streamingQuestionText = '';
      this.streamingQuestionNum = 0;
      this.onEvent({ type: 'transcript', speaker: 'model', text: modelText, partial: false, number: wNum });
      this.onEvent({ type: 'question', number: wNum, text: modelText, warmup: this.warmupPhase });
      this.emitAwaitingAnswer(wNum, modelText, { warmup: this.warmupPhase });
      return;
    }

    if (this.inFollowUpFor) {
      if (!spokeThisTurn) {
        const qNum = this.inFollowUpFor;
        console.warn(`[relay] follow-up for Q${qNum} had no audible output — re-prompting`);
        this.roundQuestionEmitted = false;
        this.blockModelOutput = false;
        this.allowModelAudio = true;
        this.flushClientPlayback();
        const qText = this.questions[qNum - 1] || '';
        const aText = this.answers[qNum - 1] || '';
        this.sendClientText(this.buildFollowUpPrompt(qNum, qText, aText), true);
        this.scheduleFollowUpWatchdog(qNum);
        return;
      }
      const qNum = this.inFollowUpFor;
      const streamed = this.streamingQuestionNum === qNum ? this.streamingQuestionText : '';
      modelText = extractInterviewQuestion(
        stripQuestionNumbering(resolveCommittedQuestionText(streamed, modelText))
      ) || stripQuestionNumbering(resolveCommittedQuestionText(streamed, modelText));
      if (this.questions.length >= qNum) {
        this.questions[qNum - 1] = modelText;
      } else {
        while (this.questions.length < qNum - 1) this.questions.push('');
        this.questions.push(modelText);
      }
      this.roundQuestionEmitted = true;
      this.clearNextQuestionWatchdog();
      this.onEvent({ type: 'transcript', speaker: 'model', text: modelText, partial: false, number: qNum });
      this.onEvent({ type: 'question', number: qNum, text: modelText, follow_up: true });
      this.emitAwaitingAnswer(qNum, modelText, { follow_up: true });
      return;
    }

    const expectedQ = this.questions.length + 1;
    const streamed = this.streamingQuestionNum === expectedQ ? this.streamingQuestionText : '';
    modelText = resolveCommittedQuestionText(streamed, modelText);
    modelText = stripQuestionNumbering(modelText);
    if (this.questions.length === 0) {
      modelText = stripLeadingGreeting(modelText) || modelText;
    }
    modelText = extractInterviewQuestion(modelText) || modelText;

    // Gemini sometimes closes early (e.g. thank-you as "Q5") — reject and re-prompt.
    if (!this.interviewEnded && isClosingOnlyMessage(modelText) && this.answers.length < this.maxTurns) {
      const streamQ = extractInterviewQuestion(streamed) || streamed;
      if (streamQ.includes('?') && streamQ.split(/\s+/).filter(Boolean).length >= 6) {
        modelText = streamQ;
      } else {
        this.prematureClosingReprompts += 1;
        console.warn(
          `[relay] premature closing at Q${expectedQ} (answers=${this.answers.length}), reprompt #${this.prematureClosingReprompts}`
        );
        this.roundQuestionEmitted = false;
        if (this.prematureClosingReprompts <= 3) {
          this.blockModelOutput = false;
          this.allowModelAudio = true;
          this.flushClientPlayback();
          this.sendClientText(this.buildClosingReprompt(expectedQ), true);
          return;
        }
        modelText = fallbackInterviewQuestion(expectedQ, this.maxTurns);
        console.warn(`[relay] using fallback question for Q${expectedQ}`);
      }
    }

    if (!this.roundQuestionEmitted && this.questions.length < this.maxTurns) {
      if (!spokeThisTurn) {
        const streamQ = this.streamingQuestionNum === expectedQ ? this.streamingQuestionText : '';
        const streamText = extractInterviewQuestion(streamQ) || String(streamQ || '').trim();
        if (streamText && (streamText.includes('?') || streamText.split(/\s+/).filter(Boolean).length >= 8)) {
          console.warn(`[relay] Q${expectedQ} turnComplete before audio flag — committing streamed text`);
          modelText = streamText;
        } else {
          console.warn(`[relay] Q${expectedQ} turn had no audible output — re-prompting`);
          this.roundQuestionEmitted = false;
          this.blockModelOutput = false;
          this.allowModelAudio = true;
          this.flushClientPlayback();
          const prevA = Math.max(0, expectedQ - 1);
          this.sendClientText(this.buildNextQuestionPrompt(prevA, expectedQ), true);
          this.scheduleNextQuestionWatchdog(expectedQ);
          return;
        }
      }
      this.questions.push(modelText);
      this.roundQuestionEmitted = true;
      if (this.kickoffWatchdog) {
        clearTimeout(this.kickoffWatchdog);
        this.kickoffWatchdog = null;
      }
      const qNum = this.questions.length;
      this.clearNextQuestionWatchdog();
      this.onEvent({ type: 'transcript', speaker: 'model', text: modelText, partial: false, number: qNum });
      this.onEvent({ type: 'question', number: qNum, text: modelText });
      this.emitAwaitingAnswer(qNum, modelText);
    } else if (this.roundQuestionEmitted && this.questions.length && !this.answerPromptOpen) {
      const idx = this.questions.length - 1;
      const resolved = extractInterviewQuestion(resolveCommittedQuestionText(streamed, modelText)) ||
        resolveCommittedQuestionText(streamed, modelText);
      if (resolved && resolved !== this.questions[idx]) {
        this.questions[idx] = resolved;
        this.onEvent({ type: 'question', number: idx + 1, text: resolved });
        this.onEvent({
          type: 'transcript',
          speaker: 'model',
          text: resolved,
          partial: false,
          number: idx + 1,
        });
        this.emitAwaitingAnswer(idx + 1, resolved);
      } else if (!this.answerPromptOpen) {
        this.emitAwaitingAnswer(idx + 1, this.questions[idx] || resolved);
      }
    }
  }

  flushPendingAudio() {
    for (const chunk of this.pendingAudioChunks) {
      this.onEvent(chunk);
    }
    this.pendingAudioChunks = [];
  }

  finishInterview() {
    if (this.interviewEnded || this.interviewClosing) return;
    if (this.answers.length < this.maxTurns) {
      console.warn(
        `[relay] finishInterview blocked — only ${this.answers.length}/${this.maxTurns} answers`
      );
      return;
    }
    if (this.answerPromptOpen && this.answerPromptFor === this.maxTurns) {
      console.warn('[relay] finishInterview blocked — still awaiting final answer');
      return;
    }
    this.interviewClosing = true;
    this.closingReprompts = 0;
    this.clearAnswerPromptWindow();
    this.blockModelOutput = false;
    this.allowModelAudio = true;
    this.pendingAudioChunks = [];
    this.flushClientPlayback();
    this.onEvent({ type: 'interview_closing' });
    this.sendClientText(
      `The candidate has now answered all ${this.maxTurns} interview questions. Say ONE warm closing sentence in English only, such as: "Thank you for your time — that completes the voice interview." Do not ask any more questions. Do not add a second thank-you.`,
      true
    );
  }

  finalizeInterviewClosing() {
    if (this.interviewEnded) return;
    this.interviewEnded = true;
    if (this.closingCompleteTimer) {
      clearTimeout(this.closingCompleteTimer);
      this.closingCompleteTimer = null;
    }
    this.onEvent({ type: 'interview_complete', turn: this.maxTurns, maxTurns: this.maxTurns });
    setTimeout(() => this.closeGemini(), 8000);
  }

  sendClientText(text, turnComplete = true) {
    if (!this.ready || this.closed || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    const clean = String(text || '').trim();
    if (!clean) return;
    this.modelAudioThisTurn = false;
    this.geminiWs.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: clean }] }],
          turnComplete,
        },
      })
    );
  }

  kickoffInterview() {
    this.allowModelAudio = true;
    this.pendingAudioChunks = [];
    if (this.warmupPhase === 'mic_check') {
      this.sendSpokenPrompt(this.buildMicCheckPrompt());
    } else if (this.warmupPhase === 'intro') {
      this.sendSpokenPrompt(this.buildIntroPrompt());
    } else {
      this.sendSpokenPrompt(String(this.context.kickoff_prompt || DEFAULT_KICKOFF).trim());
    }
    this.onEvent({ type: 'interviewer_started' });

    if (this.kickoffWatchdog) clearTimeout(this.kickoffWatchdog);
    this.kickoffWatchdog = setTimeout(() => {
      // Still waiting on the very first interviewer turn?
      const openingDone =
        (this.warmupPhase === 'mic_check' && this.answerPromptOpen) ||
        (this.warmupPhase === 'intro' && this.introQuestionAsked) ||
        (!this.warmupPhase && this.questions.length > 0);
      if (openingDone || this.interviewEnded || this.closed) return;
      console.warn('[relay] kickoff watchdog — no opening turn yet, retrying');
      this.modelBuf = '';
      this.allowModelAudio = true;
      this.blockModelOutput = false;
      const retryPrompt = this.warmupPhase === 'mic_check'
        ? 'Greet the candidate in one short English sentence, then ask them to say a few words to confirm the microphone. Stop after that and wait.'
        : this.warmupPhase === 'intro'
          ? 'Ask the candidate to briefly introduce themselves in one short sentence, then stop and wait.'
          : 'You have not asked question 1 yet. Ask interview question 1 now — one question only — then stop talking.';
      this.sendClientText(retryPrompt, true);
    }, 18000);
  }

  startUserTurn() {
    if (!this.ready || this.closed || this.interviewEnded || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (this.userTurnActive) return;
    // Stale awaitingAnswer from a prior half-finished turn must not block a new answer.
    if (this.awaitingAnswer) {
      if (!this.answerPromptOpen) return;
      this.awaitingAnswer = false;
      if (this.pendingFinalize) {
        clearTimeout(this.pendingFinalize);
        this.pendingFinalize = null;
      }
      if (this.answerTimer) {
        clearTimeout(this.answerTimer);
        this.answerTimer = null;
      }
    }
    this.userTurnActive = true;
    this.userBuf = '';
    this.lateUserBuf = '';
    this.voiceDetectedThisTurn = false;
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    this.startSilenceMonitor();
  }

  endUserTurn() {
    if (!this.ready || this.closed || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    // Scoring now happens once at the end from the buffered audio, so progression
    // must NOT wait on Gemini transcription. The candidate pressed Submit — move on.
    if (!this.userTurnActive) {
      // Client sent end without a successful start — still finalize if answer window open.
      if (this.answerPromptOpen && !this.interviewEnded) {
        const qNum = this.warmupPhase === 'mic_check'
          ? -1
          : this.warmupPhase === 'intro'
            ? 0
            : (this.answerPromptFor >= 1 ? this.answerPromptFor : this.currentQ);
        if (qNum >= 1 && this.shouldRejectPrematureAnswerEnd(qNum)) {
          console.warn(
            `[relay] ignoring stale user_turn_end for Q${qNum} (${this.answerWindowAgeMs()}ms, no speech yet)`
          );
          return;
        }
        this.pendingAnswerGeneration = this.activeAnswerGeneration;
        this.awaitingAnswer = true;
        this.blockModelOutput = true;
        this.userTurnEndedAt = Date.now();
        this.scheduleFinalizeAnswer(false, 2500);
        if (this.answerTimer) clearTimeout(this.answerTimer);
        this.answerTimer = setTimeout(() => {
          if (!this.awaitingAnswer || this.interviewEnded) return;
          this.completeAnswerTurn();
        }, 4000);
      }
      return;
    }
    this.stopSilenceMonitor();
    this.userTurnActive = false;
    this.pendingAnswerGeneration = this.activeAnswerGeneration;
    this.awaitingAnswer = true;
    this.blockModelOutput = true;
    this.userTurnEndedAt = Date.now();
    this.pendingUserActivityEnd = true;
    this.scheduleActivityEndTurnFallback();
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    this.scheduleFinalizeAnswer(false, 2500);

    if (this.answerTimer) clearTimeout(this.answerTimer);
    // Hard fallback: finalize quickly even if Gemini never sends turnComplete.
    this.answerTimer = setTimeout(() => {
      if (!this.awaitingAnswer || this.interviewEnded) return;
      this.completeAnswerTurn();
    }, 4000);
  }

  sendAudio(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
    if (!this.ready || this.closed || this.interviewEnded || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    const canCapture = this.userTurnActive || this.awaitingAnswer || this.answerPromptOpen;
    if (!canCapture) return;

    // Auto-start turn on first speech while answer window is open (covers missed user_turn_start).
    if (!this.userTurnActive && !this.awaitingAnswer && this.answerPromptOpen && !this.inNudgePlayback) {
      this.userTurnActive = true;
      this.userBuf = '';
      this.lateUserBuf = '';
      if (this.geminiWs.readyState === WebSocket.OPEN) {
        this.geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      }
      this.startSilenceMonitor();
    }

    // Measure RMS energy of the PCM chunk. If above background-noise level,
    // treat it as the candidate speaking and reset the silence timer.
    let rms = 0;
    try {
      const pcmBuf = Buffer.from(base64Pcm, 'base64');
      const samples = pcmBuf.length >> 1;
      if (samples > 0) {
        let sumSq = 0;
        for (let i = 0; i < samples; i++) {
          const s = pcmBuf.readInt16LE(i * 2);
          sumSq += s * s;
        }
        rms = Math.sqrt(sumSq / samples);
        if (rms > 50) {
          this.voiceDetectedThisTurn = true;
          if (this.inNudgePlayback) this.cancelNudgeForUserSpeech();
          this.noteUserActivity();
        }
      }
    } catch (_) { /* decoding failure — ignore */ }

    // During nudge playback with no detected speech, pause forwarding so Gemini can finish the nudge.
    if (this.inNudgePlayback) return;

    // Buffer PCM for end-of-interview scoring (real questions only, not warmup).
    // Buffer whenever the answer window is open — not only after userTurnActive —
    // so voice is captured even if user_turn_start was missed on the client.
    // Cap at 120 s (120 * 1000ms/256ms ≈ 469 chunks of 4096 samples @ 16 kHz).
    if (this.warmupPhase === null && (this.userTurnActive || this.answerPromptOpen)) {
      this.answerPcmChunks.push(base64Pcm);
      if (this.answerPcmChunks.length > 469) this.answerPcmChunks.shift();
    }

    this.geminiWs.send(
      JSON.stringify({ realtimeInput: { audio: { mimeType, data: base64Pcm } } })
    );
  }

  closeGemini() {
    this.clearNextQuestionWatchdog();
    this.stopSilenceMonitor();
    if (this.micCheckAdvanceTimer) {
      clearTimeout(this.micCheckAdvanceTimer);
      this.micCheckAdvanceTimer = null;
    }
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }
    if (this.pendingFinalize) {
      clearTimeout(this.pendingFinalize);
      this.pendingFinalize = null;
    }
    if (this.closingCompleteTimer) {
      clearTimeout(this.closingCompleteTimer);
      this.closingCompleteTimer = null;
    }
    if (this.geminiWs && this.geminiWs.readyState === WebSocket.OPEN) {
      try {
        this.geminiWs.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      } catch (_) {}
      this.geminiWs.close();
    }
    this.geminiWs = null;
    this.closed = true;
  }

  buildTurnPairs() {
    const count = Math.min(Math.max(this.questions.length, this.answers.length), this.maxTurns);
    const turns = [];
    for (let i = 0; i < count; i += 1) {
      turns.push({
        phase: this.maxQuestions + 1 + i,
        voice_question_number: i + 1,
        question_text: this.questions[i] || '',
        answer_text: this.answers[i] || '',
        answer_pcm_chunks: this.answerPcmChunksByTurn[i + 1] || [],
        answer_pcm_sample_rate: this._answerPcmSampleRate,
        non_english: !!this.nonEnglishTurns[i + 1],
        stt_source: this.voiceOnly ? 'voice_pcm' : 'gemini_live',
        sent_at: new Date(this.startedAt + i * 60000).toISOString(),
        received_at: new Date().toISOString(),
      });
    }
    return turns;
  }
}

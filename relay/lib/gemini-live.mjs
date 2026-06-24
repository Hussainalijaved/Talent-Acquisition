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

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const DEFAULT_MODEL = 'gemini-2.0-flash-live-001';
const MODEL_FALLBACKS = [
  'gemini-2.0-flash-live-001',
  'gemini-2.5-flash-native-audio-preview-12-2025',
];
const SETUP_TIMEOUT_MS = 15000;
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

    this.modelBuf = '';
    this.userBuf = '';
    this.lateUserBuf = '';

    this.roundQuestionEmitted = false;
    this.awaitingAnswer = false;
    this.answerPromptOpen = false;
    this.answerPromptFor = 0;
    this.blockModelOutput = false;
    this.userTurnActive = false;
    this.answerTimer = null;
    this.pendingFinalize = null;
    this.userTurnEndedAt = 0;
    this.pendingAudioChunks = [];
    this.allowModelAudio = false;

    this.maxTurns = Number(context.speech_phases || 5);
    this.maxQuestions = Number(context.max_questions || 5);
    this.prematureClosingReprompts = 0;
    this.nextQuestionWatchdog = null;
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
      minWords: Number(context.followup_min_words ?? 12),
      followUpEnabled: context.follow_up_enabled !== false,
      coachingEnabled: context.coaching_enabled !== false,
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
    // Transcription-free UI: flow must not depend on output captions. Track
    // whether the model actually spoke audio this turn so we can still commit
    // questions and open the mic when captions are empty.
    this.modelAudioThisTurn = false;
    this.interviewClosing = false;
    this.warmupSpeakRetries = { mic_check: 0, intro: 0 };
    this.warmupAudioDelivered = { mic_check: false, intro: false };
    this.closingReprompts = 0;
    this.closingCompleteTimer = null;
  }

  timerConfig() {
    return buildTimerConfig(this.context);
  }

  syncQuestionTimeLimit(questionText) {
    return deriveTimeLimitSeconds(null, null, questionText, this.timerConfig());
  }

  emitAwaitingAnswer(qNum, questionText, opts = {}) {
    if (this.answerPromptOpen && this.answerPromptFor === qNum) return;
    // Fresh PCM buffer for every real question turn.
    if (qNum >= 1) this.answerPcmChunks = [];
    const isWarmup = !!(opts.warmup || qNum <= 0);
    const limits = isWarmup
      ? { seconds: Number(this.context.intro_answer_seconds || 90), tier: 'warmup' }
      : this.syncQuestionTimeLimit(questionText);
    this.questionTimeLimits[qNum] = limits;
    this.answerPromptOpen = true;
    this.answerPromptFor = qNum;
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
    }, 12000);
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
    this.emitUserPartialTranscript();
  }

  emitUserPartialTranscript() {
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

    if (this.awaitingAnswer) {
      this.scheduleFinalizeAnswer();
      return;
    }

    this.emitQuestionFromBuffer();
  }

  scheduleFinalizeAnswer(restart = false) {
    if (this.pendingFinalize) {
      if (!restart) return;
      clearTimeout(this.pendingFinalize);
      this.pendingFinalize = null;
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
        // Transcript stable for 1.1s — safe to finalize.
        if (now - stableSince >= 1100) {
          this.pendingFinalize = null;
          this.completeAnswerTurn();
          return;
        }
      } else {
        stableSince = 0;
        lastLen = len;
      }

      // Hard cap — never wait more than 10s for transcription flush.
      if (now - startedAt >= 10000) {
        this.pendingFinalize = null;
        this.completeAnswerTurn();
        return;
      }

      this.pendingFinalize = setTimeout(tick, 200);
    };

    this.pendingFinalize = setTimeout(tick, 500);
  }

  completeAnswerTurn() {
    if (!this.awaitingAnswer) return;
    this.stopSilenceMonitor();

    // Mic may still be open (auto-open) — close activity so transcription flushes.
    if (this.userTurnActive) {
      this.userTurnActive = false;
      if (this.geminiWs?.readyState === WebSocket.OPEN) {
        this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
      }
      this.userTurnEndedAt = Date.now();
      this.scheduleFinalizeAnswer();
      return;
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

    const combined = `${this.userBuf}${this.lateUserBuf}`.trim();
    this.userBuf = '';
    this.lateUserBuf = '';
    let userText = cleanUserAnswer(combined) || '[No spoken response captured]';

    // ── Mic check phase: any speech = mic confirmed → advance to intro ──
    if (this.warmupPhase === 'mic_check') {
      this.clearAnswerPromptWindow();
      this.warmupPhase = 'intro';
      this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
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
      this.clearAnswerPromptWindow();
      this.warmupPhase = null;
      this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
      this.onEvent({ type: 'answer', number: 0, text: userText, warmup: 'intro' });
      this.roundQuestionEmitted = false;
      this.streamingQuestionText = '';
      this.streamingQuestionNum = 0;
      this.onEvent({ type: 'warmup_phase', phase: null });
      this.modelBuf = '';
      this.allowModelAudio = true;
      this.pendingAudioChunks = [];
      this.blockModelOutput = false;
      this.flushClientPlayback();
      this.onEvent({ type: 'next_question_ready', number: 1 });
      this.sendSpokenPrompt(this.buildFirstQuestionPrompt(), { flushFirst: false });
      this.scheduleNextQuestionWatchdog(1);
      return;
    }

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

    // Snapshot + clear the PCM buffer for this answer turn.
    const pcmChunks = this.answerPcmChunks.slice();
    this.answerPcmChunks = [];

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
    };
    // Store for buildTurnPairs final-pass fallback.
    this.answerPcmChunksByTurn[aNum] = pcmChunks;

    this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
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

    this.proceedAfterAnswer(aNum, userText, turnPair);
  }

  // Decide next step using a fast transcript heuristic (no score wait):
  //  - weak/short answer (not already followed-up) → one cross-question
  //  - otherwise → next numbered question (with optional coaching) or finish
  proceedAfterAnswer(aNum, userText, turnPair) {
    this.clearAnswerPromptWindow();
    this.roundQuestionEmitted = false;
    this.streamingQuestionText = '';
    this.streamingQuestionNum = 0;

    const weak = this.isWeakAnswer(userText);

    if (
      this.coachingConfig.followUpEnabled &&
      !turnPair.is_follow_up &&
      !this.followUpUsed[aNum] &&
      weak
    ) {
      this.followUpUsed[aNum] = true;
      this.inFollowUpFor = aNum;
      this.onEvent({ type: 'follow_up_probe', number: aNum, maxTurns: this.maxTurns });
      this.askFollowUp(aNum, turnPair.question_text, userText);
      return;
    }

    // Coaching on the NEXT question reflects whether this answer was weak.
    this.lastAnswerWeak = weak;

    if (aNum >= this.maxTurns) {
      this.finishInterview();
      return;
    }

    const nextQ = aNum + 1;
    this.onEvent({ type: 'next_question_ready', number: nextQ });
    this.proceedToNextQuestion(aNum, nextQ);
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
      this.userBuf.trim().length > 0
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
    const { modelText, spokeThisTurn } = this.resolveModelTextAfterTurn();
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
    if (this.awaitingAnswer) return;
    this.userTurnActive = true;
    this.userBuf = '';
    this.lateUserBuf = '';
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    this.startSilenceMonitor();
  }

  endUserTurn() {
    if (!this.ready || this.closed || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (!this.userTurnActive) return;
    this.stopSilenceMonitor();
    this.userTurnActive = false;
    this.awaitingAnswer = true;
    this.blockModelOutput = true;
    this.userTurnEndedAt = Date.now();
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    this.scheduleFinalizeAnswer();

    if (this.answerTimer) clearTimeout(this.answerTimer);
    // Fallback: finalize after flush window even if model never sends turnComplete.
    this.answerTimer = setTimeout(() => {
      if (!this.awaitingAnswer || this.interviewEnded) return;
      this.completeAnswerTurn();
    }, 15000);
  }

  sendAudio(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
    if (!this.ready || this.closed || this.interviewEnded || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    const canCapture = this.userTurnActive || this.awaitingAnswer;
    if (!canCapture) return;

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
        if (rms > 120) {
          if (this.inNudgePlayback) this.cancelNudgeForUserSpeech();
          this.noteUserActivity();
        }
      }
    } catch (_) { /* decoding failure — ignore */ }

    // During nudge playback with no detected speech, pause forwarding so Gemini can finish the nudge.
    if (this.inNudgePlayback) return;

    // Buffer PCM for audio-primary scoring (real questions only, not warmup).
    // Cap at 120 s (120 * 1000ms/256ms ≈ 469 chunks of 4096 samples @ 16 kHz).
    if (this.userTurnActive && this.warmupPhase === null) {
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
        sent_at: new Date(this.startedAt + i * 60000).toISOString(),
        received_at: new Date().toISOString(),
      });
    }
    return turns;
  }
}

import WebSocket from 'ws';
import {
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

    // Silence / follow-up / coaching (Micro1-style)
    this.silenceNudgeCount = 0;
    this.inNudgePlayback = false;
    this.followUpUsed = {};
    this.inFollowUpFor = 0;
    this.lastAnswerMeta = null;
    this.coachingConfig = {
      weakScoreThreshold: Number(context.weak_score_threshold ?? 55),
      coachingScoreThreshold: Number(context.coaching_score_threshold ?? 60),
      followUpEnabled: context.follow_up_enabled !== false,
      coachingEnabled: context.coaching_enabled !== false,
    };
  }

  timerConfig() {
    return buildTimerConfig(this.context);
  }

  syncQuestionTimeLimit(questionText) {
    return deriveTimeLimitSeconds(null, null, questionText, this.timerConfig());
  }

  emitAwaitingAnswer(qNum, questionText) {
    const limits = this.syncQuestionTimeLimit(questionText);
    this.questionTimeLimits[qNum] = limits;
    this.onEvent({
      type: 'awaiting_answer',
      number: qNum,
      maxTurns: this.maxTurns,
      time_limit_seconds: limits.seconds,
      complexity_tier: limits.tier,
    });
    this.refineQuestionTimeLimit(qNum, questionText);
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

  buildNextQuestionPrompt(aNum, nextQ) {
    let coaching = '';
    const meta = this.lastAnswerMeta;
    if (
      this.coachingConfig.coachingEnabled &&
      meta &&
      meta.qNum === aNum &&
      meta.score != null &&
      meta.score < this.coachingConfig.coachingScoreThreshold
    ) {
      coaching =
        ' Before question ' +
        nextQ +
        ', give ONE brief supportive coaching line (never mention scores or say they failed) — e.g. encourage a specific example or clearer structure — then ask the next question. Keep coaching + question within 3 sentences total. ';
    }

    if (nextQ >= this.maxTurns) {
      return (
        coaching +
        `The candidate finished answering question ${aNum}. You MUST ask interview question ${nextQ} of ${this.maxTurns} now — this is the LAST question before the interview ends. ` +
        'Ask exactly one new behavioural interview question in clear English. Do NOT thank the candidate. Do NOT say the interview is complete. Do NOT say goodbye or "we will be in touch". Ask the question only, then stop and wait.'
      );
    }
    return (
      coaching +
      `The candidate finished answering question ${aNum}. Now ask interview question ${nextQ} of ${this.maxTurns} in clear English. ` +
      'Ask exactly one question, then stop talking and wait for the candidate. Do not thank or close the interview yet.'
    );
  }

  buildFollowUpPrompt(qNum, questionText, answerText, scored) {
    const hint = String(scored?.feedback || '').slice(0, 160);
    return (
      `The candidate's answer to question ${qNum} was incomplete or unclear (internal note — never mention scoring). ` +
      `Original question: "${String(questionText || '').slice(0, 220)}" ` +
      `Their answer: "${String(answerText || '').slice(0, 280)}" ` +
      (hint ? `Internal feedback: ${hint}. ` : '') +
      `Ask ONE short follow-up probe on the SAME topic so they can clarify or give a concrete example. ` +
      `Do NOT move to question ${qNum + 1} yet. One follow-up only, then stop and wait.`
    );
  }

  isWeakAnswer(userText, score) {
    const t = String(userText || '').trim();
    if (/^\[(no spoken|non-english|no speech|noise)/i.test(t)) return false;
    if (t.split(/\s+/).filter(Boolean).length < 8) return true;
    if (Number.isFinite(Number(score)) && Number(score) < this.coachingConfig.weakScoreThreshold) return true;
    return false;
  }

  buildClosingReprompt(expectedQ) {
    return (
      `You spoke a closing or thank-you message too early. The interview is NOT finished yet. ` +
      `Ask interview question ${expectedQ} of ${this.maxTurns} now — one clear behavioural question only. ` +
      'Do NOT thank the candidate. Do NOT say the interview is complete. Then stop and wait.'
    );
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
    const modelText = String(text || '').trim();
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
    this.emitAwaitingAnswer(qNum, modelText);
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

    if (msg.inputTranscription?.text) {
      if (this.userTurnActive) {
        this.userBuf += msg.inputTranscription.text;
      } else if (this.awaitingAnswer) {
        // Transcription can arrive after activityEnd — keep for this answer turn.
        this.lateUserBuf += msg.inputTranscription.text;
      }
      this.emitUserPartialTranscript();
    }

    const server = msg.serverContent;
    if (!server) return;

    if (server.inputTranscription?.text) {
      if (this.userTurnActive) {
        this.userBuf += server.inputTranscription.text;
      } else if (this.awaitingAnswer) {
        this.lateUserBuf += server.inputTranscription.text;
      }
      this.emitUserPartialTranscript();
    }

    // While the candidate's answer is being finalized, ignore model audio/text.
    if (!this.blockModelOutput && server.outputTranscription?.text) {
      this.modelBuf += server.outputTranscription.text;
      this.emitModelPartialTranscript();
    }

    const parts = server.modelTurn?.parts || [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data && !this.blockModelOutput) {
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
    if (this.blockModelOutput || this.interviewEnded) return;
    let modelText = sanitizeTranscript(this.modelBuf, 'model');
    if (!modelText) return;
    if (isClosingOnlyMessage(modelText) && this.answers.length < this.maxTurns) {
      this.onEvent({ type: 'interview_closing_premature', text: modelText });
      return;
    }

    const qNum = this.roundQuestionEmitted
      ? this.questions.length
      : this.questions.length + 1;
    if (!qNum || qNum > this.maxTurns) return;

    if (this.questions.length === 0 && !this.roundQuestionEmitted) {
      modelText = stripLeadingGreeting(modelText) || modelText;
    }
    if (!modelText) return;

    this.onEvent({
      type: 'transcript',
      speaker: 'model',
      text: modelText,
      partial: true,
      number: qNum,
    });
    this.onEvent({ type: 'question_partial', number: qNum, text: modelText });
    this.streamingQuestionText = modelText;
    this.streamingQuestionNum = qNum;
  }

  onModelTurnComplete() {
    if (this.inNudgePlayback) {
      this.inNudgePlayback = false;
      this.modelBuf = '';
      this.blockModelOutput = false;
      return;
    }

    if (this.awaitingAnswer) {
      this.scheduleFinalizeAnswer();
      return;
    }

    this.emitQuestionFromBuffer();
  }

  scheduleFinalizeAnswer() {
    if (this.pendingFinalize) return;
    const startedAt = Date.now();
    let lastLen = -1;
    let stableSince = 0;

    const tick = () => {
      const combined = `${this.userBuf}${this.lateUserBuf}`;
      const len = combined.length;
      const now = Date.now();

      if (len > 0 && len === lastLen) {
        if (!stableSince) stableSince = now;
        // Transcript stable for 900ms — safe to finalize.
        if (now - stableSince >= 900) {
          this.pendingFinalize = null;
          this.completeAnswerTurn();
          return;
        }
      } else {
        stableSince = 0;
        lastLen = len;
      }

      // Hard cap — never wait more than 8s for transcription flush.
      if (now - startedAt >= 8000) {
        this.pendingFinalize = null;
        this.completeAnswerTurn();
        return;
      }

      this.pendingFinalize = setTimeout(tick, 250);
    };

    this.pendingFinalize = setTimeout(tick, 600);
  }

  async completeAnswerTurn() {
    if (!this.awaitingAnswer) return;

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
    this.silenceNudgeCount = 0;

    const combined = `${this.userBuf}${this.lateUserBuf}`.trim();
    this.userBuf = '';
    this.lateUserBuf = '';
    let userText = cleanUserAnswer(combined) || '[No spoken response captured]';

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

    const qLimits = this.questionTimeLimits[aNum] || fallbackTimeLimit(this.questions[aNum - 1] || '', this.context);
    const turnPair = {
      phase: this.maxQuestions + aNum,
      voice_question_number: aNum,
      question_text: this.questions[aNum - 1] || '',
      answer_text: userText,
      sent_at: new Date(this.startedAt + (aNum - 1) * 60000).toISOString(),
      received_at: new Date().toISOString(),
      time_limit_seconds: qLimits.seconds,
      complexity_tier: qLimits.tier,
      is_follow_up: isFollowUpResponse,
    };

    this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
    this.onEvent({ type: 'answer', number: aNum, text: userText, follow_up: isFollowUpResponse });
    this.onEvent({
      type: 'turn_complete',
      turn: aNum,
      maxTurns: this.maxTurns,
      answersGiven: aNum,
      follow_up: isFollowUpResponse,
    });

    this.onEvent({ type: 'saving_turn', number: aNum, follow_up: isFollowUpResponse });
    let scored = null;
    try {
      scored = await Promise.resolve(this.onTurnSaved(turnPair));
    } catch (err) {
      console.warn('[relay] turn save/score failed:', err.message);
    }

    await this.afterAnswerScored(aNum, userText, turnPair, scored);
  }

  async afterAnswerScored(aNum, userText, turnPair, scored) {
    const score = Number(scored?.score);
    const hasScore = Number.isFinite(score);

    this.roundQuestionEmitted = false;
    this.streamingQuestionText = '';
    this.streamingQuestionNum = 0;

    if (
      this.coachingConfig.followUpEnabled &&
      !turnPair.is_follow_up &&
      !this.followUpUsed[aNum] &&
      this.isWeakAnswer(userText, hasScore ? score : null)
    ) {
      this.followUpUsed[aNum] = true;
      this.inFollowUpFor = aNum;
      this.onEvent({ type: 'follow_up_probe', number: aNum, maxTurns: this.maxTurns });
      this.askFollowUp(aNum, turnPair.question_text, userText, scored);
      return;
    }

    this.lastAnswerMeta = {
      score: hasScore ? score : null,
      feedback: scored?.feedback || '',
      question: turnPair.question_text,
      answer: userText,
      qNum: aNum,
    };

    if (aNum >= this.maxTurns) {
      this.finishInterview();
      return;
    }

    const nextQ = aNum + 1;
    this.onEvent({ type: 'next_question_ready', number: nextQ });
    this.proceedToNextQuestion(aNum, nextQ);
  }

  askFollowUp(qNum, questionText, answerText, scored) {
    this.modelBuf = '';
    this.allowModelAudio = true;
    this.pendingAudioChunks = [];
    this.blockModelOutput = false;
    this.awaitingAnswer = false;
    this.roundQuestionEmitted = true;
    this.sendClientText(this.buildFollowUpPrompt(qNum, questionText, answerText, scored), true);
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
    this.sendClientText(this.buildNextQuestionPrompt(aNum, nextQ), true);
    this.scheduleNextQuestionWatchdog(nextQ);
  }

  handleCandidateSilent({ stage } = {}) {
    if (!this.awaitingAnswer || this.interviewEnded || this.closed) return;
    if (!this.userTurnActive) return;

    if (stage === 'auto_submit') {
      void this.completeAnswerTurn();
      return;
    }

    if (this.silenceNudgeCount >= 1) return;
    this.silenceNudgeCount += 1;
    const text = "Take your time — when you're ready, please share your thoughts.";
    this.onEvent({ type: 'silence_nudge', text, stage: 'nudge' });
    this.playInterviewerNudge(text);
  }

  playInterviewerNudge(nudgeText) {
    if (this.inNudgePlayback || !this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;
    this.inNudgePlayback = true;
    this.blockModelOutput = false;
    this.allowModelAudio = true;
    this.sendClientText(
      `[INTERVIEWER NUDGE — the candidate has been silent for 5 seconds. Say ONLY this one warm professional English sentence, nothing else: "${nudgeText}"]`,
      true
    );
  }

  emitQuestionFromBuffer() {
    let modelText = sanitizeTranscript(this.modelBuf, 'model');
    this.modelBuf = '';
    if (!modelText) return;

    if (this.inFollowUpFor) {
      const qNum = this.inFollowUpFor;
      const streamed = this.streamingQuestionNum === qNum ? this.streamingQuestionText : '';
      modelText = resolveCommittedQuestionText(streamed, modelText);
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
      this.emitAwaitingAnswer(qNum, modelText);
      return;
    }

    const expectedQ = this.questions.length + 1;
    const streamed = this.streamingQuestionNum === expectedQ ? this.streamingQuestionText : '';
    modelText = resolveCommittedQuestionText(streamed, modelText);
    if (this.questions.length === 0) {
      modelText = stripLeadingGreeting(modelText) || modelText;
    }

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
          this.sendClientText(this.buildClosingReprompt(expectedQ), true);
          return;
        }
        modelText = fallbackInterviewQuestion(expectedQ, this.maxTurns);
        console.warn(`[relay] using fallback question for Q${expectedQ}`);
      }
    }

    if (!this.roundQuestionEmitted && this.questions.length < this.maxTurns) {
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
    } else if (this.roundQuestionEmitted && this.questions.length) {
      const idx = this.questions.length - 1;
      const merged = resolveCommittedQuestionText(
        `${this.questions[idx]} ${streamed}`.trim(),
        `${this.questions[idx]} ${modelText}`.replace(/\s+/g, ' ').trim()
      );
      this.questions[idx] = merged;
      this.onEvent({ type: 'question', number: idx + 1, text: this.questions[idx] });
      this.onEvent({
        type: 'transcript',
        speaker: 'model',
        text: this.questions[idx],
        partial: false,
        number: idx + 1,
      });
    }
  }

  flushPendingAudio() {
    for (const chunk of this.pendingAudioChunks) {
      this.onEvent(chunk);
    }
    this.pendingAudioChunks = [];
  }

  finishInterview() {
    if (this.interviewEnded) return;
    this.interviewEnded = true;
    // Unblock so the closing thank-you message is actually spoken + transcribed.
    this.blockModelOutput = false;
    this.allowModelAudio = true;
    this.pendingAudioChunks = [];
    this.onEvent({ type: 'interview_closing' });
    this.onEvent({ type: 'interview_complete', turn: this.maxTurns, maxTurns: this.maxTurns });
    this.sendClientText(
      `The candidate has now answered all ${this.maxTurns} interview questions. In one warm, short sentence, thank the candidate by saying something like "Thank you for your time — that completes the voice interview." Do not ask any more questions and do not say anything after the thank-you.`,
      true
    );
    setTimeout(() => this.closeGemini(), 8000);
  }

  sendClientText(text, turnComplete = true) {
    if (!this.ready || this.closed || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    const clean = String(text || '').trim();
    if (!clean) return;
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
    const prompt = String(this.context.kickoff_prompt || DEFAULT_KICKOFF).trim();
    this.sendClientText(prompt, true);
    this.onEvent({ type: 'interviewer_started' });

    if (this.kickoffWatchdog) clearTimeout(this.kickoffWatchdog);
    this.kickoffWatchdog = setTimeout(() => {
      if (this.questions.length > 0 || this.interviewEnded || this.closed) return;
      console.warn('[relay] kickoff watchdog — no Q1 yet, retrying');
      this.modelBuf = '';
      this.allowModelAudio = true;
      this.blockModelOutput = false;
      this.sendClientText(
        'You have not asked question 1 yet. Greet the candidate in one short English sentence, then ask interview question 1. Ask exactly one question and stop talking.',
        true
      );
    }, 18000);
  }

  startUserTurn() {
    if (!this.ready || this.closed || this.interviewEnded || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (this.userTurnActive) return;
    this.userTurnActive = true;
    this.userBuf = '';
    this.lateUserBuf = '';
    this.silenceNudgeCount = 0;
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
  }

  endUserTurn() {
    if (!this.ready || this.closed || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (!this.userTurnActive) return;
    this.userTurnActive = false;
    this.awaitingAnswer = true;
    this.blockModelOutput = true;
    this.userTurnEndedAt = Date.now();
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));

    if (this.answerTimer) clearTimeout(this.answerTimer);
    // Fallback: finalize after flush window even if model never sends turnComplete.
    this.answerTimer = setTimeout(() => {
      if (!this.awaitingAnswer || this.interviewEnded) return;
      this.completeAnswerTurn();
    }, 12000);
  }

  sendAudio(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
    if (!this.ready || this.closed || this.interviewEnded || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (!this.userTurnActive) return;
    this.geminiWs.send(
      JSON.stringify({ realtimeInput: { audio: { mimeType, data: base64Pcm } } })
    );
  }

  closeGemini() {
    this.clearNextQuestionWatchdog();
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }
    if (this.pendingFinalize) {
      clearTimeout(this.pendingFinalize);
      this.pendingFinalize = null;
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
        sent_at: new Date(this.startedAt + i * 60000).toISOString(),
        received_at: new Date().toISOString(),
      });
    }
    return turns;
  }
}

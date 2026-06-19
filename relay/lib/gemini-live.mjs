import WebSocket from 'ws';
import { isEnglishTranscript, sanitizeTranscript } from './transcript-utils.mjs';

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
  const raw = String(text || '').trim();
  if (!raw) return '';
  const sanitized = sanitizeTranscript(raw, 'user');
  if (sanitized) return sanitized;
  if (raw.length > 3 && !isEnglishTranscript(raw)) {
    return '[Non-English response — please answer in English]';
  }
  return sanitized || raw;
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
      this.userBuf += msg.inputTranscription.text;
      this.emitUserPartialTranscript();
    }

    const server = msg.serverContent;
    if (!server) return;

    if (server.inputTranscription?.text) {
      this.userBuf += server.inputTranscription.text;
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
    const clean = sanitizeTranscript(this.userBuf, 'user');
    if (!clean) {
      const raw = String(this.userBuf || '').trim();
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
  }

  onModelTurnComplete() {
    if (this.awaitingAnswer) {
      this.scheduleFinalizeAnswer();
      return;
    }

    this.emitQuestionFromBuffer();
  }

  scheduleFinalizeAnswer() {
    if (this.pendingFinalize) return;
    // Wait for Gemini to flush input transcription — first turn (Q1) often lags.
    const sinceEnd = this.userTurnEndedAt ? Date.now() - this.userTurnEndedAt : 9999;
    const minFlushMs = 3500;
    const delay = Math.max(minFlushMs - sinceEnd, 800);
    this.pendingFinalize = setTimeout(() => {
      this.pendingFinalize = null;
      this.completeAnswerTurn();
    }, delay);
  }

  async completeAnswerTurn() {
    if (!this.awaitingAnswer) return;
    this.awaitingAnswer = false;
    // Keep model output blocked until this turn is saved AND the next prompt is sent,
    // so the interviewer never speaks the next question before the current one is saved.
    this.blockModelOutput = true;
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }

    this.modelBuf = '';

    const userText = cleanUserAnswer(this.userBuf) || '[No spoken response captured]';
    this.userBuf = '';

    this.answers.push(userText);
    const aNum = this.answers.length;
    const turnPair = {
      phase: this.maxQuestions + aNum,
      voice_question_number: aNum,
      question_text: this.questions[aNum - 1] || '',
      answer_text: userText,
      sent_at: new Date(this.startedAt + (aNum - 1) * 60000).toISOString(),
      received_at: new Date().toISOString(),
    };

    // 1. Show the answer on the frontend immediately (instant UX).
    this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
    this.onEvent({ type: 'answer', number: aNum, text: userText });
    this.onEvent({
      type: 'turn_complete',
      turn: aNum,
      maxTurns: this.maxTurns,
      answersGiven: aNum,
    });

    // 2. Save in background — never block the next question.
    this.onEvent({ type: 'saving_turn', number: aNum });
    void Promise.resolve(this.onTurnSaved(turnPair)).catch((err) => {
      console.warn('[relay] incremental turn save failed:', err.message);
    });

    this.roundQuestionEmitted = false;

    // 3. Last question? Close the interview with a thank-you message.
    if (aNum >= this.maxTurns) {
      this.finishInterview();
      return;
    }

    // 4. Ask the next question immediately (do not wait for save/score).
    const nextQ = aNum + 1;
    this.onEvent({ type: 'next_question_ready', number: nextQ });

    // 5. Prompt Gemini for the next question right away.
    this.modelBuf = '';
    this.allowModelAudio = true;
    this.pendingAudioChunks = [];
    this.blockModelOutput = false;
    this.sendClientText(
      `The candidate finished answering question ${aNum}. Now ask interview question ${nextQ} of ${this.maxTurns} in clear English. Ask exactly one question, then stop talking and wait for the candidate.`,
      true
    );
  }

  emitQuestionFromBuffer() {
    let modelText = sanitizeTranscript(this.modelBuf, 'model');
    this.modelBuf = '';
    if (!modelText) return;

    if (!this.roundQuestionEmitted && this.questions.length < this.maxTurns) {
      if (this.questions.length === 0) modelText = stripLeadingGreeting(modelText) || modelText;
      this.questions.push(modelText);
      this.roundQuestionEmitted = true;
      if (this.kickoffWatchdog) {
        clearTimeout(this.kickoffWatchdog);
        this.kickoffWatchdog = null;
      }
      const qNum = this.questions.length;
      this.onEvent({ type: 'transcript', speaker: 'model', text: modelText, partial: false, number: qNum });
      this.onEvent({ type: 'question', number: qNum, text: modelText });
      this.onEvent({ type: 'awaiting_answer', number: qNum, maxTurns: this.maxTurns });
    } else if (this.roundQuestionEmitted && this.questions.length) {
      const idx = this.questions.length - 1;
      this.questions[idx] = `${this.questions[idx]} ${modelText}`.replace(/\s+/g, ' ').trim();
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

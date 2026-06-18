import WebSocket from 'ws';
import { sanitizeTranscript } from './transcript-utils.mjs';

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const DEFAULT_MODEL = 'gemini-2.0-flash-live-001';
const DEFAULT_KICKOFF =
  'Begin the interview now. In the SAME turn, greet the candidate in one short sentence and then ask interview question 1. Ask exactly one question, then stop talking and wait. Do not say anything else.';

function stripLeadingGreeting(text) {
  return String(text || '')
    .replace(
      /^(hi|hello|hey|welcome|good (morning|afternoon|evening)|thanks for joining|thank you for joining|great to (meet|have) you|let's begin|let's get started|to start|first|alright|okay|so)[,!.\s-]*/i,
      ''
    )
    .trim();
}

function cleanUserAnswer(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const sanitized = sanitizeTranscript(raw, 'user');
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
    this.pendingAudioChunks = [];
    this.allowModelAudio = false;

    this.maxTurns = Number(context.speech_phases || 5);
    this.maxQuestions = Number(context.max_questions || 5);
  }

  async start() {
    const url = `${GEMINI_WS_BASE}?key=${encodeURIComponent(this.apiKey)}`;
    const systemText = String(this.context.system_instruction || '').trim();
    if (!systemText) throw new Error('system_instruction missing in live speech context');

    await new Promise((resolve, reject) => {
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
        this.handleGeminiMessage(msg, resolve, reject);
      });

      this.geminiWs.on('error', (err) => {
        if (!this.ready) reject(err);
        else this.onEvent({ type: 'error', message: err.message || 'gemini_ws_error' });
      });

      this.geminiWs.on('close', () => {
        this.closed = true;
        this.onEvent({ type: 'gemini_closed' });
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

    if (this.interviewEnded) return;

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
        if (this.allowModelAudio) {
          this.onEvent(chunk);
        } else {
          this.pendingAudioChunks.push(chunk);
        }
      }
    }

    if (server.turnComplete) this.onModelTurnComplete();
    if (server.interrupted) this.onEvent({ type: 'interrupted' });
  }

  // Stream the candidate's speech-to-text to the client as a live caption.
  emitUserPartialTranscript() {
    if (!this.userTurnActive && !this.awaitingAnswer) return;
    const clean = sanitizeTranscript(this.userBuf, 'user');
    if (!clean) return;
    this.onEvent({ type: 'transcript', speaker: 'user', text: clean, partial: true });
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
    this.pendingFinalize = setTimeout(() => {
      this.pendingFinalize = null;
      this.completeAnswerTurn();
    }, 1500);
  }

  completeAnswerTurn() {
    if (!this.awaitingAnswer) return;
    this.awaitingAnswer = false;
    this.blockModelOutput = false;
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }

    this.modelBuf = '';

    const userText = cleanUserAnswer(this.userBuf) || '[No spoken response captured]';
    this.userBuf = '';

    this.answers.push(userText);
    const aNum = this.answers.length;
    const qNum = aNum;
    const turnPair = {
      phase: this.maxQuestions + aNum,
      voice_question_number: aNum,
      question_text: this.questions[aNum - 1] || '',
      answer_text: userText,
      sent_at: new Date(this.startedAt + (aNum - 1) * 60000).toISOString(),
      received_at: new Date().toISOString(),
    };

    this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
    this.onEvent({ type: 'answer', number: aNum, text: userText });
    this.onEvent({
      type: 'turn_complete',
      turn: aNum,
      maxTurns: this.maxTurns,
      answersGiven: aNum,
    });
    this.onEvent({ type: 'answer_saved', number: aNum });

    this.onTurnSaved(turnPair).catch((err) => {
      console.warn('[relay] incremental turn save failed:', err.message);
    });

    this.roundQuestionEmitted = false;

    if (aNum >= this.maxTurns) {
      this.finishInterview();
      return;
    }

    const nextQ = aNum + 1;
    this.allowModelAudio = false;
    this.pendingAudioChunks = [];
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
      const qNum = this.questions.length;
      this.onEvent({ type: 'question', number: qNum, text: modelText });
      this.onEvent({ type: 'awaiting_answer', number: qNum, maxTurns: this.maxTurns });
    } else if (this.roundQuestionEmitted && this.questions.length) {
      const idx = this.questions.length - 1;
      this.questions[idx] = `${this.questions[idx]} ${modelText}`.replace(/\s+/g, ' ').trim();
      this.onEvent({ type: 'question', number: idx + 1, text: this.questions[idx] });
    }

    this.flushPendingAudio();
  }

  flushPendingAudio() {
    this.allowModelAudio = true;
    for (const chunk of this.pendingAudioChunks) {
      this.onEvent(chunk);
    }
    this.pendingAudioChunks = [];
  }

  finishInterview() {
    if (this.interviewEnded) return;
    this.interviewEnded = true;
    this.onEvent({ type: 'interview_complete', turn: this.maxTurns, maxTurns: this.maxTurns });
    this.sendClientText(
      'The candidate has answered all interview questions. Thank them warmly in one short sentence and say the voice interview is complete. Do not ask any more questions.',
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
    this.allowModelAudio = false;
    this.pendingAudioChunks = [];
    const prompt = String(this.context.kickoff_prompt || DEFAULT_KICKOFF).trim();
    this.sendClientText(prompt, true);
    this.onEvent({ type: 'interviewer_started' });
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
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));

    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = setTimeout(() => {
      if (!this.awaitingAnswer || this.interviewEnded) return;
      this.completeAnswerTurn();
    }, 15000);
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

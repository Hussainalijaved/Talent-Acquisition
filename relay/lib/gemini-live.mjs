import WebSocket from 'ws';
import { sanitizeTranscript } from './transcript-utils.mjs';

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const DEFAULT_MODEL = 'gemini-2.0-flash-live-001';
const DEFAULT_KICKOFF =
  'The candidate is ready. Greet them in one short sentence, then ask interview question 1 out loud. Ask only ONE question and then stop and wait for the candidate to answer.';

export class GeminiLiveBridge {
  constructor({ apiKey, context, onEvent }) {
    this.apiKey = apiKey;
    this.context = context || {};
    this.onEvent = onEvent || (() => {});
    this.model =
      String(context.gemini_live_model || process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL).replace(
        /^models\//,
        ''
      );
    this.geminiWs = null;
    this.ready = false;
    this.closed = false;
    this.interviewEnded = false;
    this.startedAt = Date.now();
    this.pendingUser = '';
    this.pendingModel = '';
    this.questions = [];
    this.answers = [];
    this.userTurnActive = false;
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
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: 'Aoede' },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: systemText }],
            },
            // Push-to-talk: the candidate controls when their turn starts/ends.
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

    if (msg.inputTranscription?.text) this.pendingUser += msg.inputTranscription.text;
    if (msg.outputTranscription?.text) this.pendingModel += msg.outputTranscription.text;

    const server = msg.serverContent;
    if (!server) return;

    if (server.inputTranscription?.text) this.pendingUser += server.inputTranscription.text;
    if (server.outputTranscription?.text) this.pendingModel += server.outputTranscription.text;

    const parts = server.modelTurn?.parts || [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        this.onEvent({
          type: 'output_audio',
          data: inline.data,
          mimeType: inline.mimeType || inline.mime_type || 'audio/pcm;rate=24000',
        });
      }
      if (part.text) {
        const chunk = sanitizeTranscript(part.text, 'model');
        if (chunk) this.pendingModel += chunk;
      }
    }

    if (server.turnComplete) {
      this.finalizeTurn();
    }

    if (server.interrupted) {
      this.onEvent({ type: 'interrupted' });
    }
  }

  finalizeTurn() {
    const userRaw = String(this.pendingUser || '').trim();
    const userText = sanitizeTranscript(this.pendingUser, 'user') || userRaw;
    const modelText = sanitizeTranscript(this.pendingModel, 'model');
    this.pendingUser = '';
    this.pendingModel = '';

    // An answer is expected whenever the candidate has spoken (more questions than answers).
    if (this.questions.length > this.answers.length) {
      const answer = userText || '[No spoken response]';
      this.answers.push(answer);
      const answerNum = this.answers.length;
      this.onEvent({ type: 'transcript', speaker: 'user', text: answer, partial: false });
      this.onEvent({ type: 'answer', number: answerNum, text: answer });
      this.onEvent({
        type: 'turn_complete',
        turn: answerNum,
        maxTurns: this.maxTurns,
        answersGiven: answerNum,
      });

      if (answerNum >= this.maxTurns) {
        this.finishInterview();
        return; // suppress any trailing question from the model
      }
    }

    if (modelText) {
      this.questions.push(modelText);
      const qNum = this.questions.length;
      this.onEvent({ type: 'transcript', speaker: 'model', text: modelText, partial: false });
      this.onEvent({ type: 'question', number: qNum, text: modelText });
      this.onEvent({ type: 'awaiting_answer', number: qNum, maxTurns: this.maxTurns });
    }
  }

  finishInterview() {
    if (this.interviewEnded) return;
    this.interviewEnded = true;
    this.onEvent({ type: 'interview_complete', turn: this.maxTurns, maxTurns: this.maxTurns });
    this.sendClientText(
      'The candidate has completed all interview questions. Thank them in one short sentence and end the interview. Do not ask any more questions.',
      true
    );
    setTimeout(() => this.closeGemini(), 6000);
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
    const prompt = String(this.context.kickoff_prompt || DEFAULT_KICKOFF).trim();
    this.sendClientText(prompt, true);
    this.onEvent({ type: 'interviewer_started' });
  }

  // Candidate pressed "Answer" — open their speaking turn.
  startUserTurn() {
    if (!this.ready || this.closed || this.interviewEnded || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (this.userTurnActive) return;
    this.userTurnActive = true;
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
  }

  // Candidate pressed "Submit" — close their speaking turn so the model replies.
  endUserTurn() {
    if (!this.ready || this.closed || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (!this.userTurnActive) return;
    this.userTurnActive = false;
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
  }

  sendAudio(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
    if (!this.ready || this.closed || this.interviewEnded || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (!this.userTurnActive) return; // only stream while the candidate is answering
    this.geminiWs.send(
      JSON.stringify({
        realtimeInput: {
          audio: { mimeType, data: base64Pcm },
        },
      })
    );
  }

  closeGemini() {
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
        question_text: this.questions[i] || '',
        answer_text: this.answers[i] || '',
        sent_at: new Date(this.startedAt + i * 60000).toISOString(),
        received_at: new Date().toISOString(),
      });
    }
    return turns;
  }
}

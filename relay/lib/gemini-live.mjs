import WebSocket from 'ws';

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const DEFAULT_MODEL = 'gemini-2.0-flash-live-001';
const DEFAULT_KICKOFF =
  'The candidate is ready. Begin the live voice interview now: greet them briefly, then ask question 1 of your planned questions out loud. Speak as the interviewer only.';

function b64ToBuffer(data) {
  return Buffer.from(String(data || ''), 'base64');
}

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
    this.startedAt = Date.now();
    this.userLines = [];
    this.modelLines = [];
    this.pendingUser = '';
    this.pendingModel = '';
    this.turnCount = 0;
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

    if (msg.inputTranscription?.text) {
      this.pendingUser += msg.inputTranscription.text;
      this.onEvent({
        type: 'transcript',
        speaker: 'user',
        text: msg.inputTranscription.text,
        partial: true,
      });
    }

    if (msg.outputTranscription?.text) {
      this.pendingModel += msg.outputTranscription.text;
      this.onEvent({
        type: 'transcript',
        speaker: 'model',
        text: msg.outputTranscription.text,
        partial: true,
      });
    }

    const server = msg.serverContent;
    if (!server) return;

    if (server.inputTranscription?.text) {
      this.pendingUser += server.inputTranscription.text;
      this.onEvent({
        type: 'transcript',
        speaker: 'user',
        text: server.inputTranscription.text,
        partial: true,
      });
    }

    if (server.outputTranscription?.text) {
      this.pendingModel += server.outputTranscription.text;
      this.onEvent({
        type: 'transcript',
        speaker: 'model',
        text: server.outputTranscription.text,
        partial: true,
      });
    }

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
        this.pendingModel += part.text;
        this.onEvent({ type: 'transcript', speaker: 'model', text: part.text, partial: true });
      }
    }

    if (server.turnComplete) {
      const userText = this.pendingUser.trim();
      const modelText = this.pendingModel.trim();
      if (modelText) {
        this.modelLines.push(modelText);
        this.onEvent({ type: 'transcript', speaker: 'model', text: modelText, partial: false });
      }
      if (userText) {
        this.userLines.push(userText);
        this.onEvent({ type: 'transcript', speaker: 'user', text: userText, partial: false });
      }
      this.pendingUser = '';
      this.pendingModel = '';
      this.turnCount += 1;

      const questionsAsked = this.modelLines.length;
      const answersGiven = this.userLines.length;
      this.onEvent({
        type: 'turn_complete',
        turn: questionsAsked,
        maxTurns: this.maxTurns,
        answersGiven,
      });

      if (questionsAsked >= this.maxTurns && answersGiven >= this.maxTurns) {
        this.onEvent({
          type: 'interview_complete',
          turn: questionsAsked,
          maxTurns: this.maxTurns,
        });
      }
    }

    if (server.interrupted) {
      this.onEvent({ type: 'interrupted' });
    }
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

  sendAudio(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
    if (!this.ready || this.closed || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    this.geminiWs.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType,
            data: base64Pcm,
          },
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
    const turns = [];
    const questions = this.modelLines;
    const answers = this.userLines;
    const count = Math.max(questions.length, answers.length);
    for (let i = 0; i < count; i += 1) {
      const phase = this.maxQuestions + 1 + i;
      turns.push({
        phase,
        question_text: questions[i] || '',
        answer_text: answers[i] || '',
        sent_at: new Date(this.startedAt + i * 60000).toISOString(),
        received_at: new Date().toISOString(),
      });
    }
    return turns;
  }
}

export function bufferToPcmBase64(buffer) {
  return b64ToBuffer(buffer).toString('base64');
}

import WebSocket from 'ws';
import { sanitizeTranscript } from './transcript-utils.mjs';

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const DEFAULT_MODEL = 'gemini-2.0-flash-live-001';
const DEFAULT_KICKOFF =
  'Begin the interview now. In the SAME turn, greet the candidate in one short sentence and then ask interview question 1. Ask exactly one question, then stop talking and wait. Do not say anything else.';

// Strip a leading greeting clause from the first question so the card reads cleanly.
function stripLeadingGreeting(text) {
  return String(text || '')
    .replace(
      /^(hi|hello|hey|welcome|good (morning|afternoon|evening)|thanks for joining|thank you for joining|great to (meet|have) you|let's begin|let's get started|to start|first|alright|okay|so)[,!.\s-]*/i,
      ''
    )
    .trim();
}

export class GeminiLiveBridge {
  constructor({ apiKey, context, onEvent }) {
    this.apiKey = apiKey;
    this.context = context || {};
    this.onEvent = onEvent || (() => {});
    this.model = String(
      context.gemini_live_model || process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL
    ).replace(/^models\//, '');

    this.geminiWs = null;
    this.ready = false;
    this.closed = false;
    this.interviewEnded = false;
    this.startedAt = Date.now();

    // Finalized Q&A. Index i => question i+1 paired with answer i+1.
    this.questions = [];
    this.answers = [];

    // Per-turn accumulators (audio transcription only — matches what is spoken).
    this.modelBuf = '';
    this.userBuf = '';

    // Deterministic turn state.
    this.roundQuestionEmitted = false; // a question card exists for the current round
    this.awaitingAnswer = false; // candidate pressed Submit; finalize their answer next
    this.userTurnActive = false; // candidate mic is open
    this.answerTimer = null;

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
            // Push-to-talk: the candidate decides exactly when their turn starts/ends.
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

    // Transcriptions can appear at the top level or under serverContent depending on version.
    if (msg.inputTranscription?.text) this.userBuf += msg.inputTranscription.text;
    if (msg.outputTranscription?.text) this.modelBuf += msg.outputTranscription.text;

    const server = msg.serverContent;
    if (!server) return;

    if (server.inputTranscription?.text) this.userBuf += server.inputTranscription.text;
    if (server.outputTranscription?.text) this.modelBuf += server.outputTranscription.text;

    // Only forward audio from model parts; rely on outputTranscription for text so the
    // displayed question always matches the spoken audio.
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
    }

    if (server.turnComplete) this.onModelTurnComplete();
    if (server.interrupted) this.onEvent({ type: 'interrupted' });
  }

  onModelTurnComplete() {
    // 1) If the candidate just submitted, this turn carries the rest of their
    //    transcription plus the model's next question. Finalize the answer first.
    if (this.awaitingAnswer) {
      this.finalizeAnswer();
      if (this.interviewEnded) {
        this.modelBuf = '';
        return;
      }
    }

    // 2) Handle the model's spoken question for this round.
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
      // The model kept talking before the candidate answered — append to the same card.
      const idx = this.questions.length - 1;
      this.questions[idx] = `${this.questions[idx]} ${modelText}`.replace(/\s+/g, ' ').trim();
      this.onEvent({ type: 'question', number: idx + 1, text: this.questions[idx] });
    }
  }

  finalizeAnswer() {
    if (!this.awaitingAnswer) return;
    this.awaitingAnswer = false;
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }

    const userText =
      sanitizeTranscript(this.userBuf, 'user') ||
      String(this.userBuf || '').trim() ||
      '[No spoken response]';
    this.userBuf = '';

    this.answers.push(userText);
    const aNum = this.answers.length;
    this.onEvent({ type: 'answer', number: aNum, text: userText });
    this.onEvent({
      type: 'turn_complete',
      turn: aNum,
      maxTurns: this.maxTurns,
      answersGiven: aNum,
    });

    // Ready for a fresh question on the next model turn.
    this.roundQuestionEmitted = false;

    if (aNum >= this.maxTurns) this.finishInterview();
  }

  finishInterview() {
    if (this.interviewEnded) return;
    this.interviewEnded = true;
    this.onEvent({ type: 'interview_complete', turn: this.maxTurns, maxTurns: this.maxTurns });
    this.sendClientText(
      'The candidate has answered all interview questions. Thank them in one short sentence and end the interview. Do not ask any more questions.',
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
    this.userBuf = '';
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
  }

  // Candidate pressed "Submit" — close their turn; the model will respond next.
  endUserTurn() {
    if (!this.ready || this.closed || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (!this.userTurnActive) return;
    this.userTurnActive = false;
    this.geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    this.awaitingAnswer = true;

    // Safety net: if the model never produces a turnComplete, finalize anyway and nudge it.
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = setTimeout(() => {
      if (!this.awaitingAnswer || this.interviewEnded) return;
      this.finalizeAnswer();
      if (this.interviewEnded) return;
      this.sendClientText(
        `Ask interview question ${this.answers.length + 1} of ${this.maxTurns} now. Ask exactly one question, then stop and wait.`,
        true
      );
    }, 6000);
  }

  sendAudio(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
    if (!this.ready || this.closed || this.interviewEnded || !this.geminiWs) return;
    if (this.geminiWs.readyState !== WebSocket.OPEN) return;
    if (!this.userTurnActive) return; // only stream while the candidate is answering
    this.geminiWs.send(
      JSON.stringify({ realtimeInput: { audio: { mimeType, data: base64Pcm } } })
    );
  }

  closeGemini() {
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
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

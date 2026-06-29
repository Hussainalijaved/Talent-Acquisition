/**
 * Talent Acquisition — Gemini Live speech client (browser)
 * Connects to relay/server.mjs WebSocket, streams mic PCM, plays model audio.
 */
(function (global) {
  'use strict';

  const INPUT_RATE = 16000;
  const OUTPUT_RATE = 24000;

  function floatTo16BitPcm(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function int16ToBase64(int16) {
    const bytes = new Uint8Array(int16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToInt16(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }

  function parseWsUrl(httpLike) {
    const raw = String(httpLike || '').trim();
    if (!raw) return '';
    if (raw.startsWith('ws://') || raw.startsWith('wss://')) return raw;
    if (raw.startsWith('https://')) return `wss://${raw.slice(8)}`;
    if (raw.startsWith('http://')) return `ws://${raw.slice(7)}`;
    return raw;
  }

  function downsample(buffer, inRate, outRate) {
    if (inRate === outRate) return buffer;
    const ratio = inRate / outRate;
    const newLen = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLen);
    for (let i = 0; i < newLen; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(buffer.length, Math.floor((i + 1) * ratio));
      if (end <= start) {
        result[i] = buffer[start] || 0;
        continue;
      }
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += buffer[j];
      result[i] = sum / (end - start);
    }
    return result;
  }

  const AUDIO_FLUSH_MS = 1400;

  class LiveSpeechSession {
    constructor(options) {
      this.relayUrl = parseWsUrl(options.relayUrl);
      this.context = options.context || {};
      this.onStatus = options.onStatus || (() => {});
      this.onTranscript = options.onTranscript || (() => {});
      this.onTurnScored = options.onTurnScored || (() => {});
      this.onLevel = options.onLevel || (() => {});
      this.onTurn = options.onTurn || (() => {});
      this.onComplete = options.onComplete || (() => {});
      this.onInterviewComplete = options.onInterviewComplete || (() => {});
      this.onQuestion = options.onQuestion || (() => {});
      this.onAnswer = options.onAnswer || (() => {});
      this.onSavingTurn = options.onSavingTurn || (() => {});
      this.onAwaitingAnswer = options.onAwaitingAnswer || (() => {});
      this.onTimeLimitUpdate = options.onTimeLimitUpdate || (() => {});
      this.onNextQuestionReady = options.onNextQuestionReady || (() => {});
      this.onPrematureClosing = options.onPrematureClosing || (() => {});
      this.onMicOpen = options.onMicOpen || (() => {});
      this.onSilenceNudge = options.onSilenceNudge || (() => {});
      this.onFollowUpProbe = options.onFollowUpProbe || (() => {});
      this.onWarmupPhase = options.onWarmupPhase || (() => {});
      this.onOutputAudio = options.onOutputAudio || (() => {});
      this.onPlaybackIdle = options.onPlaybackIdle || (() => {});
      this.onError = options.onError || (() => {});
      this.tabSwitches = Number(options.tabSwitches || 0);

      this.ws = null;
      this.audioCtx = null;
      this.mediaStream = null;
      this.processor = null;
      this.source = null;
      this.playQueue = [];
      this.playing = false;
      this.nextPlayTime = 0;
      this.ended = false;
      this.interviewEnded = false;
      this.answering = false;
      this.processingAnswer = false;
      this.autoEndTimer = null;
      this.micOpenTimer = null;
      // Silence handling (nudge + auto-submit) is driven by the relay using
      // voice energy on PCM chunks — not transcription.
      this.allowInterviewerDuringAnswer = false;
      this.nudgeAudioTimer = null;
      // Single source of truth for the answer window. Mirrors the warmup flow:
      // relay sends `awaiting_answer` → we wait for interviewer audio to finish
      // → we open the mic. No other path opens the mic for real questions.
      this.awaitingAnswerPending = false;
      this.pendingAnswerQ = 0;
      this.pendingAnswerSeconds = 120;
      this.micOpenToken = 0;          // invalidates stale open-mic loops
      this.questionSafetyTimer = null; // fires only if awaiting_answer never arrives
      this.streamingAudio = false;
      this.audioFlushTimer = null;
      this.playbackGeneration = 0;
      this.heardQuestionAudioThisTurn = false;
      this.questionAudioWaitDeadline = 0;
      this.lastOutputAudioAt = 0;
      this.playbackIdleSentForQ = null;
      this.playbackIdleTimer = null;
      this.questionAudioMissingSentForQ = null;
      this.preparingAudioWatchdogTimer = null;
      this.preparingAudioWatchdogQ = 0;
      this.questionAudioTailMs = 900;
      this.awaitingAnswerAt = 0;
      this.micOpenWatchdogTimer = null;
      this.warmupMicOpenTimer = null;
      this.warmupMicOpenGen = 0;
    }

    clearPlayback() {
      this.playbackGeneration += 1;
      this.playQueue = [];
      this.playing = false;
      if (this.audioCtx) this.nextPlayTime = this.audioCtx.currentTime;
    }

    flushAnswerAudio() {
      this.streamingAudio = true;
      if (this.audioFlushTimer) clearTimeout(this.audioFlushTimer);
      this.audioFlushTimer = setTimeout(() => {
        this.audioFlushTimer = null;
        this.streamingAudio = false;
      }, AUDIO_FLUSH_MS);
    }

    shouldStreamMic() {
      return this.answering || this.streamingAudio;
    }

    // Report mic level whenever the answer window is open (even before beginAnswer).
    shouldShowMicLevel() {
      return this.shouldStreamMic() || this.awaitingAnswerPending;
    }

    async initPlaybackAudio() {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) throw new Error('AudioContext not supported');
      if (!this.audioCtx) {
        this.audioCtx = new Ctx();
        this.playbackGain = this.audioCtx.createGain();
        this.playbackGain.gain.value = 1;
        this.playbackGain.connect(this.audioCtx.destination);
      }
      await this.ensureAudioRunning();
    }

    async ensureAudioRunning() {
      if (!this.audioCtx) return false;
      if (this.audioCtx.state === 'suspended') {
        try {
          await this.audioCtx.resume();
        } catch (err) {
          console.warn('[live-speech] AudioContext resume failed:', err);
        }
      }
      return this.audioCtx.state === 'running';
    }

    cancelMicOpen() {
      // Invalidate any in-flight open-mic loop and clear the safety timer.
      this.micOpenToken += 1;
      this.warmupMicOpenGen += 1;
      if (this.micOpenTimer) {
        clearTimeout(this.micOpenTimer);
        this.micOpenTimer = null;
      }
      if (this.warmupMicOpenTimer) {
        clearTimeout(this.warmupMicOpenTimer);
        this.warmupMicOpenTimer = null;
      }
      if (this.micOpenWatchdogTimer) {
        clearTimeout(this.micOpenWatchdogTimer);
        this.micOpenWatchdogTimer = null;
      }
    }

    clearMicOpenWatchdog() {
      if (this.micOpenWatchdogTimer) {
        clearTimeout(this.micOpenWatchdogTimer);
        this.micOpenWatchdogTimer = null;
      }
    }

    scheduleMicOpenWatchdog() {
      this.clearMicOpenWatchdog();
      const delayMs = this.pendingAnswerQ <= 0 ? 1200 : 6000;
      this.micOpenWatchdogTimer = setTimeout(() => this.runMicOpenWatchdog(), delayMs);
    }

    // Safety net to guarantee the mic eventually opens — but it must NEVER cut the
    // interviewer's question audio. If audio is still playing (or just finished),
    // reschedule and wait; only force-open once playback is genuinely idle.
    runMicOpenWatchdog() {
      this.micOpenWatchdogTimer = null;
      if (this.ended || this.interviewEnded || this.answering || !this.awaitingAnswerPending) return;
      if (this.pendingAnswerQ <= 0) {
        this.beginAnswer({ force: true });
        return;
      }
      if (this.pendingAnswerQ >= 1 && !this.heardQuestionAudioThisTurn) {
        const waited = Date.now() - (this.awaitingAnswerAt || Date.now());
        if (waited < 45000) {
          this.micOpenWatchdogTimer = setTimeout(() => this.runMicOpenWatchdog(), 2000);
          return;
        }
      }
      const sinceLastAudio = Date.now() - (this.lastOutputAudioAt || 0);
      const audioBusy =
        this.playing ||
        this.playQueue.length > 0 ||
        (this.lastOutputAudioAt && sinceLastAudio < this.questionAudioTailMs);
      if (audioBusy) {
        this.micOpenWatchdogTimer = setTimeout(() => this.runMicOpenWatchdog(), 700);
        return;
      }
      this.beginAnswer({ force: true });
    }

    clearPreparingAudioWatchdog() {
      if (this.preparingAudioWatchdogTimer) {
        clearTimeout(this.preparingAudioWatchdogTimer);
        this.preparingAudioWatchdogTimer = null;
      }
      this.preparingAudioWatchdogQ = 0;
    }

    schedulePreparingAudioWatchdog(qNum) {
      this.clearPreparingAudioWatchdog();
      if (qNum < 1) return;
      this.preparingAudioWatchdogQ = qNum;
      this.preparingAudioWatchdogTimer = setTimeout(() => {
        this.preparingAudioWatchdogTimer = null;
        if (this.ended || this.interviewEnded || this.heardQuestionAudioThisTurn) return;
        if (this.preparingAudioWatchdogQ !== qNum) return;
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'question_audio_missing', number: qNum }));
        }
        this.schedulePreparingAudioWatchdog(qNum);
      }, 8000);
    }

    clearQuestionSafetyTimer() {
      if (this.questionSafetyTimer) {
        clearTimeout(this.questionSafetyTimer);
        this.questionSafetyTimer = null;
      }
    }

    // Safety net used ONLY if the relay never sends awaiting_answer for a real
    // question (e.g. relay not redeployed). The normal flow never needs this.
    scheduleQuestionSafety(qNum, timeLimitSeconds = 120) {
      this.clearQuestionSafetyTimer();
      this.pendingAnswerQ = qNum;
      this.pendingAnswerSeconds = timeLimitSeconds;
      this.questionSafetyTimer = setTimeout(() => {
        this.questionSafetyTimer = null;
        if (this.ended || this.interviewEnded || this.answering || this.awaitingAnswerPending) return;
        this.requestAnswer({ number: qNum, time_limit_seconds: timeLimitSeconds, warmup: null });
      }, 11000);
    }

    // THE single entry point for opening the candidate's mic. Both warmup turns
    // and real questions go through here — identical behaviour for all of them.
    // Fires onAwaitingAnswer exactly once with whatever payload is supplied.
    requestAnswer(payload = {}) {
      if (this.ended || this.interviewEnded) return;
      const number = payload.number ?? 0;
      const isWarmup = payload.warmup != null || number <= 0;
      const seconds = Number(payload.time_limit_seconds) > 0 ? Number(payload.time_limit_seconds) : 120;
      this.clearQuestionSafetyTimer();
      const duplicate = this.awaitingAnswerPending && this.pendingAnswerQ === number;
      this.awaitingAnswerPending = true;
      this.pendingAnswerQ = number;
      this.pendingAnswerSeconds = seconds;
      this.awaitingAnswerAt = Date.now();
      this.heardQuestionAudioThisTurn = false;
      this.questionAudioMissingSentForQ = null;
      if (!duplicate) {
        this.onAwaitingAnswer({
          number,
          maxTurns: payload.maxTurns,
          time_limit_seconds: seconds,
          complexity_tier: payload.complexity_tier,
          warmup: payload.warmup || null,
        });
      }
      this.scheduleMicOpenWatchdog();
      if (isWarmup) {
        if (this.warmupMicOpenTimer) clearTimeout(this.warmupMicOpenTimer);
        const gen = ++this.warmupMicOpenGen;
        const delayMs = 350;
        this.warmupMicOpenTimer = setTimeout(() => {
          this.warmupMicOpenTimer = null;
          if (gen !== this.warmupMicOpenGen) return;
          if (this.ended || this.interviewEnded || !this.awaitingAnswerPending || this.answering) return;
          this.beginAnswer({ force: true });
        }, delayMs);
        return;
      }
      void this.openMicAfterPlayback();
    }

    // Wait for the interviewer's audio to finish, then open the mic. Hard-capped
    // at 40s — long enough for the longest interview question audio but still a
    // safety net so a stuck playback flag can never freeze the interview.
    async openMicAfterPlayback() {
      const myToken = ++this.micOpenToken;
      if (this.ended || this.interviewEnded) return;
      const isWarmupTurn = this.pendingAnswerQ <= 0;
      if (isWarmupTurn) {
        const warmupDeadline = Date.now() + 3500;
        while (Date.now() < warmupDeadline) {
          if (this.ended || this.interviewEnded) return;
          if (myToken !== this.micOpenToken) return;
          if (!this.awaitingAnswerPending || this.answering) return;
          if (!this.playing && this.playQueue.length === 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (myToken !== this.micOpenToken) return;
        if (this.ended || this.interviewEnded || this.answering || !this.awaitingAnswerPending) return;
        this.beginAnswer({ force: true });
        return;
      }
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (this.ended || this.interviewEnded) return;
        if (myToken !== this.micOpenToken) return;
        if (!this.awaitingAnswerPending || this.answering) return;
        // Wait briefly for the question's FIRST audio chunk to ARRIVE. Some relay
        // versions emit awaiting_answer before (or alongside) the spoken audio —
        // opening the mic now would set answering=true and BLOCK that audio, so the
        // candidate would hear nothing. Bounded so a truly silent question (no audio
        // at all) still lets the flow proceed instead of freezing.
        if (
          this.pendingAnswerQ >= 1 &&
          !this.heardQuestionAudioThisTurn &&
          this.awaitingAnswerAt &&
          Date.now() - this.awaitingAnswerAt < 45000
        ) {
          if (
            !this.questionAudioMissingSentForQ &&
            Date.now() - this.awaitingAnswerAt > 9000 &&
            this.ws?.readyState === WebSocket.OPEN
          ) {
            this.questionAudioMissingSentForQ = this.pendingAnswerQ;
            this.ws.send(JSON.stringify({ type: 'question_audio_missing', number: this.pendingAnswerQ }));
          }
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }
        if (this.playing || this.playQueue.length > 0) {
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }
        const sinceLastAudio = Date.now() - (this.lastOutputAudioAt || 0);
        if (this.lastOutputAudioAt && sinceLastAudio < this.questionAudioTailMs) {
          await new Promise((r) => setTimeout(r, Math.min(150, this.questionAudioTailMs - sinceLastAudio)));
          continue;
        }
        break;
      }
      if (myToken !== this.micOpenToken) return;
      if (this.ended || this.interviewEnded || this.answering || !this.awaitingAnswerPending) return;
      if (this.pendingAnswerQ >= 1 && !this.heardQuestionAudioThisTurn) {
        this.ensureMicReady();
        return;
      }
      this.maybeSendPlaybackIdle();
      await new Promise((r) => setTimeout(r, 150));
      if (myToken !== this.micOpenToken) return;
      if (this.ended || this.interviewEnded || this.answering || !this.awaitingAnswerPending) return;
      this.beginAnswer();
    }

    // Re-arm mic open if a prior loop was cancelled (e.g. late question_partial).
    ensureMicReady() {
      if (this.pendingAnswerQ <= 0) return;
      if (this.ended || this.interviewEnded || this.answering || !this.awaitingAnswerPending) return;
      void this.openMicAfterPlayback();
    }

    schedulePlaybackIdleCheck() {
      if (this.playbackIdleTimer) clearTimeout(this.playbackIdleTimer);
      this.playbackIdleTimer = setTimeout(() => {
        this.playbackIdleTimer = null;
        this.maybeSendPlaybackIdle();
      }, this.questionAudioTailMs);
    }

    maybeSendPlaybackIdle() {
      if (this.ended || this.interviewEnded) return;
      if (!this.awaitingAnswerPending || this.answering) return;
      if (this.playing || this.playQueue.length > 0) return;
      const sinceLast = Date.now() - (this.lastOutputAudioAt || 0);
      if (this.lastOutputAudioAt && sinceLast < this.questionAudioTailMs) {
        this.schedulePlaybackIdleCheck();
        return;
      }
      const q = this.pendingAnswerQ;
      if (q == null || q < 1) return;
      if (this.playbackIdleSentForQ === q) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.playbackIdleSentForQ = q;
        this.ws.send(JSON.stringify({ type: 'playback_idle', number: q }));
      }
    }

    closeMicForInterviewer() {
      this.cancelMicOpen();
      this.awaitingAnswerPending = false;
      if (this.answering || this.streamingAudio) {
        this.flushAnswerAudio();
      }
      this.answering = false;
      this.allowInterviewerDuringAnswer = false;
      this.processingAnswer = false;
      this.onLevel(0);
    }

    forceEndAnswer() {
      if (!this.answering && !this.streamingAudio) return;
      this.flushAnswerAudio();
      this.answering = false;
      this.allowInterviewerDuringAnswer = false;
      this.onLevel(0);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'user_turn_end' }));
      }
    }

    // Open the candidate's mic NOW. If interviewer audio is somehow still queued,
    // drop it instead of waiting forever — the relay only asks for an answer once
    // the question has been fully spoken.
    beginAnswer(opts = {}) {
      const force = !!opts.force;
      if (this.ended || this.interviewEnded) return;
      if (this.answering) {
        if (!force) return;
        this.onMicOpen();
        this.setStatus('Listening — speak your answer now');
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'user_turn_start' }));
        }
        return;
      }
      if (!force) {
        if (this.playing || this.playQueue.length > 0) {
          this.ensureMicReady();
          return;
        }
        const sinceLastAudio = Date.now() - (this.lastOutputAudioAt || 0);
        if (this.lastOutputAudioAt && sinceLastAudio < this.questionAudioTailMs) {
          this.ensureMicReady();
          return;
        }
      }
      this.cancelMicOpen();
      this.clearQuestionSafetyTimer();
      this.awaitingAnswerPending = false;
      this.awaitingAnswerAt = 0;
      this.answering = true;
      this.allowInterviewerDuringAnswer = false;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'user_turn_start' }));
      }
      this.onMicOpen();
      this.setStatus('Listening — speak your answer now');
    }

    // Candidate pressed "Submit" — close their mic and let the interviewer respond.
    submitAnswer() {
      if (this.ended || this.interviewEnded) return;
      if (!this.answering && !this.awaitingAnswerPending) return;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Ensure relay opened the turn before we close it.
        this.ws.send(JSON.stringify({ type: 'user_turn_start' }));
      }
      // Keep streaming a short tail so the last syllables reach the relay before
      // the answer window closes on the next question transition.
      this.flushAnswerAudio();
      this.answering = false;
      this.awaitingAnswerPending = false;
      this.processingAnswer = true;
      this.allowInterviewerDuringAnswer = false;
      this.onLevel(0);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'user_turn_end' }));
      }
      this.setStatus('Saving your answer — please wait…');
    }

    stopMic() {
      this.interviewEnded = true;
      this.answering = false;
      try {
        this.processor?.disconnect();
        this.source?.disconnect();
      } catch (_) {}
      this.processor = null;
      this.source = null;
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((t) => t.stop());
        this.mediaStream = null;
      }
    }

    setStatus(text) {
      this.onStatus(text);
    }

    async start() {
      if (!this.relayUrl) throw new Error('live_relay_url missing — set in n8n CFG');
      this.setStatus('Connecting…');
      await this.initPlaybackAudio();

      this.ws = new WebSocket(this.relayUrl);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('relay connection timeout')), 20000);
        this.ws.onopen = () => {
          clearTimeout(t);
          resolve();
        };
        this.ws.onerror = () => {
          clearTimeout(t);
          reject(new Error('relay websocket error'));
        };
      });

      this.ws.onmessage = (ev) => this.handleMessage(ev.data);
      this.ws.onclose = () => {
        if (!this.ended) this.setStatus('Disconnected');
      };

      this.ws.send(
        JSON.stringify({
          type: 'session.start',
          context: this.context,
        })
      );

      await this.waitForType('ready', 50000);
      this.setStatus('Interviewer is starting…');
      await this.startMic();
      if (this.playQueue.length) void this.drainPlayback();
      this.setStatus('Listen to the interviewer — setup is starting');
    }

    waitForType(type, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const hint = type === 'ready'
            ? 'Gemini Live did not start — check relay is deployed, GEMINI_API_KEY is set, and Railway has latest code.'
            : '';
          reject(new Error(`timeout waiting for ${type}${hint ? ` — ${hint}` : ''}`));
        }, ms);
        const handler = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === type) {
              clearTimeout(timer);
              this.ws.removeEventListener('message', handler);
              resolve(msg);
            }
            if (msg.type === 'error') {
              clearTimeout(timer);
              this.ws.removeEventListener('message', handler);
              reject(new Error(msg.message || 'relay error'));
            }
          } catch (_) {}
        };
        this.ws.addEventListener('message', handler);
      });
    }

    handleMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }

      if (msg.type === 'transcript' && msg.text) {
        this.onTranscript({
          speaker: msg.speaker,
          text: msg.text,
          partial: !!msg.partial,
          closing: !!msg.closing,
        });
      }
      if (msg.type === 'flush_playback') {
        // Ignore stale flush if interviewer audio for the current turn is already queued.
        if (this.playQueue.length > 0 || this.playing) return;
        this.clearPlayback();
        // Never cancel an open answer window — flush only clears playback.
        if (!this.awaitingAnswerPending && !this.answering) this.cancelMicOpen();
        return;
      }
      if (msg.type === 'question_partial' && msg.text) {
        if (msg.warmup == null && window.TA_LIVE?.looksLikeClosingMessage?.(msg.text)) return;
        // Partials are caption-only — must NOT cancel mic open (warmup works because
        // partials carry warmup=mic_check|intro; real Q1-Q5 partials were killing the mic).
        this.onQuestion({ number: msg.number, text: msg.text, partial: true, warmup: msg.warmup || null });
        if (this.awaitingAnswerPending && !this.answering && msg.number >= 1) this.ensureMicReady();
      }
      if (msg.type === 'question') {
        const isWarmup = msg.warmup != null || msg.number <= 0;
        if (!isWarmup && msg.text && window.TA_LIVE?.looksLikeClosingMessage?.(msg.text)) return;
        if (!isWarmup && !this.awaitingAnswerPending && !this.answering) {
          this.processingAnswer = false;
        }
        this.onQuestion({ number: msg.number, text: msg.text || '', partial: false, follow_up: !!msg.follow_up, warmup: msg.warmup || null });
        if (this.awaitingAnswerPending && !this.answering && !isWarmup) this.ensureMicReady();
      }
      if (msg.type === 'answer') {
        this.clearQuestionSafetyTimer();
        if (msg.warmup === 'mic_check') {
          this.closeMicForInterviewer();
        }
        this.onAnswer({ number: msg.number, text: msg.text, follow_up: !!msg.follow_up, warmup: msg.warmup || null });
      }
      if (msg.type === 'saving_turn') {
        // Do not clear playback — next question TTS follows immediately and
        // clearing here was racing with first audio chunks on Q3+.
        this.processingAnswer = true;
        this.onSavingTurn?.({ number: msg.number, follow_up: !!msg.follow_up });
        this.setStatus(
          msg.follow_up
            ? 'Follow-up captured — saving…'
            : 'Answer captured — saving in background…'
        );
      }
      if (msg.type === 'follow_up_probe') {
        this.clearPlayback();
        this.clearQuestionSafetyTimer();
        this.processingAnswer = false;
        this.onFollowUpProbe?.({ number: msg.number, maxTurns: msg.maxTurns });
        this.setStatus('Follow-up — listen to the interviewer…');
      }
      if (msg.type === 'warmup_phase') {
        if (msg.phase === 'intro') {
          this.closeMicForInterviewer();
        }
        this.onWarmupPhase?.({ phase: msg.phase });
        const s = msg.phase === 'mic_check'
          ? 'Microphone check — listen and say a few words'
          : msg.phase === 'intro'
            ? 'Introduction — listen, then speak when the mic opens'
            : 'Interview starting…';
        this.setStatus(s);
      }
      if (msg.type === 'silence_nudge') {
        const stage = msg.stage || 'nudge';
        if (stage === 'auto_submit') {
          // Relay is finalizing — keep streaming tail audio while UI closes.
          this.flushAnswerAudio();
          this.answering = false;
          this.processingAnswer = true;
          this.allowInterviewerDuringAnswer = false;
          this.onLevel(0);
          this.setStatus('No response detected — submitting your answer…');
        } else {
          // Nudge is about to be spoken by the interviewer — allow that audio
          // through even though the mic is still open.
          this.allowInterviewerDuringAnswer = true;
          if (this.nudgeAudioTimer) clearTimeout(this.nudgeAudioTimer);
          this.nudgeAudioTimer = setTimeout(() => {
            this.allowInterviewerDuringAnswer = false;
            this.nudgeAudioTimer = null;
          }, 12000);
        }
        this.onSilenceNudge?.({ stage, text: msg.text });
      }
      if (msg.type === 'next_question_ready') {
        this.closeMicForInterviewer();
        this.clearQuestionSafetyTimer();
        this.clearPlayback();
        this.processingAnswer = false;
        this.awaitingAnswerPending = false;
        this.heardQuestionAudioThisTurn = false;
        this.lastOutputAudioAt = 0;
        this.playbackIdleSentForQ = null;
        this.questionAudioMissingSentForQ = null;
        this.questionAudioWaitDeadline = Date.now() + 18000;
        if (msg.number >= 1) {
          this.pendingAnswerQ = msg.number;
          this.pendingAnswerSeconds = 120;
          this.schedulePreparingAudioWatchdog(msg.number);
        }
        this.onNextQuestionReady({ number: msg.number });
        this.setStatus('Preparing the next question…');
        // Relay emits awaiting_answer after question TTS — do NOT open mic early here.
      }
      if (msg.type === 'turn_saved_status') {
        this.onTurn({ savedStatus: { number: msg.number, saved: !!msg.saved, error: msg.error } });
        if (msg.follow_up) {
          this.setStatus(
            msg.saved
              ? `Follow-up saved — the interviewer will continue…`
              : `Follow-up recorded — the interviewer will continue…`
          );
        } else {
          this.setStatus(
            msg.saved
              ? 'Answer saved — preparing next step…'
              : 'Answer recorded — preparing next step…'
          );
        }
      }
      if (msg.type === 'awaiting_answer') {
        this.processingAnswer = false;
        // Unified path for warmup AND real questions.
        this.requestAnswer({
          number: msg.number,
          maxTurns: msg.maxTurns,
          time_limit_seconds: msg.time_limit_seconds,
          complexity_tier: msg.complexity_tier,
          warmup: msg.warmup || null,
        });
        const statusMsg = msg.warmup === 'mic_check'
          ? 'Microphone check — listen, then say a few words when the mic opens'
          : msg.warmup === 'intro'
            ? 'Introduction — listen, then speak when the mic opens'
            : 'Listen, then speak when the mic opens';
        this.setStatus(statusMsg);
      }
      if (msg.type === 'time_limit_update') {
        this.onTimeLimitUpdate?.({
          number: msg.number,
          time_limit_seconds: msg.time_limit_seconds,
          complexity_tier: msg.complexity_tier,
        });
      }
      if (msg.type === 'output_audio' && msg.data) {
        this.clearPreparingAudioWatchdog();
        // Block interviewer audio only while the candidate is actively recording an
        // answer — never while waiting for the question to be spoken.
        if (this.answering && !this.allowInterviewerDuringAnswer) return;
        if (!this.answering) this.heardQuestionAudioThisTurn = true;
        this.lastOutputAudioAt = Date.now();
        this.playbackIdleSentForQ = null;
        void this.ensureAudioRunning();
        this.onOutputAudio?.();
        if (!this.answering) this.setStatus('Interviewer is speaking…');
        this.enqueuePlayback(msg.data, msg.mimeType || `audio/pcm;rate=${OUTPUT_RATE}`);
      }
      if (msg.type === 'turn_complete') {
        const capped = Math.min(msg.turn || 0, msg.maxTurns || 5);
        this.onTurn({ turn: capped, maxTurns: msg.maxTurns, answersGiven: msg.answersGiven });
      }
      if (msg.type === 'turn_scored') {
        this.onTurnScored({
          number: msg.number,
          phase: msg.phase,
          score: msg.score,
          feedback: msg.feedback,
          soft_skills: msg.soft_skills,
        });
      }
      if (msg.type === 'interview_closing_premature') {
        this.processingAnswer = false;
        this.answering = false;
        this.onPrematureClosing(msg);
        this.setStatus('Preparing the next step — please wait…');
        return;
      }
      if (msg.type === 'interview_closing') {
        this.processingAnswer = false;
        // Keep the mic open until interview_complete — premature closing must not
        // block the candidate from answering the final question.
        this.onInterviewComplete(msg);
      }
      if (msg.type === 'interview_complete') {
        this.stopMic();
        this.processingAnswer = false;
        this.interviewEnded = true;
        this.setStatus('Interview complete — the interviewer is wrapping up…');
        this.onInterviewComplete(msg);
        if (!this.autoEndTimer && !this.ended) {
          this.autoEndTimer = setTimeout(() => {
            this.autoEndTimer = null;
            if (this.ended) return;
            this.setStatus('Submitting your results…');
            this.end()
              .then((result) => {
                if (result && !this.ended) this.onComplete(result);
              })
              .catch((e) => {
                console.warn('[live-speech] auto end failed:', e.message);
                this.onError(e);
              });
          }, 9000);
        }
      }
      if (msg.type === 'non_english_detected') {
        this.setStatus(msg.hint || 'Please answer in English only.');
      }
      if (msg.type === 'session.complete') {
        this.ended = true;
        this.onComplete(msg);
      }
      if (msg.type === 'error') {
        this.onError(new Error(msg.message || 'relay error'));
      }
    }

    async startMic() {
      if (!this.audioCtx) await this.initPlaybackAudio();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false,
      });
      await this.ensureAudioRunning();
      if (!this.playbackGain) {
        this.playbackGain = this.audioCtx.createGain();
        this.playbackGain.gain.value = 1;
        this.playbackGain.connect(this.audioCtx.destination);
      }
      this.source = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
      const inRate = this.audioCtx.sampleRate;

      this.processor.onaudioprocess = (e) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.ended || this.interviewEnded) return;
        if (!this.shouldStreamMic()) return;
        const input = e.inputBuffer.getChannelData(0);
        let sumSq = 0;
        for (let i = 0; i < input.length; i += 1) {
          const s = input[i];
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / input.length);
        const level = Math.min(1, rms * 14);
        this.onLevel(this.shouldShowMicLevel() ? level : 0);

        if (!this.shouldStreamMic()) return;

        const down = downsample(input, inRate, INPUT_RATE);
        const pcm = floatTo16BitPcm(down);
        this.ws.send(
          JSON.stringify({
            type: 'input_audio',
            data: int16ToBase64(pcm),
            mimeType: `audio/pcm;rate=${INPUT_RATE}`,
          })
        );
      };

      const silent = this.audioCtx.createGain();
      silent.gain.value = 0;
      this.source.connect(this.processor);
      this.processor.connect(silent);
      silent.connect(this.audioCtx.destination);
      if (this.playQueue.length) void this.drainPlayback();
    }

    enqueuePlayback(b64, mimeType) {
      const rateMatch = /rate=(\d+)/i.exec(mimeType || '');
      const rate = rateMatch ? Number(rateMatch[1]) : OUTPUT_RATE;
      this.playQueue.push({ b64, rate });
      void this.drainPlayback();
    }

    async drainPlayback() {
      if (!this.audioCtx) return;
      await this.ensureAudioRunning();
      if (this.playing) return;
      const gen = this.playbackGeneration;
      this.playing = true;
      while (this.playQueue.length && !this.ended && gen === this.playbackGeneration) {
        const chunk = this.playQueue.shift();
        const pcm = base64ToInt16(chunk.b64);
        const float = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i += 1) float[i] = pcm[i] / 0x8000;
        const buffer = this.audioCtx.createBuffer(1, float.length, chunk.rate);
        buffer.copyToChannel(float, 0);
        const src = this.audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.playbackGain || this.audioCtx.destination);
        const startAt = Math.max(this.audioCtx.currentTime, this.nextPlayTime);
        src.start(startAt);
        this.nextPlayTime = startAt + buffer.duration;
        // Resolve on natural end OR a hard timeout — onended can silently never
        // fire if the AudioContext is interrupted (tab blur, proctor overlay),
        // which previously froze the whole interview.
        await new Promise((r) => {
          let done = false;
          const finish = () => { if (!done) { done = true; r(); } };
          src.onended = finish;
          setTimeout(finish, Math.ceil(buffer.duration * 1000) + 800);
        });
        if (gen !== this.playbackGeneration) break;
      }
      this.playing = false;
      if (gen === this.playbackGeneration && !this.playQueue.length) {
        this.onPlaybackIdle?.();
        if (this.awaitingAnswerPending && !this.answering && this.pendingAnswerQ >= 1) {
          this.schedulePlaybackIdleCheck();
          this.ensureMicReady();
        }
      }
    }

    async end() {
      if (this.ended) return null;
      if (this.autoEndTimer) {
        clearTimeout(this.autoEndTimer);
        this.autoEndTimer = null;
      }
      if (this.audioFlushTimer) {
        clearTimeout(this.audioFlushTimer);
        this.audioFlushTimer = null;
      }
      this.streamingAudio = false;
      this.stopMic();
      this.setStatus('Finishing session…');
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'session.end',
            email: this.context.candidate_email,
            tab_switches: this.tabSwitches,
          })
        );
      }
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('complete timeout')), 120000);
        const onMsg = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'session.complete') {
              clearTimeout(timer);
              this.ws?.removeEventListener('message', onMsg);
              resolve(msg);
            }
            if (msg.type === 'error') {
              clearTimeout(timer);
              this.ws?.removeEventListener('message', onMsg);
              reject(new Error(msg.message || 'complete error'));
            }
          } catch (_) {}
        };
        this.ws?.addEventListener('message', onMsg);
      });

      if (
        !result?.result
        || result?.saved_to_db === false
        || result?.speech_score == null
        || result?.complete_webhook_ok === false
      ) {
        const portalBase = this.context?.portal_base_url || this.context?.config?.portal_base_url;
        const sessionId = this.context?.session_id;
        if (portalBase && sessionId && global.TA_LIVE?.finalizeLiveSpeech) {
          try {
            const fin = await global.TA_LIVE.finalizeLiveSpeech({
              portalBase,
              sessionId,
              maxQuestions: Number(this.context?.max_questions || 5),
              liveSpeechContext: this.context,
            });
            if (fin?.ok) {
              result.result = fin.result || result.result;
              result.score = fin.score ?? result.score;
              result.technical_score = fin.technical_score ?? result.technical_score;
              result.speech_score = fin.speech_score ?? result.speech_score;
              result.saved_to_db = true;
              result.complete_webhook_ok = fin.complete_webhook_ok ?? result.complete_webhook_ok;
              result.save = { ...(result.save || {}), ...fin };
            }
          } catch (finErr) {
            console.warn('[live-speech] client finalize fallback failed:', finErr.message);
          }
        }
      }

      this.cleanup();
      this.ended = true;
      return result;
    }

    cancel() {
      this.cleanup();
      this.ended = true;
    }

    cleanup() {
      this.pendingAnswerQ = 0;
      this.clearQuestionSafetyTimer();
      this.cancelMicOpen();
      try {
        this.processor?.disconnect();
        this.source?.disconnect();
      } catch (_) {}
      this.processor = null;
      this.source = null;
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((t) => t.stop());
        this.mediaStream = null;
      }
      if (this.audioCtx) {
        this.audioCtx.close().catch(() => {});
        this.audioCtx = null;
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
  }

  async function fetchLiveSpeechStart(webhookBase, sessionId, email) {
    const base = String(webhookBase || '').replace(/\/+$/, '');
    const res = await fetch(`${base}/talent/live-speech-start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({ session_id: sessionId, email }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`live-speech-start failed (${res.status}): ${text.slice(0, 200)}`);
    let json = text.trim();
    if (json.startsWith('=')) json = json.slice(1).trim();
    return JSON.parse(json);
  }

  function resolveRelayUrl(context, fallback) {
    return (
      parseWsUrl(context?.live_relay_url) ||
      parseWsUrl(fallback) ||
      ''
    );
  }

  function sanitizeDisplayTranscript(text, speaker) {
    let t = String(text || '').trim();
    if (!t) return '';
    t = t.replace(/\*\*[^*]+\*\*/g, ' ').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (speaker === 'model' && /^(okay|ok|on|role\?)$/i.test(t)) return '';
    if (speaker === 'user' && /^(okay|ok|on)\.?$/i.test(t)) return '';
    // Keep live captions visible — don't blank partial English speech.
    if (speaker === 'user' && t.length >= 2) return t;
    return t;
  }

  function looksLikeClosingMessage(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return false;
    return /conclud(e|es|ed|ing).*interview|completes? the voice interview|that concludes|we will be in touch|thank you for your time|end of (the )?interview/.test(t);
  }

  async function finalizeLiveSpeech({ portalBase, sessionId, maxQuestions = 5, liveSpeechContext = null }) {
    const base = String(portalBase || 'https://talent-acquisition-six.vercel.app').replace(/\/+$/, '');
    const ctx = liveSpeechContext && typeof liveSpeechContext === 'object' ? liveSpeechContext : {};
    const res = await fetch(`${base}/api/live-speech-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partial: false,
        finalize_only: true,
        session_id: sessionId,
        max_questions: maxQuestions,
        email: ctx.candidate_email || ctx.email,
        candidate_email: ctx.candidate_email || ctx.email,
        live_complete_webhook: ctx.live_complete_webhook || ctx.config?.live_complete_webhook || '',
        n8n_public_url: ctx.n8n_public_url || ctx.config?.n8n_public_url || '',
      }),
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
    if (!res.ok) throw new Error(`finalize failed (${res.status}): ${text.slice(0, 200)}`);
    return json;
  }

  function extractInterviewQuestion(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    t = t.replace(
      /\s*(?:thank you(?: for your time)?|thanks(?: for your time)?|we will be in touch|we'll be in touch|that completes the voice interview|that concludes(?: the interview)?|have a (?:great|good|nice) day)[^.?!]*[.?!]?\s*$/gi,
      ''
    ).trim();
    const sentences = t.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 2);
    const questionSentences = sentences.filter(
      (s) => s.includes('?') && s.split(/\s+/).filter(Boolean).length >= 4
    );
    if (questionSentences.length >= 1) return questionSentences[0].replace(/\s+/g, ' ').trim();
    return t.length >= 20 ? t : '';
  }

  function chooseQuestionText(streamed, final) {
    const streamRaw = String(streamed || '').replace(/\s+/g, ' ').trim();
    const finRaw = String(final || '').replace(/\s+/g, ' ').trim();
    if (!streamRaw) return extractInterviewQuestion(finRaw) || finRaw;
    if (!finRaw || finRaw === '…') return extractInterviewQuestion(streamRaw) || streamRaw;
    const norm = (s) => s.toLowerCase().replace(/[^\w\s?]/g, '').replace(/\s+/g, ' ').trim();
    if (norm(streamRaw) === norm(finRaw)) return extractInterviewQuestion(streamRaw) || streamRaw;
    if (norm(finRaw).includes(norm(streamRaw)) || norm(streamRaw).includes(norm(finRaw))) {
      const picked = streamRaw.length >= finRaw.length ? streamRaw : finRaw;
      return extractInterviewQuestion(picked) || picked;
    }
    if (streamRaw.includes('?') && streamRaw.split(/\s+/).filter(Boolean).length >= 6) {
      return extractInterviewQuestion(streamRaw) || streamRaw;
    }
    const picked = finRaw.length >= streamRaw.length ? finRaw : streamRaw;
    return extractInterviewQuestion(picked) || picked;
  }

  async function unlockAudioBeforeSession() {
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return false;
    try {
      const ctx = new Ctx();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(ctx.destination);
      const buffer = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      if (ctx.state === 'suspended') await ctx.resume();
      src.start(0);
      await new Promise((r) => setTimeout(r, 40));
      await ctx.close();
      return true;
    } catch (_) {
      return false;
    }
  }

  global.TA_LIVE = {
    LiveSpeechSession,
    fetchLiveSpeechStart,
    resolveRelayUrl,
    finalizeLiveSpeech,
    unlockAudioBeforeSession,
    sanitizeDisplayTranscript,
    looksLikeClosingMessage,
    chooseQuestionText,
    downsample,
    AUDIO_FLUSH_MS,
  };
})(typeof window !== 'undefined' ? window : globalThis);

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
      const idx = Math.floor(i * ratio);
      result[i] = buffer[idx] || 0;
    }
    return result;
  }

  class LiveSpeechSession {
    constructor(options) {
      this.relayUrl = parseWsUrl(options.relayUrl);
      this.context = options.context || {};
      this.onStatus = options.onStatus || (() => {});
      this.onTranscript = options.onTranscript || (() => {});
      this.onLevel = options.onLevel || (() => {});
      this.onTurn = options.onTurn || (() => {});
      this.onComplete = options.onComplete || (() => {});
      this.onInterviewComplete = options.onInterviewComplete || (() => {});
      this.onQuestion = options.onQuestion || (() => {});
      this.onAnswer = options.onAnswer || (() => {});
      this.onAwaitingAnswer = options.onAwaitingAnswer || (() => {});
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
      this.autoEndTimer = null;
    }

    // Candidate pressed "Answer" — open their mic and tell the relay to start the turn.
    beginAnswer() {
      if (this.ended || this.interviewEnded || this.answering) return;
      this.answering = true;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'user_turn_start' }));
      }
      this.setStatus('Listening — speak your answer now');
    }

    // Candidate pressed "Submit" — close their mic and let the interviewer respond.
    submitAnswer() {
      if (!this.answering) return;
      this.answering = false;
      this.onLevel(0);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'user_turn_end' }));
      }
      this.setStatus('Saving your answer…');
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

      await this.waitForType('ready', 30000);
      this.setStatus('Interviewer is starting…');
      await this.startMic();
      this.setStatus('Listen to the interviewer — the first question is coming');
    }

    waitForType(type, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
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

      if (msg.type === 'transcript' && msg.text && !msg.partial) {
        this.onTranscript({
          speaker: msg.speaker,
          text: msg.text,
          partial: false,
        });
      }
      if (msg.type === 'question') {
        this.onQuestion({ number: msg.number, text: msg.text });
      }
      if (msg.type === 'answer') {
        this.onAnswer({ number: msg.number, text: msg.text });
      }
      if (msg.type === 'awaiting_answer') {
        this.answering = false;
        this.onAwaitingAnswer({ number: msg.number, maxTurns: msg.maxTurns });
        this.setStatus(`Question ${msg.number} ready — press “Answer” to reply`);
      }
      if (msg.type === 'output_audio' && msg.data) {
        if (!this.answering) this.setStatus('Interviewer is speaking…');
        this.enqueuePlayback(msg.data, msg.mimeType || `audio/pcm;rate=${OUTPUT_RATE}`);
      }
      if (msg.type === 'turn_complete') {
        const capped = Math.min(msg.turn || 0, msg.maxTurns || 5);
        this.onTurn({ turn: capped, maxTurns: msg.maxTurns, answersGiven: msg.answersGiven });
      }
      if (msg.type === 'interview_complete') {
        this.stopMic();
        this.setStatus(`All ${msg.maxTurns || 5} questions complete — submitting your results…`);
        this.onInterviewComplete(msg);
        if (!this.autoEndTimer) {
          this.autoEndTimer = setTimeout(() => {
            if (!this.ended) {
              this.end()
                .then((result) => {
                  if (result) this.onComplete(result);
                })
                .catch((e) => this.onError(e));
            }
          }, 5000);
        }
      }
      if (msg.type === 'interviewer_started') {
        this.setStatus('Interviewer is speaking…');
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
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) throw new Error('AudioContext not supported');
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false,
      });
      this.audioCtx = new Ctx();
      this.source = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
      const inRate = this.audioCtx.sampleRate;

      this.processor.onaudioprocess = (e) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.ended || this.interviewEnded) return;
        if (!this.answering) return; // push-to-talk: only stream while the candidate is answering
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i += 1) sum += Math.abs(input[i]);
        this.onLevel(Math.min(1, (sum / input.length) * 8));

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
    }

    enqueuePlayback(b64, mimeType) {
      const rateMatch = /rate=(\d+)/i.exec(mimeType || '');
      const rate = rateMatch ? Number(rateMatch[1]) : OUTPUT_RATE;
      this.playQueue.push({ b64, rate });
      if (!this.playing) this.drainPlayback();
    }

    async drainPlayback() {
      if (!this.audioCtx || this.playing) return;
      this.playing = true;
      while (this.playQueue.length && !this.ended) {
        const chunk = this.playQueue.shift();
        const pcm = base64ToInt16(chunk.b64);
        const float = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i += 1) float[i] = pcm[i] / 0x8000;
        const buffer = this.audioCtx.createBuffer(1, float.length, chunk.rate);
        buffer.copyToChannel(float, 0);
        const src = this.audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.audioCtx.destination);
        const startAt = Math.max(this.audioCtx.currentTime, this.nextPlayTime);
        src.start(startAt);
        this.nextPlayTime = startAt + buffer.duration;
        await new Promise((r) => {
          src.onended = r;
        });
      }
      this.playing = false;
    }

    async end() {
      if (this.ended) return null;
      if (this.autoEndTimer) {
        clearTimeout(this.autoEndTimer);
        this.autoEndTimer = null;
      }
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
        const timer = setTimeout(() => reject(new Error('complete timeout')), 60000);
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
      this.cleanup();
      this.ended = true;
      return result;
    }

    cancel() {
      this.cleanup();
      this.ended = true;
    }

    cleanup() {
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
    return t;
  }

  global.TA_LIVE = {
    LiveSpeechSession,
    fetchLiveSpeechStart,
    resolveRelayUrl,
    sanitizeDisplayTranscript,
  };
})(typeof window !== 'undefined' ? window : globalThis);

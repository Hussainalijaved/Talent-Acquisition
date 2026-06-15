/**
 * Talent Acquisition — speech assessment helpers (browser)
 * Record → metrics → optional Supabase upload → transcript for n8n webhook
 */
(function (global) {
    'use strict';

    const FILLER_RE = /\b(um|uh|er|ah|like|you know|basically|actually)\b/gi;

    function computeMetrics(transcript, durationSeconds) {
        const text = String(transcript || '').trim();
        const words = text ? text.split(/\s+/).filter(Boolean) : [];
        const duration = Math.max(1, Number(durationSeconds) || 1);
        const fillers = (text.match(FILLER_RE) || []).length;
        return {
            duration_seconds: Math.round(duration),
            words_per_minute: Math.round((words.length / duration) * 60),
            filler_word_count: fillers,
            word_count: words.length,
        };
    }

    function speakQuestion(text) {
        const t = String(text || '').trim();
        if (!t || !global.speechSynthesis) return { cancel() {} };
        global.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(t);
        u.lang = 'en-US';
        u.rate = 0.95;
        global.speechSynthesis.speak(u);
        return { cancel() { global.speechSynthesis.cancel(); } };
    }

    function speakQuestionWithTypewriter(text, callbacks) {
        const t = String(text || '').trim();
        const { onUpdate, onStart, onEnd } = callbacks || {};
        let cancelled = false;
        let typeTimer = null;
        let boundarySeen = false;

        const finish = (full) => {
            if (typeTimer) clearInterval(typeTimer);
            typeTimer = null;
            if (!cancelled) {
                onUpdate?.(full || t);
                onEnd?.();
            }
        };

        const cancel = () => {
            cancelled = true;
            if (typeTimer) clearInterval(typeTimer);
            if (global.speechSynthesis) global.speechSynthesis.cancel();
        };

        if (!t) {
            onEnd?.();
            return { cancel };
        }

        onUpdate?.('');
        onStart?.();

        if (!global.speechSynthesis) {
            let i = 0;
            typeTimer = setInterval(() => {
                if (cancelled) return;
                i += 1;
                onUpdate?.(t.slice(0, i));
                if (i >= t.length) finish(t);
            }, 28);
            return { cancel };
        }

        global.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(t);
        u.lang = 'en-US';
        u.rate = 0.95;

        u.onboundary = (ev) => {
            if (cancelled) return;
            boundarySeen = true;
            const end = Math.min(t.length, Number(ev.charIndex || 0) + Number(ev.charLength || 1));
            onUpdate?.(t.slice(0, end));
        };

        u.onstart = () => {
            if (cancelled) return;
            onUpdate?.('');
            const cps = 13 * (u.rate || 1);
            let idx = 0;
            typeTimer = setInterval(() => {
                if (cancelled || boundarySeen) return;
                idx += 1;
                if (idx <= t.length) onUpdate?.(t.slice(0, idx));
                if (idx >= t.length) {
                    clearInterval(typeTimer);
                    typeTimer = null;
                }
            }, Math.max(20, Math.round(1000 / cps)));
        };

        u.onend = () => finish(t);
        u.onerror = () => finish(t);

        global.speechSynthesis.speak(u);
        return { cancel };
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function sanitizeTranscript(raw) {
        let text = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 20) return text;

        const words = text.split(' ');
        for (let win = Math.min(14, Math.floor(words.length / 2)); win >= 4; win--) {
            const tail = words.slice(-win).join(' ').toLowerCase();
            let repeats = 0;
            let pos = words.length - win;
            while (pos >= win) {
                const chunk = words.slice(pos - win, pos).join(' ').toLowerCase();
                if (chunk === tail) {
                    repeats++;
                    pos -= win;
                } else break;
            }
            if (repeats >= 2) {
                words.splice(words.length - win * repeats, win * repeats);
                text = words.join(' ');
                break;
            }
        }

        const maxLen = Math.min(100, Math.floor(text.length / 2));
        for (let len = maxLen; len >= 20; len--) {
            const sample = text.slice(0, len).trim();
            if (sample.length < 20) continue;
            const escaped = sample.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?:${escaped}[\\s,]*){2,}`, 'gi');
            if (re.test(text)) {
                text = text.replace(re, sample + ' ');
            }
        }

        return text.replace(/\s+/g, ' ').trim();
    }

    function isWeakTranscript(text) {
        const t = String(text || '').trim();
        if (!t) return true;
        if (/^\[(no speech detected|timeout)/i.test(t)) return true;
        return t.split(/\s+/).filter(Boolean).length < 4;
    }

    function createVolumeMeter(stream, onLevel) {
        if (!stream || !global.AudioContext) return { stop() {} };
        let ctx = null;
        let raf = 0;
        try {
            const Ctx = global.AudioContext || global.webkitAudioContext;
            ctx = new Ctx();
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);
            const tick = () => {
                analyser.getByteFrequencyData(data);
                let sum = 0;
                for (let i = 0; i < data.length; i++) sum += data[i];
                onLevel?.(sum / data.length / 255);
                raf = global.requestAnimationFrame(tick);
            };
            tick();
        } catch (err) {
            console.warn('Volume meter unavailable:', err);
        }
        return {
            stop() {
                if (raf) global.cancelAnimationFrame(raf);
                raf = 0;
                if (ctx) ctx.close().catch(() => {});
                ctx = null;
            },
        };
    }

    function runSttBurst(SR, durationMs, onInterim, onStatus) {
        return new Promise((resolve) => {
            if (!SR) {
                resolve('');
                return;
            }
            let rec = null;
            const pieces = [];
            let lastInterim = '';
            let settled = false;
            let stoppingBurst = false;

            const latestText = () => {
                const base = pieces.join(' ').trim();
                return (base && lastInterim) ? `${base} ${lastInterim}`.trim() : (base || lastInterim).trim();
            };

            const finish = () => {
                if (settled) return;
                settled = true;
                resolve(latestText());
            };

            const attachHandlers = () => {
                if (!rec) return;
                rec.onresult = (event) => {
                    let interim = '';
                    for (let i = event.resultIndex; i < event.results.length; i++) {
                        const r = event.results[i];
                        const piece = String(r[0]?.transcript || '').trim();
                        if (!piece) continue;
                        if (r.isFinal) pieces.push(piece);
                        else interim = interim ? `${interim} ${piece}` : piece;
                    }
                    if (interim) lastInterim = interim;
                    const combined = latestText();
                    if (combined && onInterim) onInterim(combined);
                };

                rec.onerror = (ev) => {
                    const code = String(ev?.error || 'unknown');
                    console.warn('SpeechRecognition error:', code);
                    if (code === 'not-allowed' || code === 'service-not-allowed') {
                        onStatus?.('stt_denied');
                    } else if (code === 'network') {
                        onStatus?.('stt_network');
                    } else if (code === 'audio-capture') {
                        onStatus?.('stt_audio_capture');
                    }
                    if (code === 'no-speech' || code === 'aborted') return;
                    if (!stoppingBurst) {
                        setTimeout(() => {
                            try {
                                rec.start();
                            } catch (_) {}
                        }, 300);
                    }
                };

                rec.onend = () => {
                    if (stoppingBurst) {
                        finish();
                        return;
                    }
                    setTimeout(() => {
                        if (stoppingBurst || settled) return;
                        try {
                            rec.start();
                        } catch (_) {
                            finish();
                        }
                    }, 200);
                };
            };

            try {
                rec = new SR();
            } catch (err) {
                console.warn('SpeechRecognition unavailable:', err);
                finish();
                return;
            }

            rec.lang = 'en-US';
            rec.continuous = true;
            rec.interimResults = true;
            rec.maxAlternatives = 1;
            attachHandlers();

            try {
                rec.start();
                onStatus?.('listening');
            } catch (err) {
                console.warn('SpeechRecognition start failed:', err);
                finish();
                return;
            }

            setTimeout(() => {
                stoppingBurst = true;
                try {
                    rec.stop();
                } catch (_) {
                    finish();
                }
            }, Math.max(1200, Number(durationMs) || 3000));
        });
    }

    function getAudioConstraints() {
        return {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        };
    }

    /**
     * Record one continuous audio take for the full session.
     * Browser STT cannot share the mic with MediaRecorder in Chrome — Whisper on submit handles transcript.
     */
    function createSpeechSession(callbacks) {
        const { onTranscript, onStatus, onLevel } = callbacks || {};
        const SR = global.SpeechRecognition || global.webkitSpeechRecognition;

        let active = false;
        let stopping = false;
        let stream = null;
        let mediaRecorder = null;
        let audioChunks = [];
        let currentMime = 'audio/webm';
        let startedAt = 0;
        let volumeMeter = null;

        const emit = (text) => {
            if (onTranscript) onTranscript(sanitizeTranscript(String(text || '')));
        };

        return {
            async start() {
                if (active) return;
                active = true;
                stopping = false;
                startedAt = Date.now();
                audioChunks = [];
                emit('');
                onStatus?.('starting');

                if (global.speechSynthesis) global.speechSynthesis.cancel();
                await wait(200);

                stream = await navigator.mediaDevices.getUserMedia(getAudioConstraints());
                volumeMeter = createVolumeMeter(stream, onLevel);
                currentMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? 'audio/webm;codecs=opus'
                    : 'audio/webm';
                mediaRecorder = new MediaRecorder(stream, { mimeType: currentMime });
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) audioChunks.push(e.data);
                };
                mediaRecorder.start(250);
                onStatus?.('recording');
            },

            getLatestText() {
                return '';
            },

            async stop() {
                stopping = true;
                active = false;

                let blob = null;
                const durationSeconds = (Date.now() - startedAt) / 1000;

                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    const recRef = mediaRecorder;
                    await new Promise((resolve) => {
                        recRef.onstop = () => resolve();
                        try {
                            recRef.stop();
                        } catch (_) {
                            resolve();
                        }
                        setTimeout(resolve, 3000);
                    });
                    blob = audioChunks.length
                        ? new Blob(audioChunks, { type: recRef.mimeType || currentMime || 'audio/webm' })
                        : null;
                }

                volumeMeter?.stop();
                volumeMeter = null;
                mediaRecorder = null;
                audioChunks = [];

                if (stream) {
                    stream.getTracks().forEach((t) => t.stop());
                    stream = null;
                }

                return { text, blob, durationSeconds };
            },

            cancel() {
                stopping = true;
                active = false;
                volumeMeter?.stop();
                volumeMeter = null;
                try {
                    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
                } catch (_) {}
                mediaRecorder = null;
                audioChunks = [];
                if (stream) {
                    stream.getTracks().forEach((t) => t.stop());
                    stream = null;
                }
            },
        };
    }

    function createRecorder(sharedStream) {
        let mediaRecorder = null;
        let audioChunks = [];
        let stream = sharedStream || null;
        let ownsStream = !sharedStream;
        let startedAt = 0;

        return {
            async start() {
                if (!stream) {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    ownsStream = true;
                }
                audioChunks = [];
                const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? 'audio/webm;codecs=opus'
                    : 'audio/webm';
                mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) audioChunks.push(e.data);
                };
                mediaRecorder.start(250);
                startedAt = Date.now();
            },
            async stop() {
                if (!mediaRecorder) return { blob: null, durationSeconds: 0 };
                const rec = mediaRecorder;
                const done = new Promise((resolve) => {
                    rec.onstop = () => resolve();
                });
                if (rec.state !== 'inactive') rec.stop();
                await done;
                if (stream && ownsStream) stream.getTracks().forEach((t) => t.stop());
                const blob = audioChunks.length
                    ? new Blob(audioChunks, { type: rec.mimeType || 'audio/webm' })
                    : null;
                const durationSeconds = (Date.now() - startedAt) / 1000;
                mediaRecorder = null;
                if (ownsStream) stream = null;
                audioChunks = [];
                return { blob, durationSeconds };
            },
            release() {
                if (stream && ownsStream) stream.getTracks().forEach((t) => t.stop());
                stream = null;
                mediaRecorder = null;
                audioChunks = [];
            },
        };
    }

    function createSpeechRecognizer(options) {
        const session = createSpeechSession({
            onTranscript: typeof options === 'function' ? options : options?.onTranscript,
        });
        return {
            start() {
                session.start();
            },
            getLatestText() {
                return session.getLatestText();
            },
            async stop() {
                const r = await session.stop();
                return r.text;
            },
        };
    }

    async function uploadAudio(supabaseClient, sessionId, phase, blob) {
        const empty = { url: '', path: '', saved: false, error: '' };
        if (!supabaseClient || !blob || !sessionId) {
            return { ...empty, error: blob ? 'missing_client' : 'missing_blob' };
        }
        if (blob.size < 200) {
            return { ...empty, error: 'blob_too_small' };
        }
        const path = `${sessionId}/phase_${phase}.webm`;
        const { error } = await supabaseClient.storage.from('assessment-audio').upload(path, blob, {
            upsert: true,
            contentType: blob.type || 'audio/webm',
        });
        if (error) {
            console.warn('Audio upload failed:', error.message);
            return { ...empty, path, error: error.message };
        }
        const { data: signed, error: signErr } = await supabaseClient.storage
            .from('assessment-audio')
            .createSignedUrl(path, 60 * 60 * 24 * 365);
        const url = signed?.signedUrl || '';
        if (!url && signErr) {
            console.warn('Signed URL failed:', signErr.message);
        }
        return {
            url: url || `storage://assessment-audio/${path}`,
            path,
            saved: true,
            error: signErr?.message || '',
        };
    }

    async function uploadAudioWithTimeout(supabaseClient, sessionId, phase, blob, timeoutMs) {
        const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000;
        return Promise.race([
            uploadAudio(supabaseClient, sessionId, phase, blob),
            wait(timeout).then(() => ({ url: '', path: '', saved: false, error: 'upload_timeout' })),
        ]);
    }

    global.TA_SPEECH = {
        computeMetrics,
        speakQuestion,
        speakQuestionWithTypewriter,
        sanitizeTranscript,
        isWeakTranscript,
        wait,
        createSpeechSession,
        createRecorder,
        createSpeechRecognizer,
        uploadAudio,
        uploadAudioWithTimeout,
    };
})(typeof window !== 'undefined' ? window : globalThis);

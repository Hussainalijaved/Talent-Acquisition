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

    /**
     * Unified speech session — STT first (live captions), then audio recorder.
     * Chrome blocks parallel mic capture; STT gets priority for live transcript.
     */
    function createSpeechSession(callbacks) {
        const { onTranscript, onStatus } = callbacks || {};
        const SR = global.SpeechRecognition || global.webkitSpeechRecognition;

        let active = false;
        let stopping = false;
        let stream = null;
        let mediaRecorder = null;
        let audioChunks = [];
        let startedAt = 0;
        let rec = null;
        const finalSegments = [];
        let recorderStarted = false;

        const buildText = (interim) => {
            const base = finalSegments.join(' ').trim();
            const combined = interim ? `${base} ${interim}`.trim() : base;
            return sanitizeTranscript(combined);
        };

        const emit = (interim) => {
            if (onTranscript) onTranscript(buildText(interim));
        };

        const startRecorder = async () => {
            if (!active || stopping || recorderStarted) return;
            try {
                if (!stream) {
                    stream = await navigator.mediaDevices.getUserMedia({
                        audio: { echoCancellation: true, noiseSuppression: true },
                    });
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
                recorderStarted = true;
                if (!startedAt) startedAt = Date.now();
                onStatus?.('recording');
            } catch (err) {
                onStatus?.('recorder_failed');
                console.warn('Speech recorder failed:', err);
            }
        };

        const startListening = () => {
            if (!SR || stopping || !active) return;
            try {
                rec = new SR();
            } catch (_) {
                rec = null;
                return;
            }
            rec.lang = 'en-US';
            rec.continuous = true;
            rec.interimResults = true;
            rec.maxAlternatives = 1;

            rec.onresult = (event) => {
                let interim = '';
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const r = event.results[i];
                    const piece = String(r[0]?.transcript || '').trim();
                    if (!piece) continue;
                    if (r.isFinal) {
                        finalSegments.push(piece);
                    } else {
                        interim = interim ? `${interim} ${piece}` : piece;
                    }
                }
                emit(interim);
            };

            rec.onerror = (ev) => {
                const code = String(ev?.error || '');
                if (code === 'no-speech' || code === 'aborted') return;
                if (!stopping && active && code !== 'not-allowed' && code !== 'service-not-allowed') {
                    setTimeout(() => startListening(), 400);
                }
            };

            rec.onend = () => {
                if (!stopping && active) {
                    setTimeout(() => startListening(), 250);
                }
            };

            try {
                rec.start();
                onStatus?.('listening');
            } catch (_) {
                rec = null;
            }
        };

        return {
            async start() {
                active = true;
                stopping = false;
                recorderStarted = false;
                startedAt = Date.now();
                finalSegments.length = 0;
                emit('');
                onStatus?.('starting');
                startListening();
                // STT gets exclusive mic access first; recorder starts after captions establish
                setTimeout(() => {
                    if (active && !stopping) startRecorder();
                }, 3500);
            },

            getLatestText() {
                return buildText('');
            },

            async stop() {
                stopping = true;
                active = false;
                const text = buildText('');

                if (rec) {
                    await new Promise((resolve) => {
                        const done = () => resolve();
                        try {
                            rec.onend = done;
                            rec.onerror = done;
                            rec.stop();
                        } catch (_) {
                            done();
                        }
                        setTimeout(done, 1000);
                    });
                    rec = null;
                }

                let blob = null;
                let durationSeconds = (Date.now() - startedAt) / 1000;
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    const recRef = mediaRecorder;
                    await new Promise((resolve) => {
                        recRef.onstop = () => resolve();
                        try {
                            recRef.stop();
                        } catch (_) {
                            resolve();
                        }
                    });
                    blob = audioChunks.length
                        ? new Blob(audioChunks, { type: recRef.mimeType || 'audio/webm' })
                        : null;
                }
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
                try {
                    rec?.stop();
                } catch (_) {}
                rec = null;
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

    // Legacy helpers kept for compatibility
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
            return { ...empty, error: 'missing_client_or_blob' };
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
        const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 12000;
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

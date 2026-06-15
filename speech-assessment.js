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

    function liveSanitize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function createRecorder() {
        let mediaRecorder = null;
        let audioChunks = [];
        let stream = null;
        let startedAt = 0;

        return {
            async start() {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });
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
                if (stream) stream.getTracks().forEach((t) => t.stop());
                const blob = audioChunks.length
                    ? new Blob(audioChunks, { type: rec.mimeType || 'audio/webm' })
                    : null;
                const durationSeconds = (Date.now() - startedAt) / 1000;
                mediaRecorder = null;
                stream = null;
                audioChunks = [];
                return { blob, durationSeconds };
            },
            release() {
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

    /** Live browser STT — onTranscript(text) fires as candidate speaks */
    function createSpeechRecognizer(options) {
        const onTranscript = typeof options === 'function' ? options : options?.onTranscript;
        const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
        if (!SR) {
            return {
                start() {},
                async stop() {
                    return '';
                },
            };
        }

        let rec = null;
        let finalized = '';
        let listening = false;

        const emit = (interim) => {
            const base = finalized.trim();
            const combined = interim ? `${base} ${interim}`.trim() : base;
            if (onTranscript) onTranscript(liveSanitize(combined));
        };

        return {
            start() {
                listening = true;
                finalized = '';
                emit('');
                rec = new SR();
                rec.lang = 'en-US';
                rec.continuous = true;
                rec.interimResults = true;
                rec.onresult = (e) => {
                    let interim = '';
                    for (let i = e.resultIndex; i < e.results.length; i++) {
                        const r = e.results[i];
                        const piece = String(r[0]?.transcript || '').trim();
                        if (!piece) continue;
                        if (r.isFinal) {
                            finalized = `${finalized} ${piece}`.replace(/\s+/g, ' ').trim();
                            interim = '';
                        } else {
                            interim = interim ? `${interim} ${piece}` : piece;
                        }
                    }
                    emit(interim);
                };
                rec.onerror = () => emit('');
                rec.onend = () => {
                    if (!listening) return;
                    setTimeout(() => {
                        if (!listening || !rec) return;
                        try {
                            rec.start();
                        } catch (_) {}
                    }, 200);
                };
                try {
                    rec.start();
                } catch (_) {
                    rec = null;
                }
            },
            async stop() {
                listening = false;
                if (!rec) return finalized.trim();
                return new Promise((resolve) => {
                    const done = () => resolve(finalized.trim());
                    rec.onend = done;
                    rec.onerror = done;
                    try {
                        rec.stop();
                    } catch (_) {
                        done();
                    }
                });
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
        liveSanitize,
        isWeakTranscript,
        wait,
        createRecorder,
        createSpeechRecognizer,
        uploadAudio,
        uploadAudioWithTimeout,
    };
})(typeof window !== 'undefined' ? window : globalThis);

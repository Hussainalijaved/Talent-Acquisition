/**
 * Talent Acquisition — speech assessment helpers (browser)
 * Record → metrics → optional Supabase upload → transcript for n8n webhook
 */
(function (global) {
    'use strict';

    const FILLER_RE = /\b(um|uh|er|ah|like|you know|basically|actually)\b/gi;

    function computeMetrics(transcript, durationSeconds, delivery) {
        const text = String(transcript || '').trim();
        const words = text ? text.split(/\s+/).filter(Boolean) : [];
        const duration = Math.max(1, Number(durationSeconds) || 1);
        const fillers = (text.match(FILLER_RE) || []).length;
        const d = delivery && typeof delivery === 'object' ? delivery : {};
        return {
            duration_seconds: Math.round(duration),
            words_per_minute: Math.round((words.length / duration) * 60),
            filler_word_count: fillers,
            word_count: words.length,
            long_pause_count: Number(d.long_pause_count) || 0,
            time_to_first_word_ms: Number(d.time_to_first_word_ms) || 0,
            avg_pause_ms: Number(d.avg_pause_ms) || 0,
        };
    }

    function createDeliveryAnalyzer(stream, options) {
        const onLevel = typeof options === 'function' ? options : options?.onLevel;
        if (!stream || !global.AudioContext) {
            return { stop() { return {}; } };
        }
        let ctx = null;
        let analyser = null;
        let raf = 0;
        let startedAt = 0;
        let firstSpeechAt = 0;
        let inPause = false;
        let pauseStart = 0;
        let longPauseCount = 0;
        const pauseDurations = [];
        const SILENCE = 0.028;
        const SPEECH = 0.05;
        const LONG_PAUSE_MS = 1200;

        const tick = () => {
            if (!analyser) return;
            const data = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const level = sum / data.length / 255;
            if (onLevel) onLevel(level);
            const now = Date.now();

            if (level >= SPEECH) {
                if (!firstSpeechAt) firstSpeechAt = now;
                if (inPause && pauseStart) {
                    const pauseMs = now - pauseStart;
                    if (pauseMs >= LONG_PAUSE_MS) {
                        longPauseCount += 1;
                        pauseDurations.push(pauseMs);
                    }
                    inPause = false;
                    pauseStart = 0;
                }
            } else if (level <= SILENCE) {
                if (!inPause) {
                    inPause = true;
                    pauseStart = now;
                }
            }

            raf = global.requestAnimationFrame(tick);
        };

        try {
            const Ctx = global.AudioContext || global.webkitAudioContext;
            ctx = new Ctx();
            const source = ctx.createMediaStreamSource(stream);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            startedAt = Date.now();
            tick();
        } catch (err) {
            console.warn('Delivery analyzer unavailable:', err);
        }

        return {
            stop() {
                if (raf) global.cancelAnimationFrame(raf);
                raf = 0;
                if (ctx) ctx.close().catch(() => {});
                ctx = null;
                analyser = null;
                const end = Date.now();
                if (inPause && pauseStart && end - pauseStart >= LONG_PAUSE_MS) {
                    longPauseCount += 1;
                    pauseDurations.push(end - pauseStart);
                }
                const avgPause = pauseDurations.length
                    ? Math.round(pauseDurations.reduce((a, b) => a + b, 0) / pauseDurations.length)
                    : 0;
                return {
                    long_pause_count: longPauseCount,
                    time_to_first_word_ms: firstSpeechAt ? Math.max(0, firstSpeechAt - startedAt) : 0,
                    avg_pause_ms: avgPause,
                };
            },
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

    function isLiveTranscriptUsable(text) {
        const t = String(text || '').trim();
        if (!t) return false;
        if (/^\[(no speech detected|timeout)/i.test(t)) return false;
        return t.split(/\s+/).filter(Boolean).length >= 1;
    }

    function liveSanitize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    const DEFAULT_TRANSCRIBE_URL = '/api/transcribe';

    function createSmoothTranscriptEmitter(onTranscript, wordDelayMs) {
        const delay = Number(wordDelayMs) > 0 ? Number(wordDelayMs) : 65;
        let targetText = '';
        let displayedText = '';
        let timer = null;

        const wordsOf = (text) => (String(text || '').trim() ? String(text).trim().split(/\s+/) : []);

        const commonWordPrefixLen = (a, b) => {
            const aw = wordsOf(a);
            const bw = wordsOf(b);
            let n = 0;
            while (n < aw.length && n < bw.length && aw[n].toLowerCase() === bw[n].toLowerCase()) n += 1;
            return n;
        };

        const publish = (text) => {
            displayedText = text;
            if (onTranscript) onTranscript(displayedText);
        };

        const tick = () => {
            timer = null;
            const target = liveSanitize(targetText);
            const displayed = liveSanitize(displayedText);
            if (!target) {
                publish('');
                return;
            }
            if (target === displayed) return;

            const shared = commonWordPrefixLen(displayed, target);
            const targetWords = wordsOf(target);
            const displayedWords = wordsOf(displayed);

            if (shared < displayedWords.length) {
                publish(targetWords.slice(0, shared).join(' '));
                timer = setTimeout(tick, Math.max(24, delay - 20));
                return;
            }
            if (shared < targetWords.length) {
                publish(targetWords.slice(0, shared + 1).join(' '));
                timer = setTimeout(tick, delay);
                return;
            }
            publish(target);
        };

        return {
            setTarget(text) {
                targetText = liveSanitize(text);
                if (!timer) tick();
            },
            flush() {
                if (timer) clearTimeout(timer);
                timer = null;
                targetText = liveSanitize(targetText);
                publish(targetText);
            },
            reset() {
                if (timer) clearTimeout(timer);
                timer = null;
                targetText = '';
                displayedText = '';
            },
        };
    }

    /** Browser STT with interim results — smooth live captions while MediaRecorder captures audio. */
    function createSpeechRecognizer(options) {
        const onTranscript = typeof options === 'function' ? options : options?.onTranscript;
        const onError = typeof options === 'object' ? options?.onError : null;
        const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
        if (!SR) {
            return {
                isSupported: false,
                start() {},
                async stop() {
                    return '';
                },
                cancel() {},
            };
        }

        let rec = null;
        let listening = false;
        let finalized = '';
        let restartTimer = null;

        const emit = (interim) => {
            const base = finalized.trim();
            const combined = interim ? `${base} ${interim}`.trim() : base;
            if (onTranscript) onTranscript(liveSanitize(combined));
        };

        const scheduleRestart = () => {
            if (!listening) return;
            if (restartTimer) clearTimeout(restartTimer);
            restartTimer = setTimeout(() => {
                restartTimer = null;
                if (!listening) return;
                try {
                    if (rec) {
                        rec.onend = null;
                        rec.onerror = null;
                        rec.stop();
                    }
                } catch (_) {}
                try {
                    rec = new SR();
                    rec.lang = 'en-US';
                    rec.continuous = true;
                    rec.interimResults = true;
                    rec.maxAlternatives = 1;
                    attach();
                    rec.start();
                } catch (err) {
                    onError?.(err);
                }
            }, 120);
        };

        const attach = () => {
            if (!rec) return;
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
            rec.onerror = (ev) => {
                const code = String(ev?.error || '');
                if (code === 'not-allowed' || code === 'service-not-allowed') {
                    listening = false;
                    onError?.(ev);
                    return;
                }
                if (listening) scheduleRestart();
            };
            rec.onend = () => {
                if (!listening) return;
                scheduleRestart();
            };
        };

        return {
            isSupported: true,
            start() {
                listening = true;
                finalized = '';
                emit('');
                rec = new SR();
                rec.lang = 'en-US';
                rec.continuous = true;
                rec.interimResults = true;
                rec.maxAlternatives = 1;
                attach();
                try {
                    rec.start();
                } catch (err) {
                    rec = null;
                    listening = false;
                    onError?.(err);
                }
            },
            async stop() {
                listening = false;
                if (restartTimer) {
                    clearTimeout(restartTimer);
                    restartTimer = null;
                }
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
            cancel() {
                listening = false;
                if (restartTimer) {
                    clearTimeout(restartTimer);
                    restartTimer = null;
                }
                if (!rec) return;
                try {
                    rec.onend = null;
                    rec.onerror = null;
                    rec.stop();
                } catch (_) {}
                rec = null;
                finalized = '';
            },
        };
    }

    /** Send an audio Blob to the server Whisper proxy and return its transcript. */
    async function transcribeBlob(blob, transcribeUrl, options) {
        const minBytes = Number(options?.minBytes) > 0 ? Number(options.minBytes) : 1200;
        if (!blob || blob.size < minBytes) return '';
        try {
            const res = await fetch(transcribeUrl || DEFAULT_TRANSCRIBE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'audio/webm' },
                body: blob,
            });
            if (!res.ok) {
                console.warn('Transcribe failed:', res.status);
                return '';
            }
            const data = await res.json();
            return String(data?.text || '').trim();
        } catch (err) {
            console.warn('Transcribe error:', err);
            return '';
        }
    }

    function mergeLiveTranscripts(...parts) {
        let best = '';
        for (const raw of parts) {
            const text = liveSanitize(raw);
            if (!text) continue;
            const words = text.split(/\s+/).filter(Boolean);
            const bestWords = best.split(/\s+/).filter(Boolean);
            if (words.length > bestWords.length) {
                best = text;
                continue;
            }
            if (words.length === bestWords.length && text.length > best.length) {
                best = text;
            }
        }
        return best;
    }

    /**
     * Records one continuous audio take with smooth live captions.
     * Browser SpeechRecognition shows interim words; Whisper windows run in parallel as backup.
     * Submit always uses Whisper on the full recording for accuracy.
     */
    function createLiveTranscriber(options) {
        const opts = options || {};
        const onTranscript = opts.onTranscript;
        const onStatus = opts.onStatus;
        const onMicLevel = opts.onMicLevel;
        const transcribeUrl = opts.transcribeUrl || DEFAULT_TRANSCRIBE_URL;
        const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : 1400;
        const preferBrowserLive = opts.preferBrowserLive !== false;

        let stream = null;
        let mediaRecorder = null;
        let deliveryAnalyzer = null;
        let speechRecognizer = null;
        let smoothEmitter = null;
        let chunks = [];
        let mime = 'audio/webm';
        let startedAt = 0;
        let timer = null;
        let busy = false;
        let active = false;
        let lastText = '';
        let browserLiveText = '';
        let whisperLiveText = '';
        let lastChunkCount = 0;
        let browserLiveActive = false;

        const publishLive = () => {
            const merged = mergeLiveTranscripts(browserLiveText, whisperLiveText);
            lastText = merged;
            if (onTranscript) onTranscript(lastText);
        };

        const runWindow = async () => {
            if (!active || busy || chunks.length === 0) return;
            if (chunks.length === lastChunkCount) return;
            lastChunkCount = chunks.length;
            busy = true;
            try {
                const blob = new Blob(chunks, { type: mime });
                const text = await transcribeBlob(blob, transcribeUrl, { minBytes: 700 });
                if (text && active && isLiveTranscriptUsable(text)) {
                    whisperLiveText = liveSanitize(text);
                    if (smoothEmitter && !browserLiveActive) {
                        smoothEmitter.setTarget(whisperLiveText);
                    } else {
                        publishLive();
                    }
                }
            } finally {
                busy = false;
            }
        };

        const teardownLive = () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            speechRecognizer?.cancel?.();
            speechRecognizer = null;
            smoothEmitter?.reset?.();
            smoothEmitter = null;
            browserLiveText = '';
            whisperLiveText = '';
            browserLiveActive = false;
        };

        return {
            async start() {
                if (active) return;
                active = true;
                chunks = [];
                lastText = '';
                browserLiveText = '';
                whisperLiveText = '';
                lastChunkCount = 0;
                publishLive();
                onStatus?.('starting');

                if (global.speechSynthesis) global.speechSynthesis.cancel();
                await wait(150);

                if (preferBrowserLive) {
                    speechRecognizer = createSpeechRecognizer({
                        onTranscript: (text) => {
                            if (!active) return;
                            browserLiveText = liveSanitize(text);
                            if (browserLiveText) browserLiveActive = true;
                            publishLive();
                        },
                        onError: () => {
                            browserLiveActive = false;
                        },
                    });
                    if (speechRecognizer.isSupported) {
                        speechRecognizer.start();
                    }
                }

                stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });
                deliveryAnalyzer = createDeliveryAnalyzer(stream, {
                    onLevel: (level) => {
                        if (active && onMicLevel) onMicLevel(level);
                    },
                });
                mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? 'audio/webm;codecs=opus'
                    : 'audio/webm';
                mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) chunks.push(e.data);
                };
                mediaRecorder.start(400);
                startedAt = Date.now();

                smoothEmitter = createSmoothTranscriptEmitter((text) => {
                    if (!active || browserLiveActive) return;
                    whisperLiveText = liveSanitize(text);
                    publishLive();
                }, 48);
                timer = setInterval(runWindow, windowMs);
                setTimeout(runWindow, 900);

                onStatus?.('recording');
            },

            getLatestText() {
                return lastText;
            },

            async stop() {
                active = false;
                const durationSeconds = (Date.now() - startedAt) / 1000;
                const delivery = deliveryAnalyzer?.stop?.() || {};
                deliveryAnalyzer = null;

                let browserText = '';
                if (speechRecognizer) {
                    browserText = await speechRecognizer.stop();
                }
                if (browserText) browserLiveText = liveSanitize(browserText);
                publishLive();
                teardownLive();

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
                }
                if (stream) {
                    stream.getTracks().forEach((t) => t.stop());
                    stream = null;
                }

                const blob = chunks.length ? new Blob(chunks, { type: mime }) : null;
                onStatus?.('transcribing');

                let text = lastText || browserText;
                const finalText = await transcribeBlob(blob, transcribeUrl);
                if (finalText) text = finalText;
                else if (browserText) text = browserText;

                mediaRecorder = null;
                return { text: sanitizeTranscript(text), blob, durationSeconds, delivery };
            },

            cancel() {
                active = false;
                teardownLive();
                if (deliveryAnalyzer) {
                    deliveryAnalyzer.stop();
                    deliveryAnalyzer = null;
                }
                try {
                    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
                } catch (_) {}
                mediaRecorder = null;
                chunks = [];
                lastText = '';
                if (stream) {
                    stream.getTracks().forEach((t) => t.stop());
                    stream = null;
                }
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
        isLiveTranscriptUsable,
        wait,
        transcribeBlob,
        createSpeechRecognizer,
        createSmoothTranscriptEmitter,
        mergeLiveTranscripts,
        createLiveTranscriber,
        uploadAudio,
        uploadAudioWithTimeout,
    };
})(typeof window !== 'undefined' ? window : globalThis);

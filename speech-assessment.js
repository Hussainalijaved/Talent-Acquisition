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

    /**
     * TTS + typewriter — question text appears as AI speaks.
     * callbacks: { onUpdate(text), onStart(), onEnd() }
     */
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

    function createRecorder() {
        let mediaRecorder = null;
        let audioChunks = [];
        let stream = null;
        let startedAt = 0;

        return {
            async start() {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        };
    }

    /** Live browser STT — onTranscript(text) fires as candidate speaks */
    function createSpeechRecognizer(options) {
        const onTranscript = typeof options === 'function' ? options : options?.onTranscript;
        const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
        if (!SR) {
            return {
                start() {},
                async stop() { return ''; },
            };
        }

        let rec = null;
        let finalized = '';

        const emit = () => {
            if (onTranscript) onTranscript(finalized.trim());
        };

        return {
            start() {
                finalized = '';
                emit();
                rec = new SR();
                rec.lang = 'en-US';
                rec.continuous = true;
                rec.interimResults = true;
                rec.onresult = (e) => {
                    let interim = '';
                    let finals = '';
                    for (let i = 0; i < e.results.length; i++) {
                        const r = e.results[i];
                        const piece = r[0]?.transcript || '';
                        if (r.isFinal) finals += piece;
                        else interim += piece;
                    }
                    if (finals) finalized += finals;
                    const combined = (finalized + interim).replace(/\s+/g, ' ').trim();
                    if (onTranscript) onTranscript(combined);
                };
                rec.onerror = () => emit();
                try {
                    rec.start();
                } catch (_) {
                    rec = null;
                }
            },
            async stop() {
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

    /** One-shot STT fallback */
    function transcribeWithWebSpeech(durationMs) {
        const recognizer = createSpeechRecognizer();
        recognizer.start();
        return new Promise((resolve) => {
            setTimeout(async () => {
                resolve(await recognizer.stop());
            }, Math.max(5000, durationMs || 15000));
        });
    }

    async function uploadAudio(supabaseClient, sessionId, phase, blob) {
        if (!supabaseClient || !blob || !sessionId) return '';
        const path = `${sessionId}/phase_${phase}.webm`;
        const { error } = await supabaseClient.storage.from('assessment-audio').upload(path, blob, {
            upsert: true,
            contentType: blob.type || 'audio/webm',
        });
        if (error) {
            console.warn('Audio upload failed:', error.message);
            return '';
        }
        const { data } = supabaseClient.storage.from('assessment-audio').getPublicUrl(path);
        return data?.publicUrl || '';
    }

    global.TA_SPEECH = {
        computeMetrics,
        speakQuestion,
        speakQuestionWithTypewriter,
        createRecorder,
        createSpeechRecognizer,
        transcribeWithWebSpeech,
        uploadAudio,
    };
})(typeof window !== 'undefined' ? window : globalThis);

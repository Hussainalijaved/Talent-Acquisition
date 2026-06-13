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
        if (!t || !global.speechSynthesis) return;
        global.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(t);
        u.lang = 'en-US';
        u.rate = 0.95;
        global.speechSynthesis.speak(u);
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

    /** Live browser STT — start before recording, stop after */
    function createSpeechRecognizer() {
        const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
        if (!SR) {
            return {
                start() {},
                async stop() { return ''; },
            };
        }

        let rec = null;
        let text = '';

        return {
            start() {
                text = '';
                rec = new SR();
                rec.lang = 'en-US';
                rec.continuous = true;
                rec.interimResults = true;
                rec.onresult = (e) => {
                    text = Array.from(e.results)
                        .map((r) => r[0].transcript)
                        .join(' ')
                        .trim();
                };
                try {
                    rec.start();
                } catch (_) {
                    rec = null;
                }
            },
            async stop() {
                if (!rec) return text.trim();
                return new Promise((resolve) => {
                    const done = () => resolve(text.trim());
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
        createRecorder,
        createSpeechRecognizer,
        transcribeWithWebSpeech,
        uploadAudio,
    };
})(typeof window !== 'undefined' ? window : globalThis);

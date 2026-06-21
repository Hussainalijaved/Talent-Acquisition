/**
 * Shared final assessment score — matches admin dashboard computeFinalOutcome.
 * Load in index.html (candidate portal) and dashboard.html.
 */
(function (global) {
    'use strict';

    function parseJson(raw, fallback) {
        if (raw == null) return fallback;
        if (typeof raw === 'object') return raw;
        try {
            return JSON.parse(raw);
        } catch (_) {
            return fallback;
        }
    }

    function parseHistory(sess) {
        let hist = sess?.interview_history;
        if (typeof hist === 'string') {
            try {
                hist = JSON.parse(hist);
            } catch (_) {
                hist = [];
            }
        }
        if (!Array.isArray(hist)) hist = [];
        return hist
            .map((item, index) => ({
                ...item,
                phase: item?.phase ?? index + 1,
                question_text: item?.question_text || item?.question || '',
                answer_text: item?.answer_text ?? item?.answer ?? null,
            }))
            .sort((a, b) => Number(a.phase || 0) - Number(b.phase || 0));
    }

    function inferTechMax(hist, cfg, sess) {
        const fromCfg = Number(cfg?.max_questions ?? sess?.max_phases);
        if (Number.isFinite(fromCfg) && fromCfg > 0) return fromCfg;
        const phases = hist.map((h) => Number(h.phase)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 20);
        return phases.length ? Math.max(...phases.filter((p) => p <= 10)) : 5;
    }

    function isSpeechPhaseRow(h, techMax) {
        const ph = Number(h?.phase);
        if (!Number.isFinite(ph) || ph <= techMax) return false;
        return h?.mode === 'live_speech' || ph > techMax;
    }

    function avgPhaseScore(hist) {
        const scores = hist
            .filter((h) => h && h.answer_text != null && h.score != null && !h.integrity_terminated)
            .map((h) => Number(h.score))
            .filter((n) => Number.isFinite(n));
        if (!scores.length) return null;
        return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    }

    function computeFinalOutcome(sess, hist, cfg) {
        hist = hist || parseHistory(sess);
        cfg = cfg || parseJson(sess?.config, {});
        const techMax = inferTechMax(hist, cfg, sess);
        const speechPhases = Number(cfg.speech_phases ?? 5);
        const techHist = hist.filter((h) => {
            const ph = Number(h.phase);
            return ph >= 1 && ph <= techMax;
        });
        const speechHist = hist.filter((h) => isSpeechPhaseRow(h, techMax));

        const techAvg = Number(sess?.technical_score) || avgPhaseScore(techHist);
        const speechAvg = Number(sess?.speech_score) || avgPhaseScore(speechHist);
        const tw = Number(cfg.technical_weight ?? 0.7);
        const sw = Number(cfg.speech_weight ?? 0.3);
        const pt = Number(cfg.pass_score_threshold ?? 60);

        let combined = null;
        if (techAvg != null && speechAvg != null) {
            combined = Math.round(techAvg * tw + speechAvg * sw);
        } else if (speechAvg != null) {
            combined = speechAvg;
        } else if (techAvg != null) {
            combined = techAvg;
        }

        const voiceAnswered = speechHist.filter((h) => h && String(h.answer_text || '').trim()).length;
        const voiceDone = speechPhases > 0 && voiceAnswered >= speechPhases;
        const hasBothAvgs = techAvg != null && speechAvg != null;
        const derived = !sess?.result && voiceDone && combined != null;

        // Prefer weighted combined when speech exists — session.score may still be CV screening score.
        let score = sess?.score ?? combined;
        if (combined != null && (derived || hasBothAvgs || sess?.assessment_stage === 'completed')) {
            score = combined;
        }

        let result = sess?.result || null;
        if (derived || (hasBothAvgs && combined != null && !result)) {
            result = combined >= pt ? 'PASS' : 'FAIL';
        } else if (hasBothAvgs && combined != null && result) {
            result = combined >= pt ? 'PASS' : 'FAIL';
        }

        return {
            score,
            result,
            techAvg,
            speechAvg,
            combined,
            passThreshold: pt,
            derived,
        };
    }

    global.TAFinalScore = {
        parseHistory,
        computeFinalOutcome,
    };
})(typeof window !== 'undefined' ? window : globalThis);

// Vercel serverless — live speech incremental + final save.
// Called directly by the relay server (Railway) so no n8n/ngrok needed.
//
// Per-turn  POST: { partial: true,  session_id, turns: [scored_turn] }
// Final     POST: { partial: false, session_id, turns: [all scored], combined_speech_score,
//                   final_feedback, duration_seconds, email, tab_switches }
//
// Required Vercel env vars (same names as other portal APIs):
//   SUPABASE_SERVICE_ROLE_KEY — service-role key for REST writes
//   SUPABASE_URL (optional)     — defaults to project Supabase URL

const TABLE = 'assessment_sessions';
const DEFAULT_SUPABASE_URL = 'https://vnxstyadacgntnsvcvzn.supabase.co';

function supabaseEnv() {
    const url = String(
        process.env.SUPABASE_URL || process.env.TA_SUPABASE_URL || DEFAULT_SUPABASE_URL
    ).replace(/\/+$/, '').trim();
    const key = String(
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_KEY ||
        ''
    ).trim();
    return { url, key };
}

function parseJsonSafe(raw, fallback) {
    if (raw == null) return fallback;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function buildHeaders(key) {
    return {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
    };
}

function avgPhaseScores(history, predicate) {
    const scores = (history || [])
        .filter(predicate)
        .map((h) => Number(h.score))
        .filter((n) => Number.isFinite(n));
    if (!scores.length) return null;
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function computeFinalScores(session, history, maxQ, sessCfg, body = {}) {
    const speechPhases = Number(sessCfg.speech_phases ?? 5);
    const techFromHistory = avgPhaseScores(history, (h) => {
        const ph = Number(h.phase);
        return ph >= 1 && ph <= maxQ;
    });
    const techAvg = Number(session.technical_score) || techFromHistory || 0;

    const speechFromHistory = avgPhaseScores(history, (h) => Number(h.phase) > maxQ);
    const speechScores = history
        .filter((h) => Number(h.phase) > maxQ && h.score != null && Number.isFinite(Number(h.score)))
        .map((h) => Number(h.score));
    const speechAvg = speechFromHistory
        ?? (speechScores.length
            ? Math.round(speechScores.reduce((a, b) => a + b, 0) / speechScores.length)
            : (Number(body.combined_speech_score) || 0));

    const tw = Number(sessCfg.technical_weight ?? 0.7);
    const sw = Number(sessCfg.speech_weight ?? 0.3);
    const pt = Number(sessCfg.pass_score_threshold ?? 60);
    const combined = techAvg > 0
        ? Math.round(techAvg * tw + speechAvg * sw)
        : speechAvg;
    const result = combined >= pt ? 'PASS' : 'FAIL';

    return {
        techAvg,
        speechAvg,
        combined,
        result,
        speechPhases,
        passThreshold: pt,
    };
}

async function loadAppConfigValue(sbUrl, sbKey, key) {
    try {
        const res = await fetch(
            `${sbUrl}/rest/v1/app_config?key=eq.${encodeURIComponent(key)}&select=value`,
            { headers: buildHeaders(sbKey) }
        );
        if (!res.ok) return '';
        const rows = await res.json();
        return String(Array.isArray(rows) ? rows[0]?.value : rows?.value || '').trim();
    } catch (_) {
        return '';
    }
}

function webhookFromN8nBase(base) {
    const b = String(base || '').trim().replace(/\/+$/, '');
    if (!b) return '';
    return `${b}/webhook/talent/live-speech-complete`;
}

function uniqueUrls(urls) {
    const seen = new Set();
    return urls.filter((u) => {
        const key = String(u || '').trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function resolveLiveCompleteWebhookUrls(sbUrl, sbKey, body = {}, session = {}) {
    const sessCfg = parseJsonSafe(session?.config, {});
    const candidates = [
        // Stable sources first — session-start ngrok URLs go stale quickly.
        process.env.N8N_LIVE_COMPLETE_WEBHOOK,
        process.env.LIVE_COMPLETE_WEBHOOK,
        await loadAppConfigValue(sbUrl, sbKey, 'live_complete_webhook'),
        webhookFromN8nBase(await loadAppConfigValue(sbUrl, sbKey, 'n8n_public_url')),
        sessCfg.live_complete_webhook,
        webhookFromN8nBase(sessCfg.n8n_public_url),
        body.live_complete_webhook,
        webhookFromN8nBase(body.n8n_public_url),
    ];
    return uniqueUrls(candidates.map((u) => String(u || '').trim()).filter(Boolean));
}

async function resolveLiveCompleteWebhook(sbUrl, sbKey, body = {}, session = {}) {
    const urls = await resolveLiveCompleteWebhookUrls(sbUrl, sbKey, body, session);
    return urls[0] || '';
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJsonWithTimeout(url, payload, timeoutMs = 90000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
    } finally {
        clearTimeout(timer);
    }
}

function speechTurnsFromHistory(history, maxQ) {
    return (history || [])
        .filter((h) => Number(h.phase) > maxQ)
        .map((h) => ({
            phase: h.phase,
            question_text: h.question_text || h.question || '',
            answer_text: h.answer_text || h.answer || '',
            score: h.score,
            feedback: h.feedback || null,
            soft_skills: h.soft_skills || null,
        }))
        .filter((t) => t.question_text || t.answer_text);
}

async function triggerCompleteWebhook({
    sbUrl, sbKey, sessionId, session, history, finals, body, maxQ,
}) {
    const urls = await resolveLiveCompleteWebhookUrls(sbUrl, sbKey, body, session);
    if (!urls.length) {
        console.warn(
            '[live-speech-save] complete webhook URL not configured — set N8N_LIVE_COMPLETE_WEBHOOK on Vercel or app_config.n8n_public_url in Supabase'
        );
        return false;
    }

    const turns = speechTurnsFromHistory(history, maxQ);
    if (!turns.length) {
        console.warn('[live-speech-save] complete webhook skipped — no speech turns in history');
        return false;
    }

    const email = String(
        body.email || body.candidate_email || session.candidate_email || session.email || ''
    ).trim();
    const payload = {
        session_id: sessionId,
        email,
        candidate_email: email,
        turns,
        combined_speech_score: finals.speechAvg,
        duration_seconds: Number(body.duration_seconds) || 0,
        final_feedback: String(body.final_feedback || 'Voice interview completed.'),
        tab_switches: Number(body.tab_switches) || 0,
        result: finals.result,
        score: finals.combined,
        technical_score: finals.techAvg,
        speech_score: finals.speechAvg,
        source: 'vercel_live_speech_save',
    };

    const maxAttempts = 3;
    for (const url of urls) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                console.log(
                    `[live-speech-save] POST complete webhook → ${url} ` +
                    `(attempt ${attempt}/${maxAttempts}, ${turns.length} turns, result=${finals.result})`
                );
                const whRes = await postJsonWithTimeout(url, payload, 90000);
                if (whRes.ok) {
                    console.log('[live-speech-save] complete webhook OK');
                    return true;
                }
                console.error(
                    '[live-speech-save] complete webhook failed',
                    whRes.status,
                    whRes.text.slice(0, 300)
                );
            } catch (err) {
                console.error('[live-speech-save] complete webhook error:', err.message);
            }
            if (attempt < maxAttempts) await sleep(1500 * attempt);
        }
    }
    return false;
}

function mergeTurns(history, newTurns, maxQ) {
    const merged = Array.isArray(history) ? [...history] : [];
    const iso = new Date().toISOString();
    for (const turn of (newTurns || [])) {
        const ph = Number(turn.phase);
        if (!Number.isFinite(ph) || ph <= maxQ) continue;

        const idx = merged.findIndex((x) => Number(x.phase) === ph);
        const existing = idx >= 0 ? merged[idx] : {};

        const incomingQ = String(turn.question_text || turn.question || '').trim();
        const incomingA = String(turn.answer_text || turn.transcript || turn.answer || '').trim();
        const hasNewScore = turn.score != null && Number.isFinite(Number(turn.score));
        const score = hasNewScore
            ? Math.max(0, Math.min(100, Math.round(Number(turn.score))))
            : (existing.score ?? null);
        const softSkills = turn.soft_skills
            || (hasNewScore
                ? {
                    // New scoring dimensions (communication-focused)
                    communication_clarity: Math.round(Number(turn.communication_clarity ?? turn.clarity ?? turn.score ?? 0)),
                    fluency:               Math.round(Number(turn.fluency               ?? turn.score ?? 0)),
                    confidence:            Math.round(Number(turn.confidence            ?? turn.score ?? 0)),
                    professionalism:       Math.round(Number(turn.professionalism       ?? turn.score ?? 0)),
                    english_proficiency:   Math.round(Number(turn.english_proficiency   ?? turn.score ?? 0)),
                    answer_relevance:      Math.round(Number(turn.answer_relevance      ?? turn.relevance ?? turn.score ?? 0)),
                }
                : (existing.soft_skills ?? null));

        const entry = {
            phase: ph,
            mode: 'live_speech',
            voice_question_number:
                Number(turn.voice_question_number || ph - maxQ) || existing.voice_question_number || null,
            question_text: incomingQ || String(existing.question_text || existing.question || '').trim(),
            answer_text: incomingA || String(existing.answer_text || '').trim(),
            received_at: turn.received_at || existing.received_at || iso,
            sent_at: turn.sent_at || existing.sent_at || iso,
            feedback: turn.feedback || existing.feedback || null,
            score,
            soft_skills: softSkills,
            stt_source: 'gemini_live',
            scoring_source: 'gemini_live_relay',
        };
        if (turn.time_limit_seconds != null && Number.isFinite(Number(turn.time_limit_seconds))) {
            entry.time_limit_seconds = Math.round(Number(turn.time_limit_seconds));
        } else if (existing.time_limit_seconds != null) {
            entry.time_limit_seconds = existing.time_limit_seconds;
        }
        if (turn.complexity_tier || existing.complexity_tier) {
            entry.complexity_tier = turn.complexity_tier || existing.complexity_tier;
        }

        if (idx >= 0) merged[idx] = { ...existing, ...entry };
        else merged.push(entry);
    }
    return merged;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

    const { url: sbUrl, key: sbKey } = supabaseEnv();

    if (!sbUrl || !sbKey) {
        console.error('[live-speech-save] SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) not set in Vercel env');
        res.status(500).json({ error: 'supabase_env_missing' });
        return;
    }

    const body = parseJsonSafe(req.body, {});
    const sessionId = String(body.session_id || '').trim();
    const turns     = Array.isArray(body.turns) ? body.turns : [];
    const finalizeOnly = body.finalize_only === true;
    const partial   = finalizeOnly ? false : (body.partial !== false);
    const maxQ      = Number(body.max_questions ?? 5);

    if (!sessionId) {
        res.status(400).json({ error: 'session_id required' });
        return;
    }
    if (!turns.length && partial && !finalizeOnly) {
        res.status(400).json({ error: 'turns[] required for partial save' });
        return;
    }

    try {
        const headers = buildHeaders(sbKey);

        // 1. Fetch current session row.
        const fetchRes = await fetch(
            `${sbUrl}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(sessionId)}&select=id,interview_history,technical_score,config,candidate_email,email,scheduling_status,result,status,speech_score`,
            { headers }
        );
        if (!fetchRes.ok) {
            const t = await fetchRes.text();
            res.status(502).json({ error: 'fetch_failed', status: fetchRes.status, detail: t.slice(0, 200) });
            return;
        }
        const rows = await fetchRes.json();
        const session = Array.isArray(rows) ? rows[0] : rows;
        if (!session?.id) {
            res.status(404).json({ error: 'session_not_found', session_id: sessionId });
            return;
        }

        const history = mergeTurns(
            parseJsonSafe(session.interview_history, []),
            turns,
            maxQ
        );
        const iso = new Date().toISOString();
        const lastPhase = turns.length
            ? Math.max(...turns.map((t) => Number(t.phase) || 0))
            : null;

        let patchBody;
        let finalScores = null;

        if (partial) {
            // Per-turn incremental save — keep status as 'assessment'.
            patchBody = {
                interview_history: history,
                updated_at:        iso,
                assessment_stage:  'live_speech',
                current_phase:     lastPhase || undefined,
                status:            'assessment',
            };
        } else {
            const sessCfg = parseJsonSafe(session.config, {});
            finalScores = computeFinalScores(session, history, maxQ, sessCfg, body);

            patchBody = {
                interview_history: history,
                updated_at:                   iso,
                assessment_stage:             'completed',
                current_phase:                maxQ + finalScores.speechPhases,
                status:                       'completed',
                technical_score:              finalScores.techAvg,
                speech_score:                 finalScores.speechAvg,
                score:                        finalScores.combined,
                result:                       finalScores.result,
            };

            if (finalScores.result === 'PASS') {
                const sched = String(session.scheduling_status || '').trim().toLowerCase();
                if (!sched || ['none', 'null'].includes(sched)) {
                    patchBody.scheduling_status = 'pending';
                    patchBody.scheduling_updated_at = iso;
                }
            }
        }

        // 2. PATCH session row.
        const patchRes = await fetch(
            `${sbUrl}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(sessionId)}`,
            { method: 'PATCH', headers, body: JSON.stringify(patchBody) }
        );
        if (!patchRes.ok) {
            const t = await patchRes.text();
            res.status(502).json({ error: 'patch_failed', status: patchRes.status, detail: t.slice(0, 200) });
            return;
        }

        const phase = lastPhase || null;
        console.log(`[live-speech-save] ${partial ? 'partial' : 'final'} OK — session ${sessionId} phase ${phase}`);

        if (finalScores) {
            let completeWebhookOk = false;
            try {
                completeWebhookOk = await triggerCompleteWebhook({
                    sbUrl,
                    sbKey,
                    sessionId,
                    session,
                    history,
                    finals: finalScores,
                    body,
                    maxQ,
                });
            } catch (whErr) {
                console.warn('[live-speech-save] complete webhook error:', whErr.message);
            }

            res.status(200).json({
                ok:      true,
                partial: false,
                session_id: sessionId,
                phase: lastPhase,
                turns_saved: turns.length,
                result: patchBody.result,
                score: patchBody.score,
                technical_score: patchBody.technical_score,
                speech_score: patchBody.speech_score,
                complete_webhook_ok: completeWebhookOk,
            });
            return;
        }

        res.status(200).json({
            ok:      true,
            partial: !!partial,
            session_id: sessionId,
            phase,
            turns_saved: turns.length,
        });

    } catch (err) {
        console.error('[live-speech-save] exception:', err.message);
        res.status(500).json({ error: 'exception', detail: String(err.message).slice(0, 300) });
    }
}

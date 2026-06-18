// Vercel serverless — live speech incremental + final save.
// Called directly by the relay server (Railway) so no n8n/ngrok needed.
//
// Per-turn  POST: { partial: true,  session_id, turns: [scored_turn] }
// Final     POST: { partial: false, session_id, turns: [all scored], combined_speech_score,
//                   final_feedback, duration_seconds, email, tab_switches }
//
// Required Vercel env vars:
//   SUPABASE_URL   — https://xxx.supabase.co
//   SUPABASE_KEY   — service-role key (or anon key with RLS allowing updates)

const TABLE = 'assessment_sessions';

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

function mergeTurns(history, newTurns, maxQ) {
    const merged = Array.isArray(history) ? [...history] : [];
    const iso = new Date().toISOString();
    for (const turn of (newTurns || [])) {
        const ph = Number(turn.phase);
        if (!Number.isFinite(ph) || ph <= maxQ) continue;
        const entry = {
            phase: ph,
            mode: 'live_speech',
            voice_question_number: Number(turn.voice_question_number || ph - maxQ) || null,
            question_text:  String(turn.question_text  || '').trim(),
            answer_text:    String(turn.answer_text    || '').trim(),
            received_at:    turn.received_at  || iso,
            sent_at:        turn.sent_at      || iso,
            feedback:       turn.feedback     || null,
            score:          turn.score != null && Number.isFinite(Number(turn.score))
                ? Math.max(0, Math.min(100, Math.round(Number(turn.score))))
                : null,
            soft_skills:    turn.soft_skills  || null,
            stt_source:     'gemini_live',
            scoring_source: 'gemini_live_relay',
        };
        const idx = merged.findIndex((x) => Number(x.phase) === ph);
        if (idx >= 0) {
            // Preserve existing score if new one is null.
            if (entry.score == null) entry.score = merged[idx].score ?? null;
            merged[idx] = { ...merged[idx], ...entry };
        } else {
            merged.push(entry);
        }
    }
    return merged;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

    const sbUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '').trim();
    const sbKey = String(process.env.SUPABASE_KEY || '').trim();

    if (!sbUrl || !sbKey) {
        console.error('[live-speech-save] SUPABASE_URL or SUPABASE_KEY not set in Vercel env');
        res.status(500).json({ error: 'supabase_env_missing' });
        return;
    }

    const body = parseJsonSafe(req.body, {});
    const sessionId = String(body.session_id || '').trim();
    const turns     = Array.isArray(body.turns) ? body.turns : [];
    const partial   = body.partial !== false; // default partial unless explicitly false
    const maxQ      = Number(body.max_questions ?? 5);

    if (!sessionId) {
        res.status(400).json({ error: 'session_id required' });
        return;
    }
    if (!turns.length && partial) {
        res.status(400).json({ error: 'turns[] required for partial save' });
        return;
    }

    try {
        const headers = buildHeaders(sbKey);

        // 1. Fetch current session row.
        const fetchRes = await fetch(
            `${sbUrl}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(sessionId)}&select=id,interview_history,technical_score,config`,
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
            // Final save — compute scores and mark completed.
            const sessCfg = parseJsonSafe(session.config, {});
            const techAvg  = Number(session.technical_score) || 0;
            const speechScores = history
                .filter((h) => Number(h.phase) > maxQ && h.score != null && Number.isFinite(Number(h.score)))
                .map((h) => Number(h.score));
            const speechAvg = speechScores.length
                ? Math.round(speechScores.reduce((a, b) => a + b, 0) / speechScores.length)
                : (Number(body.combined_speech_score) || 0);
            const tw  = Number(sessCfg.technical_weight    ?? 0.7);
            const sw  = Number(sessCfg.speech_weight       ?? 0.3);
            const pt  = Number(sessCfg.pass_score_threshold ?? 60);
            const combined = techAvg > 0
                ? Math.round(techAvg * tw + speechAvg * sw)
                : speechAvg;
            const result = combined >= pt ? 'PASS' : 'FAIL';
            const speechPhases = Number(sessCfg.speech_phases ?? 5);

            patchBody = {
                interview_history:            history,
                updated_at:                   iso,
                assessment_stage:             'completed',
                current_phase:                maxQ + speechPhases,
                status:                       'completed',
                technical_score:              techAvg,
                speech_score:                 speechAvg,
                score:                        combined,
                result,
                live_speech_duration_seconds: Number(body.duration_seconds) || null,
                tab_switches:                 Number(body.tab_switches)     || 0,
            };
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
        res.status(200).json({
            ok:      true,
            partial: !!partial,
            session_id: sessionId,
            phase,
            turns_saved: turns.length,
            ...(partial ? {} : { result: patchBody.result, score: patchBody.score }),
        });

    } catch (err) {
        console.error('[live-speech-save] exception:', err.message);
        res.status(500).json({ error: 'exception', detail: String(err.message).slice(0, 300) });
    }
}

// POST /api/proctor-log — text-only proctor activity (no image persistence)
// Body actions:
//   { action: "event", session_id, phase?, category, summary, suspicious? }
//   { action: "describe", session_id, phase?, screen_index?, frame_base64 }  — image discarded after AI
//   { action: "finalize", session_id }

import {
    appendProctorEntry,
    loadSession,
    normalizeReport,
    saveReport,
    supabaseEnv,
} from './lib/proctor-store.mjs';

const VISION_MODEL = 'gemini-2.0-flash';
const MAX_FRAME_BYTES = 900000;

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseBody(req) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
}

function stripDataUrl(b64) {
    const raw = String(b64 || '').trim();
    const m = /^data:image\/\w+;base64,(.+)$/i.exec(raw);
    return (m ? m[1] : raw).slice(0, MAX_FRAME_BYTES);
}

async function describeScreenWithGemini(apiKey, jpegBase64) {
    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const prompt =
        'This is a shared monitor during a proctored assessment. In 1-2 short factual English sentences, ' +
        'describe visible applications, windows, or content. Name apps if recognizable. ' +
        'If the screen is blank, black, desktop only, or appears minimized, say so. ' +
        'Do not identify people. Plain text only — no markdown.';

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                role: 'user',
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: 'image/jpeg', data: jpegBase64 } },
                ],
            }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 220 },
        }),
    });
    const json = await res.json();
    if (!res.ok) {
        throw new Error(json?.error?.message || `gemini_${res.status}`);
    }
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || '').join(' ').trim();
    return text || 'Shared screen visible but content could not be described.';
}

async function summarizeReportWithGemini(apiKey, entries) {
    const lines = (entries || []).slice(-80).map((e) => {
        const t = e.at ? new Date(e.at).toISOString().slice(11, 19) : '??:??:??';
        return `[${t}] (${e.category}) ${e.summary}`;
    }).join('\n');

    if (!lines.trim()) {
        return {
            summary: 'No proctoring activity was recorded for this session.',
            highlights: [],
        };
    }

    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                role: 'user',
                parts: [{
                    text:
                        'Summarize this proctoring activity log for a recruiter in 2-4 sentences. ' +
                        'Highlight suspicious moments (snipping tool, extra apps, focus loss, blank screen). ' +
                        'Respond as JSON: {"summary":"...","highlights":["..."]}\n\n' +
                        lines,
                }],
            }],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 400,
                responseMimeType: 'application/json',
            },
        }),
    });
    const json = await res.json();
    if (!res.ok) {
        throw new Error(json?.error?.message || `gemini_${res.status}`);
    }
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    try {
        const parsed = JSON.parse(raw);
        return {
            summary: String(parsed.summary || '').trim() || 'Proctoring log recorded.',
            highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 8) : [],
        };
    } catch (_) {
        return { summary: String(raw).slice(0, 600), highlights: [] };
    }
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'method_not_allowed' });
        return;
    }

    const { url: sbUrl, key: sbKey } = supabaseEnv();
    if (!sbUrl || !sbKey) {
        res.status(500).json({ ok: false, error: 'supabase_not_configured' });
        return;
    }

    try {
        const body = parseBody(req);
        const action = String(body.action || 'event').trim().toLowerCase();
        const sessionId = String(body.session_id || body.sessionId || '').trim();
        if (!sessionId) {
            res.status(400).json({ ok: false, error: 'session_id_required' });
            return;
        }

        if (action === 'event') {
            const result = await appendProctorEntry(sbUrl, sbKey, sessionId, {
                phase: body.phase,
                category: body.category,
                summary: body.summary,
                suspicious: body.suspicious,
                meta: body.meta,
            });
            res.status(200).json({ ok: true, entry: result.entry });
            return;
        }

        if (action === 'describe') {
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) {
                res.status(500).json({ ok: false, error: 'gemini_key_missing' });
                return;
            }
            const jpegBase64 = stripDataUrl(body.frame_base64 || body.frameBase64);
            if (!jpegBase64 || jpegBase64.length < 500) {
                res.status(400).json({ ok: false, error: 'frame_required' });
                return;
            }

            let description;
            try {
                description = await describeScreenWithGemini(apiKey, jpegBase64);
            } catch (err) {
                description = `Shared screen snapshot at ${new Date().toISOString()} — automated description unavailable.`;
                console.warn('[proctor-log] describe failed:', err.message);
            }

            const screenIdx = Number(body.screen_index ?? body.screenIndex ?? 0);
            const prefix = Number.isFinite(screenIdx) && screenIdx >= 0
                ? `Screen ${screenIdx + 1}: `
                : '';
            const result = await appendProctorEntry(sbUrl, sbKey, sessionId, {
                phase: body.phase,
                category: 'screen_content',
                summary: `${prefix}${description}`,
                suspicious: !!body.suspicious,
                meta: { screen_index: screenIdx },
            });
            res.status(200).json({ ok: true, entry: result.entry, description });
            return;
        }

        if (action === 'finalize') {
            const session = await loadSession(sbUrl, sbKey, sessionId);
            if (!session?.id) {
                res.status(404).json({ ok: false, error: 'session_not_found' });
                return;
            }
            const report = normalizeReport(session.proctor_report);
            if (report.finalized_at) {
                res.status(200).json({ ok: true, report, already_finalized: true });
                return;
            }

            const apiKey = process.env.GEMINI_API_KEY;
            let aiSummary = { summary: '', highlights: [] };
            if (apiKey && report.entries.length) {
                try {
                    aiSummary = await summarizeReportWithGemini(apiKey, report.entries);
                } catch (err) {
                    console.warn('[proctor-log] finalize summary failed:', err.message);
                    aiSummary.summary = `${report.entries.length} proctor event(s) recorded. ${report.suspicious_count} flagged suspicious.`;
                }
            } else if (report.entries.length) {
                aiSummary.summary = `${report.entries.length} proctor event(s) recorded. ${report.suspicious_count} flagged suspicious.`;
            } else {
                aiSummary.summary = 'No proctoring activity recorded.';
            }

            report.summary = aiSummary.summary;
            report.highlights = aiSummary.highlights;
            report.finalized_at = new Date().toISOString();
            await saveReport(sbUrl, sbKey, sessionId, report);
            res.status(200).json({ ok: true, report });
            return;
        }

        res.status(400).json({ ok: false, error: 'unknown_action' });
    } catch (err) {
        console.error('[proctor-log]', err.message);
        res.status(500).json({ ok: false, error: err.message || 'proctor_log_failed' });
    }
}

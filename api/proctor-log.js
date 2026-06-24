// POST /api/proctor-log — proctor activity log + optional snapshot storage
// Body actions:
//   { action: "event", session_id, phase?, category, summary, suspicious? }
//   { action: "describe", session_id, phase?, screen_index?, frame_base64 }  — image discarded after AI
//   { action: "finalize", session_id }

import {
    appendProctorEntry,
    loadSession,
    normalizeReport,
    saveReport,
    stripSnapshotBase64,
    supabaseEnv,
    uploadProctorSnapshot,
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

async function analyzeScreenWithGemini(apiKey, jpegBase64) {
    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const prompt =
        'This image is a shared monitor during a proctored job assessment. ' +
        'Return JSON only with keys: description (1-2 factual English sentences about visible apps/windows), ' +
        'apps (array of recognizable app or site names), ai_tool (true if ChatGPT, Claude, Copilot, Gemini, Perplexity, or similar AI assistant is visible), ' +
        'communication_app (true if Slack, Teams, Discord, WhatsApp, Telegram, Zoom chat, Gmail, Outlook, or similar messaging/email is visible), ' +
        'assessment_focused (true if only the assessment browser/test page is visible). ' +
        'Do not identify people.';

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
            generationConfig: {
                temperature: 0.15,
                maxOutputTokens: 320,
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
            description: String(parsed.description || '').trim() || 'Shared screen visible.',
            apps: Array.isArray(parsed.apps) ? parsed.apps.map((a) => String(a).trim()).filter(Boolean).slice(0, 6) : [],
            ai_tool: !!parsed.ai_tool,
            communication_app: !!parsed.communication_app,
            assessment_focused: !!parsed.assessment_focused,
        };
    } catch (_) {
        return {
            description: String(raw).slice(0, 400) || 'Shared screen visible.',
            apps: [],
            ai_tool: false,
            communication_app: false,
            assessment_focused: false,
        };
    }
}

function screenPrefix(screenIdx) {
    return Number.isFinite(screenIdx) && screenIdx >= 0 ? `Screen ${screenIdx + 1}` : 'Screen';
}

function classifyScreenAnalysis(analysis, screenIdx, forceSuspicious) {
    const prefix = screenPrefix(screenIdx);
    const apps = analysis.apps || [];
    const appLabel = apps.length ? ` (${apps.slice(0, 2).join(', ')})` : '';
    let category = 'screen_content';
    let suspicious = !!forceSuspicious;
    let summary = `${prefix}: ${analysis.description}`;

    if (analysis.ai_tool) {
        category = 'ai_tool';
        suspicious = true;
        summary = `Used AI tool${appLabel} — ${analysis.description}`;
    } else if (analysis.communication_app) {
        category = 'communication_app';
        suspicious = true;
        summary = `Used communication app${appLabel} — ${analysis.description}`;
    } else if (forceSuspicious) {
        suspicious = true;
        summary = `${prefix}: ${analysis.description}`;
    }

    const meta = {
        screen_index: Number.isFinite(screenIdx) ? screenIdx : null,
        apps,
        ai_tool: analysis.ai_tool,
        communication_app: analysis.communication_app,
        assessment_focused: analysis.assessment_focused,
        app_name: apps[0] || null,
    };
    return { category, suspicious, summary, meta };
}

function mapKeyboardCategory(category) {
    if (category === 'screenshot' || category === 'snipping_tool') return 'screenshot_tool';
    return category;
}

function buildViolationSummary(category, screenIdx, apps) {
    const prefix = Number.isFinite(screenIdx) && screenIdx >= 0 ? ` (Screen ${screenIdx + 1})` : '';
    const appTail = apps?.length ? ` — ${apps.slice(0, 2).join(', ')}` : '';
    const mapped = mapKeyboardCategory(category);
    const labels = {
        screenshot_tool: `Used screenshot tool${prefix}`,
        tab_switch: 'Left the assessment tab',
        window_blur: 'Switched to another window or app',
        devtools: 'Opened developer tools',
        blocked_shortcut: 'Used blocked keyboard shortcut',
        print_attempt: 'Attempted to print or save page',
        screen_blank: `Shared screen appears blank${prefix}`,
        screen_share_stopped: 'Stopped screen sharing',
        fullscreen_exit: 'Exited fullscreen mode',
        webcam_lost: 'Webcam turned off',
        camera_not_restored: 'Webcam not restored in time',
        ai_tool: `Used AI tool${prefix}${appTail}`,
        communication_app: `Used communication app${prefix}${appTail}`,
    };
    return labels[mapped] || labels[category] || String(category || 'Proctoring event');
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
            let meta = body.meta && typeof body.meta === 'object' ? { ...body.meta } : {};
            let category = mapKeyboardCategory(String(body.category || 'activity').slice(0, 64));
            let suspicious = body.suspicious != null ? !!body.suspicious : false;
            let summary = String(body.summary || '').trim();
            const frame = stripSnapshotBase64(body.frame_base64 || body.frameBase64);
            const webcam = stripSnapshotBase64(body.webcam_base64 || body.webcamBase64);
            const thumb = stripSnapshotBase64(body.thumb_base64 || body.thumbBase64);
            const screenIdx = meta.screen_index != null ? Number(meta.screen_index) : null;
            const apiKey = process.env.GEMINI_API_KEY;

            if (suspicious && frame && frame.length > 500 && apiKey
                && !['test_started', 'question_opened', 'session_start'].includes(category)) {
                try {
                    const analysis = await analyzeScreenWithGemini(apiKey, frame);
                    const classified = classifyScreenAnalysis(analysis, screenIdx, suspicious);
                    if (classified.category === 'ai_tool' || classified.category === 'communication_app') {
                        category = classified.category;
                        summary = classified.summary;
                        meta = { ...meta, ...classified.meta };
                    } else if (!summary) {
                        summary = buildViolationSummary(category, screenIdx, analysis.apps);
                    } else if (analysis.apps?.length) {
                        meta.apps = analysis.apps;
                        meta.app_name = analysis.apps[0];
                    }
                } catch (err) {
                    console.warn('[proctor-log] frame classify failed:', err.message);
                    if (!summary) summary = buildViolationSummary(category, screenIdx);
                }
            } else if (suspicious && !summary) {
                summary = buildViolationSummary(category, screenIdx);
            }

            if (category === 'screenshot_tool') {
                summary = buildViolationSummary('screenshot_tool', screenIdx);
            }
            if (category === 'test_started') {
                summary = 'Assessment test started.';
                suspicious = false;
            }
            if (category === 'question_opened') {
                const qNum = body.phase != null ? body.phase : meta.question_number;
                summary = qNum ? `Opened question ${qNum}.` : 'Opened question.';
                suspicious = false;
            }
            if (suspicious && ['tab_switch', 'window_blur', 'devtools', 'blocked_shortcut', 'print_attempt',
                'screen_blank', 'screen_share_stopped', 'fullscreen_exit', 'webcam_lost', 'camera_not_restored']
                .includes(category)) {
                summary = buildViolationSummary(category, screenIdx, meta.apps);
            }
            if (!summary) summary = buildViolationSummary(category, screenIdx, meta.apps) || 'Proctoring activity noted.';

            if (suspicious && frame && frame.length > 500) {
                try {
                    const uploaded = await uploadProctorSnapshot(sbUrl, sbKey, sessionId, frame, `${category}-screen`);
                    meta.snapshot_path = uploaded.path;
                    meta.snapshot_bucket = uploaded.bucket;
                    if (thumb && thumb.length > 200) meta.snapshot_thumb = thumb.slice(0, 80000);
                } catch (err) {
                    console.warn('[proctor-log] screen snapshot upload failed:', err.message);
                    meta.snapshot_error = 'upload_failed';
                }
            }
            if (suspicious && webcam && webcam.length > 500) {
                try {
                    const uploaded = await uploadProctorSnapshot(sbUrl, sbKey, sessionId, webcam, `${category}-webcam`);
                    meta.webcam_snapshot_path = uploaded.path;
                    meta.webcam_snapshot_bucket = uploaded.bucket;
                } catch (err) {
                    console.warn('[proctor-log] webcam snapshot upload failed:', err.message);
                }
            }

            const result = await appendProctorEntry(sbUrl, sbKey, sessionId, {
                phase: body.phase,
                category,
                summary,
                suspicious,
                meta: Object.keys(meta).length ? meta : undefined,
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

            let analysis;
            try {
                analysis = await analyzeScreenWithGemini(apiKey, jpegBase64);
            } catch (err) {
                analysis = {
                    description: `Shared screen snapshot — automated analysis unavailable.`,
                    apps: [],
                    ai_tool: false,
                    communication_app: false,
                    assessment_focused: false,
                };
                console.warn('[proctor-log] describe failed:', err.message);
            }

            const screenIdx = Number(body.screen_index ?? body.screenIndex ?? 0);
            const forceSuspicious = !!body.suspicious;
            const classified = classifyScreenAnalysis(analysis, screenIdx, forceSuspicious);

            if (!forceSuspicious && !classified.suspicious) {
                res.status(200).json({ ok: true, skipped: true, analysis });
                return;
            }

            let meta = classified.meta;
            const suspicious = classified.suspicious;
            const category = classified.category;
            const summary = classified.summary;
            if (suspicious) {
                try {
                    const uploaded = await uploadProctorSnapshot(sbUrl, sbKey, sessionId, jpegBase64, 'screen_content');
                    meta.snapshot_path = uploaded.path;
                    meta.snapshot_bucket = uploaded.bucket;
                    const thumb = stripSnapshotBase64(body.thumb_base64 || body.thumbBase64);
                    if (thumb && thumb.length > 200) meta.snapshot_thumb = thumb.slice(0, 80000);
                } catch (err) {
                    console.warn('[proctor-log] describe snapshot upload failed:', err.message);
                }
            }
            const result = await appendProctorEntry(sbUrl, sbKey, sessionId, {
                phase: body.phase,
                category,
                summary,
                suspicious,
                meta,
            });
            res.status(200).json({ ok: true, entry: result.entry, analysis });
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

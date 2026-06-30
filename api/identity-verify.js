// POST /api/identity-verify — Gemini face comparison (reference apply photo vs live webcam)
// Body: { session_id, webcam_base64, check_point?, phase?, webcam_thumb_base64? }

import { runIdentityCheck } from './lib/identity-verify.mjs';

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseBody(req) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
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

    try {
        const body = parseBody(req);
        const result = await runIdentityCheck({
            sessionId: body.session_id || body.sessionId,
            webcamBase64: body.webcam_base64 || body.webcamBase64,
            webcamThumbBase64: body.webcam_thumb_base64 || body.webcamThumbBase64,
            checkPoint: body.check_point || body.checkPoint || 'manual',
            phase: body.phase,
        });

        if (result.skipped) {
            res.status(200).json(result);
            return;
        }

        res.status(200).json({
            ok: true,
            verdict: result.comparison.verdict,
            confidence: result.comparison.confidence,
            same_person: result.comparison.same_person,
            check: result.check,
        });
    } catch (err) {
        console.error('[identity-verify]', err.message);
        res.status(500).json({ ok: false, error: err.message || 'identity_verify_failed' });
    }
}

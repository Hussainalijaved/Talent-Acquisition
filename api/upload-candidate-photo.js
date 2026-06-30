// POST /api/upload-candidate-photo — store candidate profile photo (careers apply form)
// Body: { email, file_name?, content_type?, image_base64 }
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { supabaseEnv } from './lib/proctor-store.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const BUCKET = 'candidate-photos';
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseBody(req) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
}

function stripDataUrl(raw) {
    const s = String(raw || '').trim();
    const m = /^data:([^;]+);base64,(.+)$/i.exec(s);
    if (m) return { mime: m[1].toLowerCase(), b64: m[2] };
    return { mime: '', b64: s };
}

function extFromMime(mime, fileName) {
    const map = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
    };
    if (map[mime]) return map[mime];
    const fromName = String(fileName || '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
    return fromName || 'jpg';
}

async function ensureBucket(sbUrl, sbKey) {
    const res = await fetch(`${sbUrl}/storage/v1/bucket`, {
        method: 'POST',
        headers: {
            apikey: sbKey,
            Authorization: `Bearer ${sbKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    });
    if (res.ok || res.status === 409) return;
    const text = await res.text();
    throw new Error(`bucket_create_failed (${res.status}): ${text.slice(0, 160)}`);
}

async function uploadPhoto(sbUrl, sbKey, path, bin, contentType) {
    const res = await fetch(`${sbUrl}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: {
            apikey: sbKey,
            Authorization: `Bearer ${sbKey}`,
            'Content-Type': contentType,
            'x-upsert': 'true',
        },
        body: bin,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`photo_upload_failed (${res.status}): ${text.slice(0, 200)}`);
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
    if (!sbKey) {
        res.status(500).json({ ok: false, error: 'service_role_missing' });
        return;
    }

    try {
        const body = parseBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        if (!email || !email.includes('@')) {
            res.status(400).json({ ok: false, error: 'email_required' });
            return;
        }

        const { mime, b64 } = stripDataUrl(body.image_base64);
        if (!b64) {
            res.status(400).json({ ok: false, error: 'image_required' });
            return;
        }

        const contentType = String(body.content_type || mime || 'image/jpeg').toLowerCase();
        if (!ALLOWED_TYPES.has(contentType)) {
            res.status(400).json({ ok: false, error: 'invalid_image_type' });
            return;
        }

        const bin = Buffer.from(b64, 'base64');
        if (bin.length < 100) {
            res.status(400).json({ ok: false, error: 'image_too_small' });
            return;
        }
        if (bin.length > MAX_BYTES) {
            res.status(413).json({ ok: false, error: 'image_too_large' });
            return;
        }

        const ext = extFromMime(contentType, body.file_name);
        const safeKey = email.replace(/[^a-z0-9]/gi, '_').slice(0, 64) || 'candidate';
        const path = `${safeKey}/${Date.now()}.${ext}`;

        await ensureBucket(sbUrl, sbKey);
        await uploadPhoto(sbUrl, sbKey, path, bin, contentType);

        const publicUrl = `${sbUrl}/storage/v1/object/public/${BUCKET}/${path}`;
        res.status(200).json({ ok: true, url: publicUrl, path });
    } catch (err) {
        console.error('[upload-candidate-photo]', err.message);
        res.status(500).json({ ok: false, error: 'upload_failed', detail: err.message.slice(0, 200) });
    }
}

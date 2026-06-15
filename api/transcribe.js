// Vercel serverless function — Groq Whisper transcription proxy.
// Frontend posts raw audio (audio/webm) here; we forward to Groq and return { text }.
// GROQ_API_KEY lives in Vercel project env vars (server-side, never exposed to candidates).

export const config = {
    api: { bodyParser: false },
};

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }

    const key = process.env.GROQ_API_KEY;
    if (!key) {
        res.status(500).json({ error: 'groq_key_missing' });
        return;
    }

    try {
        const buffer = await readRawBody(req);
        if (!buffer || buffer.length < 1200) {
            res.status(200).json({ text: '' });
            return;
        }

        const form = new FormData();
        form.append('file', new Blob([buffer], { type: 'audio/webm' }), 'answer.webm');
        form.append('model', 'whisper-large-v3-turbo');
        form.append('language', 'en');
        form.append('response_format', 'json');
        form.append('temperature', '0');

        const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
        });

        if (!groqRes.ok) {
            const detail = await groqRes.text();
            res.status(502).json({ error: 'groq_error', status: groqRes.status, detail: detail.slice(0, 500) });
            return;
        }

        const data = await groqRes.json();
        res.status(200).json({ text: String(data?.text || '').trim() });
    } catch (err) {
        res.status(500).json({ error: 'exception', detail: String(err?.message || err) });
    }
}

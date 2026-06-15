// Vercel serverless — Gemini multimodal speech scoring (audio + rubric prompt).
// POST JSON: { prompt, audio_url, is_final? }
// Requires GEMINI_API_KEY in Vercel env (server-side only).

const MODEL = 'gemini-2.0-flash';
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        res.status(500).json({ error: 'gemini_key_missing' });
        return;
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
        const prompt = String(body.prompt || '').trim();
        const audioUrl = String(body.audio_url || '').trim();

        if (!prompt || !audioUrl || !/^https?:\/\//i.test(audioUrl)) {
            res.status(400).json({ error: 'missing_prompt_or_audio_url' });
            return;
        }

        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) {
            res.status(502).json({ error: 'audio_fetch_failed', status: audioRes.status });
            return;
        }

        const buffer = Buffer.from(await audioRes.arrayBuffer());
        if (!buffer.length || buffer.length < 1200) {
            res.status(400).json({ error: 'audio_too_small' });
            return;
        }
        if (buffer.length > MAX_AUDIO_BYTES) {
            res.status(400).json({ error: 'audio_too_large' });
            return;
        }

        const mimeType = String(audioRes.headers.get('content-type') || 'audio/webm').split(';')[0].trim()
            || 'audio/webm';
        const audioBase64 = buffer.toString('base64');

        const geminiUrl =
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const geminiBody = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        {
                            inline_data: {
                                mime_type: mimeType.includes('audio') ? mimeType : 'audio/webm',
                                data: audioBase64,
                            },
                        },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
            },
        };

        const geminiRes = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiBody),
        });

        if (!geminiRes.ok) {
            const detail = await geminiRes.text();
            res.status(502).json({
                error: 'gemini_error',
                status: geminiRes.status,
                detail: detail.slice(0, 600),
            });
            return;
        }

        const geminiData = await geminiRes.json();
        const parts = geminiData?.candidates?.[0]?.content?.parts || [];
        const rawText = parts.map((p) => p?.text || '').join('').trim();

        if (!rawText) {
            res.status(502).json({ error: 'gemini_empty' });
            return;
        }

        let parsed;
        try {
            const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            parsed = JSON.parse(cleaned);
        } catch (_) {
            res.status(502).json({ error: 'gemini_parse_failed', raw: rawText.slice(0, 500) });
            return;
        }

        res.status(200).json({
            ok: true,
            scoring_source: 'audio+transcript',
            text: rawText,
            result: parsed,
        });
    } catch (err) {
        res.status(500).json({ error: 'exception', detail: String(err?.message || err) });
    }
}

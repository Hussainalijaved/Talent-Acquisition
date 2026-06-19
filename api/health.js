// GET /api/health — quick deploy/env check (no secrets exposed).
const DEFAULT_SUPABASE_URL = 'https://vnxstyadacgntnsvcvzn.supabase.co';

function supabaseReady() {
    const url = String(
        process.env.SUPABASE_URL || process.env.TA_SUPABASE_URL || DEFAULT_SUPABASE_URL
    ).trim();
    const key = String(
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_KEY ||
        ''
    ).trim();
    return !!(url && key);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const ready = supabaseReady();

    res.status(200).json({
        ok: true,
        service: 'talent-acquisition-portal',
        supabase_configured: ready,
        live_speech_save_ready: ready,
    });
}

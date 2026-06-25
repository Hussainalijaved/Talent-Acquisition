# Live Speech Relay Server

WebSocket bridge between the candidate portal and **Gemini Live API**.

```
Browser (live-speech.js)
    ↔  ws://localhost:8080/live   (this server)
    ↔  Gemini Live (GEMINI_API_KEY)
    →  POST n8n /webhook/talent/live-speech-complete (on session end)
```

## Quick start (local)

1. Copy env file:

```bash
cd relay
copy .env.example .env
```

2. Set `GEMINI_API_KEY` in `.env` (same key as Vercel `GEMINI_API_KEY`).

3. Start relay:

```bash
npm install
npm start
```

4. n8n **CFG - Live Speech Config** → set:

```
live_relay_url = ws://localhost:8080/live
```

For local portal testing, `index.html` already has fallback `LIVE_SPEECH_RELAY_FALLBACK = ws://localhost:8080/live`.

5. Test health:

```
http://localhost:8080/health
```

## Production deploy (Railway — recommended)

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Set **Root Directory** to `relay`
3. Environment variables:
   - `GEMINI_API_KEY` = your Google AI Studio key
   - `ALLOWED_ORIGINS` = `https://talent-acquisition-six.vercel.app`
   - `PORTAL_BASE_URL` = `https://talent-acquisition-six.vercel.app`  ← **required for DB save**
   - `PORT` = `8080` (Railway sets automatically)
4. After deploy, copy public URL e.g. `https://talent-relay-production.up.railway.app`
5. n8n CFG:

```
live_relay_url = wss://talent-relay-production.up.railway.app/live
```

> **Save flow:** Relay → POST `https://talent-acquisition-six.vercel.app/api/live-speech-save` → Supabase.
> No ngrok, no n8n needed for DB save. Vercel env vars `SUPABASE_URL` + `SUPABASE_KEY` must be set.

Railway gives HTTPS — use **`wss://`** not `ws://`.

## Alternative: Render

1. New **Web Service** → root `relay`, build `npm install`, start `npm start`
2. Instance type: at least 512MB (WebSocket sessions)
3. Same env vars as Railway

## Alternative: ngrok (quick test without deploy)

```bash
cd relay
npm start
# another terminal:
ngrok http 8080
```

n8n CFG:

```
live_relay_url = wss://YOUR-ID.ngrok-free.app/live
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google AI Studio API key |
| `PORT` | No | Default `8080` |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins (`*` = all) |
| `GEMINI_LIVE_MODEL` | No | Default `gemini-2.5-flash-native-audio-preview-12-2025` |
| `GEMINI_TEXT_MODEL` | No | Question bank + timer AI, default `gemini-2.5-flash` |
| `GEMINI_SCORE_MODEL` | No | Post-session scoring, default `gemini-2.5-flash` |
| `PORTAL_BASE_URL` | **Yes** | Vercel URL e.g. `https://talent-acquisition-six.vercel.app` — relay posts saves here |
| `LIVE_COMPLETE_WEBHOOK` | No | n8n webhook URL for email notifications (DB save works without this) |

## Flow

1. Portal calls n8n `live-speech-start` → gets `system_instruction`, `live_relay_url`, `live_complete_webhook`
2. Portal opens WebSocket to relay → `session.start`
3. Relay opens Gemini Live WS with `GEMINI_API_KEY`
4. Mic audio streamed as PCM 16kHz
5. Model audio played back to browser (24kHz PCM)
6. User clicks **End** → relay scores turns → POST `live-speech-complete` → n8n mail/scheduling

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `GEMINI_API_KEY not configured` | Set env on relay host |
| `relay connection timeout` | Relay not running or wrong `live_relay_url` |
| `live-speech-start failed` | n8n Live Speech workflow not Active |
| No audio from interviewer | Check browser autoplay; use headphones |
| `complete_webhook_failed` | n8n ngrok URL wrong in CFG `n8n_public_url` |

## Files

| File | Purpose |
|------|---------|
| `server.mjs` | HTTP + WebSocket server |
| `lib/gemini-live.mjs` | Gemini Live WS bridge |
| `lib/score-turns.mjs` | Score turns + POST n8n complete |
| `../live-speech.js` | Browser client |

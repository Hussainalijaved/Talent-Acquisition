# Live Speech n8n Workflow — Import & Connect

Import file: **`Talent Acquisition — Live Speech.json`**

## 1. Import in n8n

1. n8n → **Workflows** → **Import from file**
2. Select `Talent Acquisition — Live Speech.json`
3. Open **CFG - Live Speech Config (start)** and **(complete)** — update:
   - `n8n_public_url` → your ngrok / public n8n URL (no trailing slash)
   - `live_relay_url` → your Gemini Live WebSocket relay (e.g. `wss://your-relay.run.app/live`)
   - `portal_base_url` → Vercel app URL
4. **Gmail** credential on `MAIL - Reply candidate (assessment result)`
5. Ensure n8n env: `SUPABASE_SERVICE_ROLE_KEY`
6. **Activate** the workflow (Production URLs)

## 2. Webhook URLs (Production)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhook/talent/live-speech-start` | POST | Load session + return Gemini Live context |
| `/webhook/talent/live-speech-complete` | POST | Save turns, score, email result |

Full URL example:
```
https://YOUR-NGROK.ngrok-free.dev/webhook/talent/live-speech-start
https://YOUR-NGROK.ngrok-free.dev/webhook/talent/live-speech-complete
```

## 3. Start webhook — request body

```json
{
  "session_id": "uuid-from-assessment_sessions",
  "email": "candidate@example.com"
}
```

**Response** (for relay / portal):

```json
{
  "ok": true,
  "session_id": "...",
  "system_instruction": "...",
  "gemini_live_model": "gemini-2.5-flash-native-audio-preview-12-2025",
  "live_relay_url": "wss://...",
  "live_complete_webhook": "https://.../webhook/talent/live-speech-complete",
  "speech_phases": 5,
  "current_phase": 6,
  "requisition_title": "Senior Developer",
  "assessment_mode": "live_speech"
}
```

## 4. Complete webhook — request body

Relay posts this when the live voice session ends:

```json
{
  "session_id": "uuid",
  "email": "candidate@example.com",
  "turns": [
    {
      "phase": 6,
      "question_text": "Tell me about...",
      "answer_text": "Candidate transcript...",
      "score": 72,
      "clarity": 75,
      "confidence": 70,
      "professionalism": 74,
      "relevance": 68,
      "feedback": "Clear structure, good examples."
    }
  ],
  "combined_speech_score": 71,
  "session_audio_url": "https://supabase.../optional-recording.webm",
  "duration_seconds": 420,
  "final_feedback": "Strong communicator overall.",
  "tab_switches": 0
}
```

Phases **6–10** = speech turns when `max_questions` = 5 (technical phases 1–5 already in `interview_history`).

**Response:**

```json
{
  "score": 68,
  "feedback": "...",
  "isFinal": true,
  "result": "PASS",
  "assessment_mode": "live_speech",
  "speech_phases": 5
}
```

## 5. Connect to existing Assessment workflow

**Option A — Standalone (recommended first)**

- Technical phases still use `Assessment + Speech` workflow (`/webhook/assessment-answer`)
- After technical `isFinal` + `startSpeech`, portal calls **live-speech-start** instead of record/submit UI
- When live session ends, relay calls **live-speech-complete** (this workflow handles PATCH + result mail)

**Option B — Disable old speech branch**

In `Talent Acquisition — Assessment + Speech + Scheduling.json`:

- Bypass or disable: `IF - Speech mode?` → `CODE - Build Speech LLM context` → Vertex/Gemini per-phase chain
- Keep: technical branch, `Pick Parse Result`, PATCH, scheduling on PASS

## 6. Companion code files (edit in repo, re-paste into n8n if needed)

| File | n8n node |
|------|----------|
| `n8n_code_normalize_live_speech_start.js` | CODE - Normalize Live Speech Start |
| `n8n_code_build_live_speech_relay_context.js` | CODE - Build Live Speech Relay Context |
| `n8n_code_normalize_live_speech_complete.js` | CODE - Normalize Live Speech Complete |
| `n8n_code_parse_live_speech_result.js` | CODE - Parse Live Speech Result |

Regenerate JSON after edits:

```bash
node build_live_speech_workflow.mjs
```

## 7. Relay server (required for live voice)

See **`relay/README.md`** for full deploy steps.

```bash
cd relay
copy .env.example .env   # set GEMINI_API_KEY
npm install
npm start                # ws://localhost:8080/live
```

Production: deploy `relay/` folder to Railway/Render → set n8n `live_relay_url` to `wss://YOUR-APP/live`.

## 8. Still needed

- **WebSocket relay server** — bridges browser ↔ Gemini Live API (Vercel cannot hold long WS)
- **Portal UI** — `live-speech.js` wired in `index.html` (live voice view)

Until relay + UI exist, you can test webhooks with curl/Postman using sample `turns[]`.

## 8. Quick test (complete)

```bash
curl -X POST "https://YOUR-NGROK/webhook/talent/live-speech-complete" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"YOUR-SESSION-UUID","email":"test@example.com","turns":[{"phase":6,"question_text":"Why this role?","answer_text":"Because...","score":70}]}'
```

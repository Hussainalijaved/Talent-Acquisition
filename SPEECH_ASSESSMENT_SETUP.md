# Speech Assessment — setup

Technical phases **1–5** (typed) then communication phases **6–8** (voice) on the same `assessment-answer` webhook.

## 1. Supabase SQL

Run in order:

1. `supabase_speech_assessment.sql`
2. Create Storage bucket **`assessment-audio`** (private) in Supabase Dashboard

## 2. n8n workflow

1. Build JSON:
   ```bash
   node scripts/build_assessment_speech_workflow.mjs
   ```
2. Import **`Talent Acquisition — Assessment + Speech + Scheduling.json`**
3. Set credentials (Gmail, Vertex, Calendar — same as threaded mail workflow)
4. **Deactivate** old `Assessment + Scheduling (Threaded Mail)` workflow (avoid duplicate webhook)
5. Activate the new workflow

Webhook path unchanged: `POST /webhook/assessment-answer`

## 3. Live transcription (Groq Whisper via Vercel) — REQUIRED

Speech transcription now runs on the **frontend** through a Vercel serverless function
(`api/transcribe.js`). This avoids the Chrome limitation where MediaRecorder and browser
speech recognition cannot share the mic (which left the live captions empty).

How it works:

1. Candidate records one continuous audio take.
2. Every ~4.5s the audio so far is sent to `/api/transcribe` → Groq Whisper → **live captions update**.
3. On submit, the full audio is transcribed once more (most accurate) and that text is sent
   to the n8n webhook as `answer`. **No n8n `$env` / CFG key needed** — the workflow just scores the text.

### Set the key in Vercel (one time)

1. Vercel dashboard → your project → **Settings → Environment Variables**
2. Add `GROQ_API_KEY` = your Groq key (same value CV screening uses), scope: Production + Preview
3. **Redeploy** so the function picks it up

The key stays server-side in the Vercel function and is never exposed to candidates.

> The n8n `CFG - Assessment Config` `groq_api_key` field and the Whisper fallback in
> `n8n_code_build_speech_llm_context.js` are now optional (backend fallback only).
> Because the frontend already sends a real transcript, `stt_source` will read `browser`
> with proper `answer_text` instead of `[Audio recorded]`.

## 4. Config (CFG node or session.config)

| Key | Default | Meaning |
|-----|---------|---------|
| `speech_enabled` | `true` | After tech PASS, start speech round |
| `speech_phases` | `3` | Voice questions (phases 6–8) |
| `technical_weight` | `0.7` | Combined score weight |
| `speech_weight` | `0.3` | Combined score weight |

## 5. Frontend

- `index.html` + `speech-assessment.js` — mic record, TTS play question, browser STT preview
- Payload adds: `assessment_mode: "speech"`, `audio_url`, `speech_metrics`

## 6. Flow

```
Phase 1–5 text → technical PASS → Phase 6–8 speech
→ combined score → result email → scheduling (if PASS)
```

## 7. Production STT

Browser STT is a fallback. For better accuracy, add OpenAI Whisper API on frontend or a small API route and send `answer` as Whisper transcript.

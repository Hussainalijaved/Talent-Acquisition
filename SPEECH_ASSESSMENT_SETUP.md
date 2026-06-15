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

### Speech branch wiring (after import)

The build script adds **`IF - Speech audio scored?`** between `CODE - Build Speech LLM context` and the LLM chain:

- **True** (`skip_llm_chain === true`) → `CODE - Parse Speech Result` (audio already scored via Vercel)
- **False** → `Basic LLM Chain Speech` → `CODE - Parse Speech Result` (existing text-only Vertex fallback)

Paste latest code into these nodes if you edit `.js` files locally:

- `CODE - Build Speech LLM context` ← `n8n_code_build_speech_llm_context.js`
- `CODE - Parse Speech Result` ← `n8n_code_parse_speech_result.js`

## 3. Live transcription (Groq Whisper via Vercel) — REQUIRED

Speech transcription runs on the **frontend** through `api/transcribe.js` (Groq Whisper).

1. Candidate records one continuous audio take.
2. Every ~4.5s audio is sent to `/api/transcribe` → **live captions update**.
3. On submit, full audio is transcribed again and sent to n8n as `answer`.

### Vercel env: `GROQ_API_KEY`

1. Vercel → project → **Settings → Environment Variables**
2. Add `GROQ_API_KEY` (same key as CV screening), scope: Production + Preview
3. **Redeploy**

## 4. Audio-based scoring (Gemini multimodal via Vercel) — REQUIRED for real voice judging

Communication scores (clarity, confidence, professionalism, relevance) are judged from **audio + transcript**, not text alone.

Flow:

1. Frontend uploads audio → `audio_url` in webhook payload
2. `CODE - Build Speech LLM context` calls **`/api/score-speech`** with the rubric prompt + signed audio URL
3. Gemini listens to the recording and returns JSON scores
4. On success: `skip_llm_chain: true` — Vertex text chain is **skipped**
5. On failure: falls back to **Basic LLM Chain Speech** (text-only Vertex — same as before)

### Vercel env: `GEMINI_API_KEY`

1. Add `GEMINI_API_KEY` in Vercel (Google AI Studio / Gemini API key)
2. Scope: Production + Preview
3. **Redeploy** after adding

The key stays server-side; candidates never see it.

### CFG keys (optional overrides)

| Key | Default | Meaning |
|-----|---------|---------|
| `portal_base_url` | `https://talent-acquisition-six.vercel.app` | Used to derive `/api/score-speech` if `speech_score_url` empty |
| `speech_score_url` | `{portal}/api/score-speech` | Full URL for audio scoring API |
| `groq_api_key` | `$env.GROQ_API_KEY` | n8n Whisper backup when frontend transcript is weak |

## 5. Config (CFG node or session.config)

| Key | Default | Meaning |
|-----|---------|---------|
| `speech_enabled` | `true` | After tech PASS, start speech round |
| `speech_phases` | `3` | Voice questions (phases 6–8) |
| `technical_weight` | `0.7` | Combined score weight |
| `speech_weight` | `0.3` | Combined score weight |

## 6. Frontend

- `index.html` + `speech-assessment.js` — mic record, TTS question, live Whisper captions
- Payload: `assessment_mode: "speech"`, `audio_url`, `speech_metrics` (WPM, fillers, pauses, time-to-first-word)

## 7. Flow

```
Phase 1–5 text → technical PASS → Phase 6–8 speech
→ audio scoring (Gemini) or text fallback (Vertex)
→ combined score → result email → scheduling (if PASS)
```

## 8. Verify in Supabase

After a speech submit, `interview_history` for that phase should show:

- `answer_audio_url` — signed URL
- `stt_source` — `browser` or `whisper`
- `scoring_source` — `audio+transcript` (success) or `text-only` (fallback)
- `soft_skills` — clarity, confidence, professionalism, relevance

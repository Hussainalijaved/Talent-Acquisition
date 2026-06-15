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

## 3. Groq API key (speech Whisper + same as CV screening)

CV screening and JD Generate already use **`GROQ_API_KEY`** in n8n environment variables.

Speech Whisper uses the **same key** — wired in `CFG - Assessment Config`:

```
groq_api_key = {{ $env.GROQ_API_KEY }}
```

**You do NOT set the key inside Code nodes.** Set it once:

1. n8n → **Settings** → **Environment variables** (or `.env` on self-hosted)
2. Add: `GROQ_API_KEY` = your Groq key (same value CV screening uses)
3. In workflow **`CFG - Assessment Config`** confirm field `groq_api_key` exists
4. Paste latest `n8n_code_build_speech_llm_context.js` into **`CODE - Build Speech LLM context`**

After speech submit, `interview_history` should show `stt_source: "whisper"` when audio was transcribed.

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

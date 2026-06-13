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

## 3. Config (CFG node or session.config)

| Key | Default | Meaning |
|-----|---------|---------|
| `speech_enabled` | `true` | After tech PASS, start speech round |
| `speech_phases` | `3` | Voice questions (phases 6–8) |
| `technical_weight` | `0.7` | Combined score weight |
| `speech_weight` | `0.3` | Combined score weight |

## 4. Frontend

- `index.html` + `speech-assessment.js` — mic record, TTS play question, browser STT preview
- Payload adds: `assessment_mode: "speech"`, `audio_url`, `speech_metrics`

## 5. Flow

```
Phase 1–5 text → technical PASS → Phase 6–8 speech
→ combined score → result email → scheduling (if PASS)
```

## 6. Production STT

Browser STT is a fallback. For better accuracy, add OpenAI Whisper API on frontend or a small API route and send `answer` as Whisper transcript.

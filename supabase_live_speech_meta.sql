-- Optional live speech metadata (run in Supabase SQL editor)
-- Tab shift count is NOT a column — it lives in proctor_report JSON (tab_switches + entries).

ALTER TABLE public.assessment_sessions
  ADD COLUMN IF NOT EXISTS live_speech_duration_seconds INTEGER;

ALTER TABLE public.assessment_sessions
  ADD COLUMN IF NOT EXISTS live_speech_audio_url TEXT;

COMMENT ON COLUMN public.assessment_sessions.live_speech_duration_seconds IS
  'Total seconds of live Gemini voice interview';

COMMENT ON COLUMN public.assessment_sessions.live_speech_audio_url IS
  'Optional URL to full session audio recording (Storage or external)';

-- proctor_report JSON holds tab_switches summary — see supabase_proctor_report.sql

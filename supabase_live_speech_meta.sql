-- Optional live speech metadata (run in Supabase SQL editor if you want duration/tab tracking)
ALTER TABLE public.assessment_sessions
  ADD COLUMN IF NOT EXISTS live_speech_duration_seconds INTEGER;

ALTER TABLE public.assessment_sessions
  ADD COLUMN IF NOT EXISTS tab_switches INTEGER DEFAULT 0;

COMMENT ON COLUMN public.assessment_sessions.live_speech_duration_seconds IS
  'Total seconds of live Gemini voice interview';

COMMENT ON COLUMN public.assessment_sessions.tab_switches IS
  'Tab/window focus switches detected during live speech';

-- Speech assessment columns on assessment_sessions
ALTER TABLE assessment_sessions
  ADD COLUMN IF NOT EXISTS assessment_stage TEXT DEFAULT 'technical';

ALTER TABLE assessment_sessions
  ADD COLUMN IF NOT EXISTS technical_score INTEGER;

ALTER TABLE assessment_sessions
  ADD COLUMN IF NOT EXISTS speech_score INTEGER;

COMMENT ON COLUMN assessment_sessions.assessment_stage IS
  'technical | speech | completed';

COMMENT ON COLUMN assessment_sessions.technical_score IS
  'Average score from technical phases 1–5 before speech round';

COMMENT ON COLUMN assessment_sessions.speech_score IS
  'Average score from communication speech phases';

-- Private bucket for candidate audio (create in Supabase Storage UI if not exists)
-- Name: assessment-audio
-- Public: false
-- RLS: service role write; recruiters read via signed URLs

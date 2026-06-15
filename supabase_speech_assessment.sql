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
-- Name: assessment-audio | Public: false

-- Storage policies (run after creating bucket in Dashboard)
INSERT INTO storage.buckets (id, name, public)
VALUES ('assessment-audio', 'assessment-audio', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Candidates upload assessment audio" ON storage.objects;
CREATE POLICY "Candidates upload assessment audio"
ON storage.objects FOR INSERT TO anon, authenticated
WITH CHECK (bucket_id = 'assessment-audio');

DROP POLICY IF EXISTS "Candidates update own assessment audio" ON storage.objects;
CREATE POLICY "Candidates update own assessment audio"
ON storage.objects FOR UPDATE TO anon, authenticated
USING (bucket_id = 'assessment-audio')
WITH CHECK (bucket_id = 'assessment-audio');

DROP POLICY IF EXISTS "Staff read assessment audio" ON storage.objects;
CREATE POLICY "Staff read assessment audio"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'assessment-audio');

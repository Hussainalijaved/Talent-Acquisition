-- Candidate profile photos (careers apply form)
-- Run once in Supabase SQL editor.

INSERT INTO storage.buckets (id, name, public)
VALUES ('candidate-photos', 'candidate-photos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Anon upload candidate photos" ON storage.objects;
CREATE POLICY "Anon upload candidate photos"
ON storage.objects FOR INSERT TO anon
WITH CHECK (bucket_id = 'candidate-photos');

DROP POLICY IF EXISTS "Anon update candidate photos" ON storage.objects;
CREATE POLICY "Anon update candidate photos"
ON storage.objects FOR UPDATE TO anon
USING (bucket_id = 'candidate-photos')
WITH CHECK (bucket_id = 'candidate-photos');

DROP POLICY IF EXISTS "Public read candidate photos" ON storage.objects;
CREATE POLICY "Public read candidate photos"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'candidate-photos');

DROP POLICY IF EXISTS "Staff read candidate photos" ON storage.objects;
CREATE POLICY "Staff read candidate photos"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'candidate-photos');

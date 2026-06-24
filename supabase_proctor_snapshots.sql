-- Proctor snapshot storage (screen/webcam captures on flagged events)
INSERT INTO storage.buckets (id, name, public)
VALUES ('proctor-snapshots', 'proctor-snapshots', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Service upload proctor snapshots" ON storage.objects;
CREATE POLICY "Service upload proctor snapshots"
ON storage.objects FOR INSERT TO authenticated, anon
WITH CHECK (bucket_id = 'proctor-snapshots');

DROP POLICY IF EXISTS "Service update proctor snapshots" ON storage.objects;
CREATE POLICY "Service update proctor snapshots"
ON storage.objects FOR UPDATE TO authenticated, anon
USING (bucket_id = 'proctor-snapshots')
WITH CHECK (bucket_id = 'proctor-snapshots');

DROP POLICY IF EXISTS "Staff read proctor snapshots" ON storage.objects;
CREATE POLICY "Staff read proctor snapshots"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'proctor-snapshots');

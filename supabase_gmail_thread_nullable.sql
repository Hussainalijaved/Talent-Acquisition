-- Allow assessment_sessions without Gmail thread until shortlist MAIL+PATCH runs.
-- Run once in Supabase SQL Editor.

ALTER TABLE assessment_sessions
  ALTER COLUMN gmail_thread_id DROP NOT NULL;

-- Multiple portal-only sessions can coexist (UNIQUE allows many NULLs).
-- Re-apply with same Gmail thread uses upsert on gmail_thread_id in n8n.

ALTER TABLE assessment_sessions
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

COMMENT ON COLUMN assessment_sessions.gmail_thread_id IS
  'Gmail thread id when outreach uses Gmail; null OK until MAIL+PATCH sets real thread.';

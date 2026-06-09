-- Optional: allow assessment_sessions without Gmail thread (pass mail removed / portal-only flow)
-- Run in Supabase SQL Editor if PATCH still fails or you want null gmail_thread_id.

ALTER TABLE assessment_sessions
  ALTER COLUMN gmail_thread_id DROP NOT NULL;

COMMENT ON COLUMN assessment_sessions.gmail_thread_id IS
  'Gmail thread id when outreach uses Gmail; null OK for portal-only assessment flow.';

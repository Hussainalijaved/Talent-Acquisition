-- Gmail threading columns for candidate + interviewer email chains
-- Run once in Supabase SQL Editor

ALTER TABLE assessment_sessions
  ADD COLUMN IF NOT EXISTS gmail_message_id text,
  ADD COLUMN IF NOT EXISTS mail_subject text,
  ADD COLUMN IF NOT EXISTS interviewer_gmail_thread_id text,
  ADD COLUMN IF NOT EXISTS interviewer_gmail_message_id text,
  ADD COLUMN IF NOT EXISTS interviewer_mail_subject text;

COMMENT ON COLUMN assessment_sessions.gmail_message_id IS
  'Latest Gmail message id in candidate thread (for In-Reply-To on next candidate mail).';

COMMENT ON COLUMN assessment_sessions.mail_subject IS
  'Original candidate thread subject from shortlist mail.';

COMMENT ON COLUMN assessment_sessions.interviewer_gmail_thread_id IS
  'Gmail thread id for interviewer scheduling conversation.';

COMMENT ON COLUMN assessment_sessions.interviewer_gmail_message_id IS
  'Latest message id in interviewer thread.';

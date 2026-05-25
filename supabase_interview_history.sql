-- Store all assessment Q&A in assessment_sessions.interview_history (JSONB array).
-- You can stop writing to assessment_questions; optional backfill below.

ALTER TABLE assessment_sessions
  ADD COLUMN IF NOT EXISTS interview_history JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE assessment_sessions
  ADD COLUMN IF NOT EXISTS result TEXT;

COMMENT ON COLUMN assessment_sessions.interview_history IS
  'Array of { phase, question_text, answer_text, sent_at, received_at, deadline_at, time_limit_seconds, timed_out, score, suggested_answer, feedback, ... }';

-- Optional: migrate existing rows from assessment_questions into interview_history
-- UPDATE assessment_sessions s
-- SET interview_history = COALESCE(
--   (
--     SELECT jsonb_agg(
--       jsonb_build_object(
--         'phase', q.phase,
--         'question_text', q.question_text,
--         'answer_text', q.answer_text,
--         'sent_at', q.sent_at,
--         'received_at', q.received_at,
--         'response_time_seconds', q.response_time_seconds,
--         'is_too_fast', q.is_too_fast,
--         'ai_likelihood', q.ai_likelihood,
--         'ai_reason', q.ai_reason,
--         'score', NULL,
--         'suggested_answer', NULL,
--         'feedback', NULL
--       ) ORDER BY q.phase
--     )
--     FROM assessment_questions q
--     WHERE q.session_id = s.id
--   ),
--   '[]'::jsonb
-- )
-- WHERE interview_history = '[]'::jsonb OR interview_history IS NULL;

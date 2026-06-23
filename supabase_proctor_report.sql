-- Text-only proctor activity report (no images stored)
-- Run once in Supabase SQL Editor

ALTER TABLE public.assessment_sessions
  ADD COLUMN IF NOT EXISTS proctor_report jsonb DEFAULT NULL;

COMMENT ON COLUMN public.assessment_sessions.proctor_report IS
  'Text proctor log: { entries: [{at, phase, category, summary, suspicious?}], summary?, finalized_at?, suspicious_count? }';

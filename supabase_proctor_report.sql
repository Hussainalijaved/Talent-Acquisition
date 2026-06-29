-- Text-only proctor activity report (no images stored)
-- Run once in Supabase SQL Editor

ALTER TABLE public.assessment_sessions
  ADD COLUMN IF NOT EXISTS proctor_report jsonb DEFAULT NULL;

COMMENT ON COLUMN public.assessment_sessions.proctor_report IS
  'Proctor log JSON: { entries: [...], tab_switches?: number, summary?, suspicious_count? }';

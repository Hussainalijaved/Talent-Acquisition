-- Frontend-driven interview scheduling (no n8n WAIT nodes)
-- Run once in Supabase SQL Editor

ALTER TABLE public.assessment_sessions
  ADD COLUMN IF NOT EXISTS scheduling_status text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS proposed_slots jsonb,
  ADD COLUMN IF NOT EXISTS chosen_slot jsonb,
  ADD COLUMN IF NOT EXISTS scheduling_updated_at timestamptz;

COMMENT ON COLUMN public.assessment_sessions.scheduling_status IS
  'none | pending_interviewer | slots_proposed | candidate_invited | confirmed | done';

COMMENT ON COLUMN public.assessment_sessions.proposed_slots IS
  'Interviewer-proposed slots [{start_iso,end_iso,label}] — written by interviewer.html';

COMMENT ON COLUMN public.assessment_sessions.chosen_slot IS
  'Candidate-selected slot object — written by candidate-pick.html';

-- anon policies (assessment_sessions) — safe to re-run
DROP POLICY IF EXISTS "anon_read_assessment_sessions" ON public.assessment_sessions;
CREATE POLICY "anon_read_assessment_sessions"
  ON public.assessment_sessions FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_update_assessment_sessions" ON public.assessment_sessions;
CREATE POLICY "anon_update_assessment_sessions"
  ON public.assessment_sessions FOR UPDATE TO anon USING (true) WITH CHECK (true);

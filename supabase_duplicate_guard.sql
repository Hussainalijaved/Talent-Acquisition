-- Prevent duplicate active applications per email + job (race-safe backup to n8n duplicate gate).
-- Run once in Supabase SQL Editor.

create unique index if not exists candidates_one_active_per_job_idx
  on public.candidates (lower(candidate_email), lower(requisition_id))
  where stage in ('Shortlisted', 'ReviewQueue');

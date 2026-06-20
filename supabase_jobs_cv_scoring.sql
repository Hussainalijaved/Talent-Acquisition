-- Per-job CV screening shortlist threshold.
-- Run once in Supabase SQL Editor (after supabase_jobs_scoring.sql if already applied).

alter table public.jobs
  add column if not exists cv_shortlist_threshold integer not null default 62
    check (cv_shortlist_threshold >= 0 and cv_shortlist_threshold <= 100);

comment on column public.jobs.cv_shortlist_threshold is
  'Minimum CV role-fit score (0–100) to shortlist for assessment. Default 62.';

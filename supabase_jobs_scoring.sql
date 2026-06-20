-- Per-job assessment pass threshold (combined technical + voice score).
-- Run once in Supabase SQL Editor after supabase_jobs.sql / supabase_jobs_expand.sql

alter table public.jobs
  add column if not exists pass_score_threshold integer not null default 60
    check (pass_score_threshold >= 0 and pass_score_threshold <= 100),
  add column if not exists fail_score_threshold integer not null default 30
    check (fail_score_threshold >= 0 and fail_score_threshold <= 100);

comment on column public.jobs.pass_score_threshold is
  'Minimum combined assessment score (0–100) to PASS. Default 60.';
comment on column public.jobs.fail_score_threshold is
  'Score below this (0–100) is a hard FAIL during phased assessment. Default 30.';

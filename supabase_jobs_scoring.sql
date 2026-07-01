-- DEPRECATED: use app_config.default_pass_score_thresholds (Settings → Assessment scoring).
-- Per-job pass threshold removed — only cv_shortlist_threshold remains on jobs (see supabase_jobs_cv_scoring.sql).
-- Optional cleanup: run supabase_jobs_drop_pass_threshold.sql

alter table public.jobs
  add column if not exists pass_score_threshold integer not null default 60
    check (pass_score_threshold >= 0 and pass_score_threshold <= 100),
  add column if not exists fail_score_threshold integer not null default 30
    check (fail_score_threshold >= 0 and fail_score_threshold <= 100);

comment on column public.jobs.pass_score_threshold is
  'DEPRECATED — ignored. Use app_config.default_pass_score_thresholds.';
comment on column public.jobs.fail_score_threshold is
  'DEPRECATED — ignored. Global fail threshold is set in workflow config.';

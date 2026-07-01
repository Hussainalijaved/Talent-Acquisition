-- Deprecated: per-job assessment pass threshold (use app_config.default_pass_score_thresholds instead).
-- CV shortlist threshold stays on jobs.cv_shortlist_threshold.
-- Safe to run once — drops unused columns if they exist.

alter table public.jobs
  drop column if exists pass_score_threshold,
  drop column if exists fail_score_threshold;

comment on column public.jobs.cv_shortlist_threshold is
  'Minimum CV screening score (0–100) to shortlist for assessment. Assessment pass threshold is global in app_config.';

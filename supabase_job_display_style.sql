-- Apply page job panel display style (classic, executive, modern, etc.)
-- Run once in Supabase SQL Editor

alter table public.jobs
  add column if not exists display_style text not null default 'classic';

comment on column public.jobs.display_style is 'Apply page job panel theme: classic, executive, modern, minimal, bold, fresh';

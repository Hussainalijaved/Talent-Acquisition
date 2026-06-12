-- Extra job fields: experience, tech stack, salary range
-- Run once in Supabase SQL Editor after supabase_jobs.sql

alter table public.jobs
  add column if not exists experience text,
  add column if not exists tech_stack text,
  add column if not exists salary_range text;

comment on column public.jobs.experience is 'e.g. 2–5 years, Senior level';
comment on column public.jobs.tech_stack is 'Primary technologies / stack';
comment on column public.jobs.salary_range is 'e.g. PKR 150k–200k / month, Competitive';

-- Admin panel: delete rights, onsite interviews, assessment session read
-- Run once in Supabase SQL Editor

-- Onsite / manual interview records
create table if not exists public.onsite_interviews (
  id uuid primary key default gen_random_uuid(),
  candidate_email text not null,
  candidate_name text,
  job_id text,
  job_title text,
  interview_date timestamptz not null,
  interview_type text not null default 'onsite'
    check (interview_type in ('onsite', 'video', 'phone', 'panel')),
  outcome text
    check (outcome is null or outcome in ('passed', 'failed', 'pending', 'no_show', 'offer', 'rejected')),
  interviewer_name text,
  location text,
  notes text,
  score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists onsite_interviews_email_idx on public.onsite_interviews (candidate_email);
create index if not exists onsite_interviews_date_idx on public.onsite_interviews (interview_date desc);

alter table public.onsite_interviews enable row level security;

drop policy if exists "anon_all_onsite_interviews" on public.onsite_interviews;
create policy "anon_all_onsite_interviews"
  on public.onsite_interviews for all to anon using (true) with check (true);

drop trigger if exists onsite_interviews_updated_at on public.onsite_interviews;
create trigger onsite_interviews_updated_at
  before update on public.onsite_interviews
  for each row execute function public.set_updated_at();

-- Admin delete (tighten to authenticated/service_role in production)
drop policy if exists "anon_delete_candidates" on public.candidates;
create policy "anon_delete_candidates"
  on public.candidates for delete to anon using (true);

drop policy if exists "anon_delete_assessment_sessions" on public.assessment_sessions;
create policy "anon_delete_assessment_sessions"
  on public.assessment_sessions for delete to anon using (true);

drop policy if exists "anon_read_assessment_sessions" on public.assessment_sessions;
create policy "anon_read_assessment_sessions"
  on public.assessment_sessions for select to anon using (true);

drop policy if exists "anon_delete_jobs" on public.jobs;
create policy "anon_delete_jobs"
  on public.jobs for delete to anon using (true);

-- One active application per email + job (see also supabase_duplicate_guard.sql)
create unique index if not exists candidates_one_active_per_job_idx
  on public.candidates (lower(candidate_email), lower(requisition_id))
  where stage in ('Shortlisted', 'ReviewQueue');

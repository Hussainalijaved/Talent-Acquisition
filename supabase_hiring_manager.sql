-- Hiring Manager enhancements: job scope, candidate notes, onsite access
-- Run once after supabase_auth_profiles.sql

-- ---------------------------------------------------------------------------
-- Job assignments (explicit HM ↔ job links; also auto-match via jobs.interviewer_email)
-- ---------------------------------------------------------------------------
create table if not exists public.job_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id text not null,
  assignment_role text not null default 'hiring_manager'
    check (assignment_role in ('hiring_manager', 'recruiter')),
  created_at timestamptz not null default now(),
  unique (user_id, job_id)
);

create index if not exists job_assignments_user_idx on public.job_assignments (user_id);
create index if not exists job_assignments_job_idx on public.job_assignments (job_id);

alter table public.job_assignments enable row level security;

drop policy if exists "read_own_job_assignments" on public.job_assignments;
create policy "read_own_job_assignments"
  on public.job_assignments for select to authenticated
  using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists "super_manage_job_assignments" on public.job_assignments;
create policy "super_manage_job_assignments"
  on public.job_assignments for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Candidate notes (HM / recruiter feedback on candidates)
-- ---------------------------------------------------------------------------
create table if not exists public.candidate_notes (
  id uuid primary key default gen_random_uuid(),
  candidate_email text not null,
  job_id text,
  author_id uuid references public.profiles(id) on delete set null,
  author_name text,
  author_role text,
  body text not null,
  note_type text not null default 'feedback'
    check (note_type in ('feedback', 'proceed', 'reject', 'general')),
  created_at timestamptz not null default now()
);

create index if not exists candidate_notes_email_idx on public.candidate_notes (lower(candidate_email));
create index if not exists candidate_notes_job_idx on public.candidate_notes (job_id);
create index if not exists candidate_notes_created_idx on public.candidate_notes (created_at desc);

alter table public.candidate_notes enable row level security;

create or replace function public.can_add_candidate_notes()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and is_active = true
      and role in ('super_admin', 'recruiter', 'hiring_manager')
  );
$$;

create or replace function public.can_record_onsite()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and is_active = true
      and role in ('super_admin', 'recruiter', 'hiring_manager')
  );
$$;

drop policy if exists "staff_read_candidate_notes" on public.candidate_notes;
create policy "staff_read_candidate_notes"
  on public.candidate_notes for select to authenticated
  using (public.is_staff());

drop policy if exists "staff_insert_candidate_notes" on public.candidate_notes;
create policy "staff_insert_candidate_notes"
  on public.candidate_notes for insert to authenticated
  with check (public.can_add_candidate_notes() and author_id = auth.uid());

drop policy if exists "super_delete_candidate_notes" on public.candidate_notes;
create policy "super_delete_candidate_notes"
  on public.candidate_notes for delete to authenticated
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Onsite: allow hiring managers to record interviews
-- ---------------------------------------------------------------------------
drop policy if exists "staff_write_onsite" on public.onsite_interviews;
create policy "staff_write_onsite"
  on public.onsite_interviews for all to authenticated
  using (public.can_record_onsite())
  with check (public.can_record_onsite());

grant execute on function public.can_add_candidate_notes() to authenticated;
grant execute on function public.can_record_onsite() to authenticated;

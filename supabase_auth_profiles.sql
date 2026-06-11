-- Super Admin / role-based access for Talent Admin dashboard
-- Run once in Supabase → SQL → New query (after existing supabase_*.sql migrations)
--
-- BEFORE running: set a bootstrap secret (one-time first super admin):
--   INSERT INTO public.app_config (key, value) VALUES ('admin_bootstrap_secret', 'pick-a-long-random-secret')
--   ON CONFLICT (key) DO UPDATE SET value = excluded.value;

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'recruiter'
    check (role in ('super_admin', 'recruiter', 'hiring_manager', 'viewer')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_email_idx on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id);

-- ---------------------------------------------------------------------------
-- Role helpers (security definer)
-- ---------------------------------------------------------------------------
create or replace function public.needs_admin_bootstrap()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.profiles
    where role = 'super_admin' and is_active = true
  );
$$;

create or replace function public.can_bootstrap_admin(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
    public.needs_admin_bootstrap()
    and exists (
      select 1 from public.app_config
      where key = 'admin_bootstrap_secret'
        and value = coalesce(p_secret, '')
    )
  );
$$;

create or replace function public.is_super_admin()
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
      and role = 'super_admin'
  );
$$;

create or replace function public.is_staff()
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
      and role in ('super_admin', 'recruiter', 'hiring_manager', 'viewer')
  );
$$;

create or replace function public.can_edit_jobs()
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
      and role in ('super_admin', 'recruiter')
  );
$$;

-- ---------------------------------------------------------------------------
-- New auth.users → profiles
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned_role text;
  bootstrap_needed boolean;
  invited text;
begin
  select public.needs_admin_bootstrap() into bootstrap_needed;
  invited := coalesce(new.raw_user_meta_data->>'invited_by_admin', '');

  if bootstrap_needed then
    assigned_role := 'super_admin';
  else
    assigned_role := coalesce(new.raw_user_meta_data->>'role', 'recruiter');
    if assigned_role not in ('super_admin', 'recruiter', 'hiring_manager', 'viewer') then
      assigned_role := 'recruiter';
    end if;
    if assigned_role = 'super_admin' and invited <> 'true' then
      assigned_role := 'recruiter';
    end if;
  end if;

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    assigned_role
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, profiles.full_name),
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Profiles RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "read_own_profile" on public.profiles;
create policy "read_own_profile"
  on public.profiles for select to authenticated
  using (id = auth.uid());

drop policy if exists "super_read_profiles" on public.profiles;
create policy "super_read_profiles"
  on public.profiles for select to authenticated
  using (public.is_super_admin());

drop policy if exists "super_update_profiles" on public.profiles;
create policy "super_update_profiles"
  on public.profiles for update to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Audit log RLS
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;

drop policy if exists "staff_insert_audit" on public.audit_log;
create policy "staff_insert_audit"
  on public.audit_log for insert to authenticated
  with check (public.is_staff() and actor_id = auth.uid());

drop policy if exists "super_read_audit" on public.audit_log;
create policy "super_read_audit"
  on public.audit_log for select to authenticated
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Tighten jobs (public: open only; staff: full access)
-- ---------------------------------------------------------------------------
drop policy if exists "anon_read_jobs" on public.jobs;
drop policy if exists "anon_insert_jobs" on public.jobs;
drop policy if exists "anon_update_jobs" on public.jobs;
drop policy if exists "anon_delete_jobs" on public.jobs;

create policy "anon_read_open_jobs"
  on public.jobs for select to anon
  using (status = 'open');

drop policy if exists "staff_read_jobs" on public.jobs;
create policy "staff_read_jobs"
  on public.jobs for select to authenticated
  using (public.is_staff());

drop policy if exists "staff_insert_jobs" on public.jobs;
create policy "staff_insert_jobs"
  on public.jobs for insert to authenticated
  with check (public.can_edit_jobs());

drop policy if exists "staff_update_jobs" on public.jobs;
create policy "staff_update_jobs"
  on public.jobs for update to authenticated
  using (public.can_edit_jobs())
  with check (public.can_edit_jobs());

drop policy if exists "super_delete_jobs" on public.jobs;
create policy "super_delete_jobs"
  on public.jobs for delete to authenticated
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Tighten app_config (public: cv webhook only; super admin: write)
-- ---------------------------------------------------------------------------
drop policy if exists "anon_read_app_config" on public.app_config;
drop policy if exists "anon_insert_app_config" on public.app_config;
drop policy if exists "anon_update_app_config" on public.app_config;

drop policy if exists "anon_read_apply_config" on public.app_config;
create policy "anon_read_apply_config"
  on public.app_config for select to anon
  using (key in ('cv_ingest_webhook'));

drop policy if exists "staff_read_app_config" on public.app_config;
create policy "staff_read_app_config"
  on public.app_config for select to authenticated
  using (public.is_staff());

drop policy if exists "super_write_app_config" on public.app_config;
create policy "super_write_app_config"
  on public.app_config for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Candidates (keep anon read for apply duplicate check; staff read; super delete)
-- ---------------------------------------------------------------------------
drop policy if exists "staff_read_candidates" on public.candidates;
create policy "staff_read_candidates"
  on public.candidates for select to authenticated
  using (public.is_staff());

drop policy if exists "anon_delete_candidates" on public.candidates;
drop policy if exists "super_delete_candidates" on public.candidates;
create policy "super_delete_candidates"
  on public.candidates for delete to authenticated
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Assessment sessions (keep anon for candidate/scheduling portals; super delete)
-- ---------------------------------------------------------------------------
drop policy if exists "staff_read_assessment_sessions" on public.assessment_sessions;
create policy "staff_read_assessment_sessions"
  on public.assessment_sessions for select to authenticated
  using (public.is_staff());

drop policy if exists "anon_delete_assessment_sessions" on public.assessment_sessions;
drop policy if exists "super_delete_assessment_sessions" on public.assessment_sessions;
create policy "super_delete_assessment_sessions"
  on public.assessment_sessions for delete to authenticated
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Onsite interviews (staff only — remove anon access)
-- ---------------------------------------------------------------------------
drop policy if exists "anon_all_onsite_interviews" on public.onsite_interviews;

drop policy if exists "staff_read_onsite" on public.onsite_interviews;
create policy "staff_read_onsite"
  on public.onsite_interviews for select to authenticated
  using (public.is_staff());

drop policy if exists "staff_write_onsite" on public.onsite_interviews;
create policy "staff_write_onsite"
  on public.onsite_interviews for all to authenticated
  using (public.can_edit_jobs())
  with check (public.can_edit_jobs());

-- ---------------------------------------------------------------------------
-- Grants for RPCs
-- ---------------------------------------------------------------------------
grant execute on function public.needs_admin_bootstrap() to anon, authenticated;
grant execute on function public.can_bootstrap_admin(text) to anon, authenticated;

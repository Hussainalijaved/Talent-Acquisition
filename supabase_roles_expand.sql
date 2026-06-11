-- Expand role system: HR Head, HM Head, Interviewer, Recruiter/HR
-- Run once after supabase_auth_profiles.sql
-- Full-access mode: all staff roles can read/write hiring data (tighten later in app + SQL)

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in (
    'super_admin',
    'hr_head',
    'hiring_manager_head',
    'interviewer',
    'recruiter',
    'hiring_manager',
    'viewer'
  ));

-- Staff = everyone with dashboard access
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
      and role in (
        'super_admin', 'hr_head', 'hiring_manager_head', 'interviewer',
        'recruiter', 'hiring_manager', 'viewer'
      )
  );
$$;

-- Full-access mode (temporary — mirror in admin-auth.js)
create or replace function public.can_edit_jobs()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_staff();
$$;

create or replace function public.can_add_candidate_notes()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_staff();
$$;

create or replace function public.can_record_onsite()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_staff();
$$;

create or replace function public.is_hr_head()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active and role = 'hr_head'
  );
$$;

create or replace function public.is_hiring_manager_head()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active and role = 'hiring_manager_head'
  );
$$;

-- Profile read: super admin + heads (scoped to their team roles)
drop policy if exists "heads_read_profiles" on public.profiles;
create policy "heads_read_profiles"
  on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or public.is_super_admin()
    or (public.is_hr_head() and role in ('recruiter', 'interviewer', 'viewer'))
    or (public.is_hiring_manager_head() and role in ('hiring_manager', 'interviewer'))
  );

-- Profile update: super admin all; HR head → recruiter/interviewer; HM head → hiring_manager
drop policy if exists "heads_update_profiles" on public.profiles;
create policy "heads_update_profiles"
  on public.profiles for update to authenticated
  using (
    public.is_super_admin()
    or (public.is_hr_head() and role in ('recruiter', 'interviewer', 'viewer'))
    or (public.is_hiring_manager_head() and role in ('hiring_manager', 'interviewer'))
  )
  with check (
    public.is_super_admin()
    or (public.is_hr_head() and role in ('recruiter', 'interviewer', 'viewer'))
    or (public.is_hiring_manager_head() and role in ('hiring_manager', 'interviewer'))
  );

-- Signup trigger: accept new roles
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
    if assigned_role not in (
      'super_admin', 'hr_head', 'hiring_manager_head', 'interviewer',
      'recruiter', 'hiring_manager', 'viewer'
    ) then
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

grant execute on function public.is_hr_head() to authenticated;
grant execute on function public.is_hiring_manager_head() to authenticated;

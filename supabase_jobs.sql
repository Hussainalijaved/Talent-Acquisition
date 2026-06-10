-- Jobs + app config for public careers / apply pages.
-- Run once in Supabase → SQL → New query.

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  job_id text unique not null,
  title text not null,
  jd_text text not null,
  interviewer_email text,
  location text default 'Remote',
  employment_type text default 'Full-time',
  department text,
  status text not null default 'draft' check (status in ('open', 'closed', 'draft')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_status_idx on public.jobs (status);
create index if not exists jobs_job_id_idx on public.jobs (job_id);

create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.jobs enable row level security;
alter table public.app_config enable row level security;

drop policy if exists "anon_read_jobs" on public.jobs;
create policy "anon_read_jobs"
  on public.jobs for select to anon using (true);

drop policy if exists "anon_insert_jobs" on public.jobs;
create policy "anon_insert_jobs"
  on public.jobs for insert to anon with check (true);

drop policy if exists "anon_update_jobs" on public.jobs;
create policy "anon_update_jobs"
  on public.jobs for update to anon using (true) with check (true);

drop policy if exists "anon_read_app_config" on public.app_config;
create policy "anon_read_app_config"
  on public.app_config for select to anon using (true);

drop policy if exists "anon_insert_app_config" on public.app_config;
create policy "anon_insert_app_config"
  on public.app_config for insert to anon with check (true);

drop policy if exists "anon_update_app_config" on public.app_config;
create policy "anon_update_app_config"
  on public.app_config for update to anon using (true) with check (true);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists jobs_updated_at on public.jobs;
create trigger jobs_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- Optional seed (edit webhook before running):
-- insert into public.app_config (key, value) values
--   ('cv_ingest_webhook', 'https://your-n8n.example.com/webhook/talent/cv-ingest'),
--   ('jd_generate_webhook', 'https://your-n8n.example.com/webhook/talent/jd-generate')
-- on conflict (key) do update set value = excluded.value, updated_at = now();

-- Allow the recruiter portal (anon key in screening-results.html) to read screening outcomes.
-- Run once in Supabase → SQL → New query.

alter table public.candidates enable row level security;

drop policy if exists "anon_read_candidates_screening" on public.candidates;

create policy "anon_read_candidates_screening"
  on public.candidates
  for select
  to anon
  using (true);

-- Optional: restrict to authenticated recruiters only (replace the policy above):
-- create policy "authenticated_read_candidates"
--   on public.candidates for select to authenticated using (true);

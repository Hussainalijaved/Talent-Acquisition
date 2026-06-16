-- Prevent duplicate active applications per email + job + CV (race-safe backup to n8n duplicate gate).
-- Run once in Supabase SQL Editor.
-- See also: supabase_application_dedup.sql (full migration with assessment index).
--
-- fingerprint is email|CV text — index uses md5() to stay under btree row size limit.

drop index if exists public.candidates_one_active_per_job_idx;
drop index if exists public.candidates_one_application_idx;

create unique index if not exists candidates_one_application_idx
  on public.candidates (
    lower(candidate_email),
    lower(requisition_id),
    md5(fingerprint)
  )
  where stage in ('Shortlisted', 'ReviewQueue')
    and fingerprint is not null
    and btrim(fingerprint) <> '';

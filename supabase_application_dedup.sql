-- Application dedup: block only exact same email + job + CV fingerprint.
-- Different job, different CV, or different email → new screening + new assessment session.
-- Run once in Supabase SQL Editor.
--
-- fingerprint stores email|CV text (up to ~6KB) — too large for btree index directly.
-- Use md5(fingerprint) in the index (same dedup semantics).

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

create index if not exists assessment_sessions_email_job_updated_idx
  on public.assessment_sessions (
    lower(candidate_email),
    lower(requisition_id),
    updated_at desc
  );

comment on index public.candidates_one_application_idx is
  'One active candidate row per exact application (email + requisition_id + md5 of CV fingerprint).';

// n8n: CODE - Expand CVs and duplicate flag
// Paste into CV Screening workflow (replaces node body).

const intake = $('CODE - Frontend intake (JD + CV)').first().json;
const cfg = $('CFG - Workflow configuration').first().json;
const rows = $input.all().map((i) => i.json);

const email = String(intake.candidate_email || '').trim().toLowerCase();
const cv = intake.cv_text;
const canon = String(cv || '').replace(/\s+/g, ' ').trim().slice(0, 6144);
const fingerprint = `${email}|${canon}`;

const requisition_id = String(intake.requisition_id || '').trim().toLowerCase();

// Block re-apply: same email + same job if already in pipeline (not only identical CV text).
const BLOCK_STAGES = new Set(['Shortlisted', 'ReviewQueue', 'DuplicateSkipped']);

const is_duplicate = rows.some((r) => {
  const rEmail = String(r.candidate_email || '').trim().toLowerCase();
  const rReq = String(r.requisition_id || '').trim().toLowerCase();
  if (rEmail !== email || rReq !== requisition_id) return false;

  const stage = String(r.stage || '');
  if (r.fingerprint && r.fingerprint === fingerprint) return true;
  if (BLOCK_STAGES.has(stage)) return true;
  return false;
});

const config = {
  ...(cfg.config || {}),
  requisition_title: intake.requisition_title,
  requisition_requirements: intake.requisition_requirements,
  interviewer_email: intake.interviewer_email || cfg.config?.interviewer_email || '',
};

return [
  {
    json: {
      ...cfg,
      config,
      candidate_email: email,
      cv_text: cv,
      fingerprint,
      is_duplicate,
      requisition_id: intake.requisition_id || '',
      jd_source: intake.jd_source,
    },
  },
];

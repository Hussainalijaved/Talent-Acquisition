// n8n: CODE - Expand CVs and duplicate flag
// CV Screening workflow (recruiter portal webhook path)
// Paste into node "CODE - Expand CVs and duplicate flag"

const intake = $('CODE - Frontend intake (JD + CV)').first().json;
const cfg = $('CFG - Workflow configuration').first().json;
const rows = $input.all().map((i) => i.json);

const email = intake.candidate_email;
const cv = intake.cv_text;
const canon = String(cv || '').replace(/\s+/g, ' ').trim().slice(0, 6144);
const fingerprint = `${email}|${canon}`;

// Duplicate only when BOTH email and fingerprint (email + CV text) match an existing row.
const is_duplicate = rows.some(
  (r) =>
    (r.candidate_email && r.candidate_email.toLowerCase() === email) &&
    (r.fingerprint && r.fingerprint === fingerprint)
);

const config = {
  ...(cfg.config || {}),
  requisition_title: intake.requisition_title,
  requisition_requirements: intake.requisition_requirements,
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

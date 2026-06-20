// n8n: CODE - Frontend intake (JD + CV)
// Paste into CV Screening workflow — reads recruiter form fields including interviewer_email

function getWebhookPayload() {
  const tries = [
    () => $('TRG - Webhook CV ingest').first().json,
    () => $('MUX - Combine manual and webhook').first().json,
    () => $('TRG - Manual (testing)').first().json,
  ];
  for (const fn of tries) {
    try {
      const raw = fn();
      const body = raw.body || raw;
      if (
        body?.requisition_title ||
        body?.requisition_requirements ||
        body?.candidate_email ||
        body?.cv_text
      ) {
        return body;
      }
    } catch (e) {
      /* next */
    }
  }
  return {};
}

function pick(body, ...keys) {
  for (const k of keys) {
    const v = body[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

function pickNum(body, ...keys) {
  for (const k of keys) {
    const v = body?.[k];
    const n = Number(v);
    if (Number.isFinite(n)) return Math.min(100, Math.max(0, Math.round(n)));
  }
  return null;
}

const pdf = $input.first().json;
const body = getWebhookPayload();

const requisition_title = pick(body, 'requisition_title', 'job_title');
const requisition_requirements = pick(
  body,
  'requisition_requirements',
  'jd_text',
  'job_requirements'
);
const candidate_email = pick(body, 'candidate_email', 'email').toLowerCase();
const cv_text = String(pdf.text || pick(body, 'cv_text') || '').trim();
const requisition_id = pick(body, 'requisition_id');
const interviewer_email = pick(body, 'interviewer_email').toLowerCase();
const pass_score_threshold = pickNum(body, 'pass_score_threshold');
const fail_score_threshold = pickNum(body, 'fail_score_threshold');

if (!requisition_title) {
  throw new Error(
    'Missing requisition_title — recruiter form must send job title (requisition_title).'
  );
}
if (!requisition_requirements) {
  throw new Error(
    'Missing requisition_requirements — recruiter form must send JD text.'
  );
}
if (!candidate_email) {
  throw new Error('Missing candidate_email from recruiter form.');
}
if (!cv_text) {
  throw new Error('Missing CV — upload PDF (cv_file) or paste cv_text.');
}

return [
  {
    json: {
      requisition_title,
      requisition_requirements,
      candidate_email,
      cv_text,
      requisition_id,
      interviewer_email,
      pass_score_threshold,
      fail_score_threshold,
      jd_source: 'frontend_form',
    },
  },
];

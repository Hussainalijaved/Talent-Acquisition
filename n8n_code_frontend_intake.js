// n8n: CODE - Frontend intake (JD + CV)
// Paste into CV Screening workflow — reads recruiter form fields including interviewer_email
// Works with node names with or without trailing "1" (live n8n copies).

function firstJsonFromNodes(...names) {
  for (const name of names) {
    if (!name) continue;
    try {
      const item = $(name).first();
      if (item?.json && typeof item.json === 'object') return item.json;
    } catch (_) {
      /* node not in this execution path or renamed */
    }
  }
  return null;
}

function flattenBody(raw) {
  if (!raw || typeof raw !== 'object') return {};
  let body = raw.body ?? raw;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      return {};
    }
  }
  if (body && typeof body === 'object') {
    // n8n multipart: fields sometimes nested under body.body
    if (body.body && typeof body.body === 'object' && !Array.isArray(body.body)) {
      return { ...body, ...body.body };
    }
    return body;
  }
  return {};
}

function getWebhookPayload() {
  const tries = [
    'TRG - Webhook CV ingest',
    'TRG - Webhook CV ingest1',
    'MUX - Combine manual and webhook',
    'MUX - Combine manual and webhook1',
    'TRG - Manual (testing)',
    'TRG - Manual (testing)1',
  ];
  for (const name of tries) {
    const raw = firstJsonFromNodes(name);
    if (!raw) continue;
    const body = flattenBody(raw);
    if (
      body.requisition_title ||
      body.requisition_requirements ||
      body.candidate_email ||
      body.cv_text ||
      body.job_title ||
      body.jd_text
    ) {
      return body;
    }
  }
  return {};
}

function pick(body, ...keys) {
  for (const k of keys) {
    const v = body?.[k];
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
const profile_photo_url = pick(body, 'profile_photo_url');
const candidate_name = pick(body, 'candidate_name');
const pass_score_threshold = pickNum(body, 'pass_score_threshold');
const fail_score_threshold = pickNum(body, 'fail_score_threshold');
const cv_shortlist_threshold = pickNum(body, 'cv_shortlist_threshold');

function pickJson(body, ...keys) {
  for (const k of keys) {
    const v = body?.[k];
    if (v == null || v === '') continue;
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(String(v));
    } catch (_) {}
  }
  return null;
}

const default_pass_score_thresholds = pickJson(body, 'default_pass_score_thresholds');

if (!requisition_title) {
  const hint = Object.keys(body).slice(0, 12).join(', ') || 'empty body';
  throw new Error(
    'Missing requisition_title — apply form must send requisition_title (or job_title). Webhook keys seen: ' +
      hint
  );
}
if (!requisition_requirements) {
  throw new Error(
    'Missing requisition_requirements — apply form must send JD text (requisition_requirements / jd_text).'
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
      fail_score_threshold,
      cv_shortlist_threshold,
      default_pass_score_thresholds,
      profile_photo_url,
      candidate_name,
      jd_source: 'frontend_form',
    },
  },
];

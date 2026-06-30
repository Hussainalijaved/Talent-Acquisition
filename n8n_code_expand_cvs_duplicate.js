// n8n: CODE - Expand CVs and duplicate flag
// Paste into CV Screening workflow (replaces node body).
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
    try {
      const raw = $(name).first().json;
      const body = raw?.body || raw;
      if (
        body?.requisition_title ||
        body?.requisition_requirements ||
        body?.candidate_email ||
        body?.cv_text
      ) {
        return body;
      }
    } catch (_) {
      /* next */
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

function pickInt(body, ...keys) {
  for (const k of keys) {
    const v = body?.[k];
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

const intake =
  firstJsonFromNodes(
    'CODE - Frontend intake (JD + CV)',
    'CODE - Frontend intake (JD + CV)1'
  ) || {};

const cfg =
  firstJsonFromNodes(
    'CFG - Workflow configuration',
    'CFG - Workflow configuration1'
  ) || {};

const webhook = getWebhookPayload();
const rows = $input.all().map((i) => i.json);

const email = String(
  intake.candidate_email || pick(webhook, 'candidate_email', 'email') || ''
)
  .trim()
  .toLowerCase();

const cv = String(intake.cv_text || pick(webhook, 'cv_text') || '').trim();
const profile_photo_url = String(intake.profile_photo_url || pick(webhook, 'profile_photo_url') || '').trim();
const candidate_name = String(intake.candidate_name || pick(webhook, 'candidate_name') || '').trim();
const canon = String(cv || '').replace(/\s+/g, ' ').trim().slice(0, 6144);
const fingerprint = `${email}|${canon}`;

const requisition_id = String(
  intake.requisition_id || pick(webhook, 'requisition_id') || ''
)
  .trim()
  .toLowerCase();

if (!email) {
  throw new Error(
    'Duplicate check: missing candidate_email — verify CODE - Frontend intake (JD + CV) ran and node name matches (with or without "1").'
  );
}

// Duplicate only when the exact same application is resubmitted: same email + same job + same CV.
// Any one different → allow screening and a new assessment session.
const is_duplicate = rows.some((r) => {
  const rEmail = String(r.candidate_email || '').trim().toLowerCase();
  const rReq = String(r.requisition_id || '').trim().toLowerCase();
  if (rEmail !== email || rReq !== requisition_id) return false;
  return Boolean(r.fingerprint && r.fingerprint === fingerprint);
});

const config = {
  ...(cfg.config || {}),
  requisition_title:
    intake.requisition_title || pick(webhook, 'requisition_title', 'job_title'),
  requisition_requirements:
    intake.requisition_requirements ||
    pick(webhook, 'requisition_requirements', 'jd_text', 'job_requirements'),
  interviewer_email:
    intake.interviewer_email ||
    pick(webhook, 'interviewer_email') ||
    cfg.config?.interviewer_email ||
    '',
  pass_score_threshold:
    intake.pass_score_threshold ??
    pickNum(webhook, 'pass_score_threshold') ??
    cfg.config?.pass_score_threshold ??
    60,
  fail_score_threshold:
    intake.fail_score_threshold ??
    pickNum(webhook, 'fail_score_threshold') ??
    cfg.config?.fail_score_threshold ??
    30,
  cv_shortlist_threshold:
    intake.cv_shortlist_threshold ??
    pickNum(webhook, 'cv_shortlist_threshold') ??
    cfg.config?.cv_shortlist_threshold ??
    62,
  written_questions_min:
    intake.written_questions_min ??
    pickInt(webhook, 'written_questions_min') ??
    cfg.config?.written_questions_min ??
    4,
  written_questions_max:
    intake.written_questions_max ??
    pickInt(webhook, 'written_questions_max') ??
    cfg.config?.written_questions_max ??
    10,
};

return [
  {
    json: {
      ...cfg,
      config,
      candidate_email: email,
      cv_text: cv,
      profile_photo_url,
      candidate_name,
      fingerprint,
      is_duplicate,
      requisition_id: intake.requisition_id || pick(webhook, 'requisition_id') || '',
      jd_source: intake.jd_source || 'frontend_form',
    },
  },
];

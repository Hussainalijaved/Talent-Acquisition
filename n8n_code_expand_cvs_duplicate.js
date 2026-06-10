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
      requisition_id: intake.requisition_id || pick(webhook, 'requisition_id') || '',
      jd_source: intake.jd_source || 'frontend_form',
    },
  },
];

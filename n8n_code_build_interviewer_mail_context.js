// n8n: CODE - Build interviewer mail context
// Place BEFORE: WAIT - Interviewer availability (resumeUrl generated for next WAIT)
// Place BEFORE: MAIL - Interviewer pick slot
//
// MAIL node settings:
//   To:      {{ $json.interviewer_email }}
//   Subject: {{ $json.mail_subject }}
//   Message: {{ $json.mail_body_html }}  (enable HTML / paste as HTML)

function extractConfig(row) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  if (row.config && typeof row.config === 'object') Object.assign(out, row.config);
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('config.') && v != null && String(v).trim()) {
      out[k.slice(7)] = String(v).trim();
    }
  }
  return out;
}

function loadWorkflowConfig() {
  const names = [
    'CFG - Workflow configuration',
    'CFG - Workflow',
    'CFG - Assessment Config',
    'CFG - Reply track (merge)',
    'CODE - Normalize Data',
    'CODE - Prep scheduling from PASS',
    'CODE - Parse Result',
  ];
  let merged = {};
  for (const name of names) {
    try {
      merged = { ...merged, ...extractConfig($(name).first().json) };
    } catch (_) {}
  }
  return merged;
}

function pickAssessmentContext() {
  const names = [
    'CODE - Parse Result',
    'CODE - Prep scheduling from PASS',
    'CODE - Normalize Data',
    'HTTP - SB PATCH session interview_history',
    'CODE - Update interview_history',
  ];
  let merged = {};
  for (const name of names) {
    try {
      const row = $(name).first().json || {};
      merged = { ...merged, ...row };
      if (row.config && typeof row.config === 'object') {
        merged = { ...merged, ...row.config };
      }
    } catch (_) {}
  }
  return merged;
}

function publicBaseFromHeaders(obj) {
  const h = obj?.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (!host || /localhost|127\.0\.0\.1/i.test(host)) return '';
  return `https://${host}`.replace(/\/+$/, '');
}

function resolvePublicBase(base, cfg) {
  let envWebhook = '';
  try {
    envWebhook = String($env.WEBHOOK_URL || $env.N8N_WEBHOOK_URL || '').trim();
  } catch (_) {}

  const candidates = [
    cfg.n8n_public_url,
    cfg.n8n_webhook_url,
    cfg.public_n8n_url,
    envWebhook,
    publicBaseFromHeaders(base),
  ];

  for (const name of ['TRG - Assessment Answer', 'CFG - Workflow', 'CFG - Assessment Config']) {
    try {
      candidates.push(publicBaseFromHeaders($(name).first().json));
      const rowCfg = extractConfig($(name).first().json);
      candidates.push(rowCfg.n8n_public_url, rowCfg.n8n_webhook_url);
    } catch (_) {}
  }

  for (const raw of candidates) {
    const v = String(raw || '').trim().replace(/\/+$/, '');
    if (v && !/localhost|127\.0\.0\.1/i.test(v)) return v;
  }
  return '';
}

function nameFromEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return 'Candidate';
  const local = e.split('@')[0] || e;
  return local
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || e;
}

const base = $input.first().json;
const ctx = pickAssessmentContext();
const cfg = {
  ...loadWorkflowConfig(),
  ...extractConfig(base),
  ...extractConfig(ctx),
  ...(base.config || {}),
  ...(ctx.config || {}),
};

const portalBase = String(
  base.interviewer_portal_base ||
    cfg.interviewer_portal_base ||
    cfg.portal_base_url ||
    'https://talent-acquisition-six.vercel.app/interviewer.html'
).replace(/\/interviewer\.html.*$/i, '').replace(/\/+$/, '');

const interviewerPortal = portalBase + '/interviewer.html';

let resumeUrl = String($execution.resumeUrl || base.resume_url || ctx.resume_url || '').trim();
const publicBase = resolvePublicBase(base, cfg);

function rewriteLocalResume(url) {
  if (!url) return url;
  if (!/localhost|127\.0\.0\.1/i.test(url)) return url;
  if (!publicBase) {
    throw new Error(
      'resumeUrl is localhost but no public n8n URL found. ' +
        'Add config.n8n_public_url in CFG - Workflow (exact ngrok URL).'
    );
  }
  return url.replace(/^https?:\/\/[^/]+/i, publicBase);
}

resumeUrl = rewriteLocalResume(resumeUrl);

if (!resumeUrl) {
  throw new Error(
    'Missing $execution.resumeUrl. Node order must be: ' +
      'CODE (this) → MAIL → WAIT - Interviewer availability'
  );
}

const schedulingLink =
  interviewerPortal + '?resumeUrl=' + encodeURIComponent(resumeUrl);

const candidateEmail = String(
  base.candidate_email || ctx.candidate_email || cfg.candidate_email || ''
).trim();

const candidateName = String(
  base.candidate_name || ctx.candidate_name || nameFromEmail(candidateEmail)
).trim();

const sessionId = String(
  base.session_id || ctx.session_id || ctx.session_db_id || ctx.id || ''
).trim();

const scoreRaw = base.score ?? ctx.score ?? ctx.average_score ?? ctx.phase_score;
const score = scoreRaw != null && scoreRaw !== '' ? scoreRaw : '—';

const role = String(
  base.requisition_title ||
    ctx.requisition_title ||
    cfg.requisition_title ||
    'Open role'
).trim();

const interviewerEmail = String(
  base.interviewer_email || ctx.interviewer_email || cfg.interviewer_email || ''
).trim();

if (!candidateEmail) {
  throw new Error(
    'candidate_email missing — check CODE - Parse Result / CODE - Prep scheduling from PASS output.'
  );
}

if (!interviewerEmail) {
  throw new Error('interviewer_email missing — set in CFG or job/recruiter intake.');
}

const mailSubject =
  base.mail_subject ||
  `Schedule interview — ${candidateName} (${role})`;

const mailBody =
  `Hello,\n\n` +
  `Candidate: ${candidateName}\n` +
  `Email: ${candidateEmail}\n` +
  `Role: ${role}\n` +
  `Assessment score: ${score}/100 (PASSED)\n\n` +
  `Please propose interview date/time options (45–60 minutes):\n` +
  `${schedulingLink}\n\n` +
  `Session ID: ${sessionId}\n\n` +
  `Thank you.`;

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const mailBodyHtml =
  `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;">
        <tr><td style="color:#334155;font-size:15px;line-height:1.6;">
          <p>Hello,</p>
          <p><strong>${esc(candidateName)}</strong> passed the technical assessment for <strong>${esc(role)}</strong>.</p>
          <table style="width:100%;margin:16px 0;font-size:14px;color:#475569;">
            <tr><td style="padding:4px 0;">Email</td><td style="padding:4px 0;"><strong>${esc(candidateEmail)}</strong></td></tr>
            <tr><td style="padding:4px 0;">Score</td><td style="padding:4px 0;"><strong>${esc(score)}/100</strong></td></tr>
            <tr><td style="padding:4px 0;">Session</td><td style="padding:4px 0;"><strong>${esc(sessionId || '—')}</strong></td></tr>
          </table>
          <p>Please propose interview slots (45–60 minutes):</p>
          <p style="text-align:center;margin:28px 0;">
            <a href="${schedulingLink}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;">Propose interview slots</a>
          </p>
          <p>Thank you.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

return [
  {
    json: {
      ...base,
      ...ctx,
      config: { ...cfg, n8n_public_url: publicBase || cfg.n8n_public_url || '' },
      candidate_email: candidateEmail,
      candidate_name: candidateName,
      requisition_title: role,
      session_id: sessionId,
      score,
      resume_url: resumeUrl,
      interviewer_portal_base: interviewerPortal,
      scheduling_link: schedulingLink,
      interviewer_email: interviewerEmail,
      mail_subject: mailSubject,
      mail_body: mailBody,
      mail_body_html: mailBodyHtml,
      _debug_public_base: publicBase,
      _debug_resume_url: resumeUrl,
    },
  },
];

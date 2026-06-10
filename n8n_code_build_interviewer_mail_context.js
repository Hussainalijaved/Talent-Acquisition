// n8n: CODE - Build interviewer mail context
// Place BEFORE: MAIL - Interviewer pitch mail (MAIL must wire directly to WAIT)
// MAIL message must use $execution.resumeUrl at send time — see _mail_resume_expr
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

function pickNodeJson(...names) {
  for (const name of names) {
    if (!name) continue;
    try {
      const raw = $(name).first().json;
      if (raw && typeof raw === 'object') return raw;
    } catch (_) {}
  }
  return null;
}

function mergeConfig(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    Object.assign(out, extractConfig(src));
    if (src.config && typeof src.config === 'object') {
      for (const [k, v] of Object.entries(src.config)) {
        if (v != null && String(v).trim()) out[k] = String(v).trim();
      }
    }
    for (const [k, v] of Object.entries(src)) {
      if (k.startsWith('config.') && v != null && String(v).trim()) {
        out[k.slice(7)] = String(v).trim();
      }
    }
  }
  return out;
}

function loadWorkflowConfig() {
  const names = [
    'CFG - Workflow configuration',
    'CFG - Workflow configuration1',
    'CFG - Workflow',
    'CFG - Assessment Config',
    'CFG - Assessment Config1',
    'CFG - Reply track (merge)',
    'CODE - Normalize Data',
    'CODE - Normalize Data1',
    'CODE - Prep scheduling from PASS',
    'CODE - Prep scheduling from PASS1',
    'CODE - Parse Result',
    'CODE - Parse Result1',
  ];
  const rows = names.map((n) => pickNodeJson(n)).filter(Boolean);
  return mergeConfig(...rows);
}

function pickAssessmentContext() {
  const input = $input.first().json || {};
  const names = [
    'CODE - Prep scheduling from PASS',
    'CODE - Prep scheduling from PASS1',
    'CODE - Parse Result',
    'CODE - Parse Result1',
    'CODE - Normalize Data',
    'CODE - Normalize Data1',
    'HTTP - SB PATCH session interview_history',
    'HTTP - SB PATCH session interview_history1',
    'CODE - Update interview_history',
  ];
  const rows = [input, ...names.map((n) => pickNodeJson(n)).filter(Boolean)];
  let merged = {};
  for (const row of rows) {
    merged = { ...merged, ...row };
    if (row.config && typeof row.config === 'object') {
      merged = { ...merged, ...row.config };
    }
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

const base = $input.first().json || {};
const ctx = pickAssessmentContext();
const cfg = {
  ...loadWorkflowConfig(),
  ...mergeConfig(base, ctx),
};

const portalBase = String(
  base.interviewer_portal_base ||
    cfg.interviewer_portal_base ||
    cfg.portal_base_url ||
    'https://talent-acquisition-six.vercel.app/interviewer.html'
).replace(/\/interviewer\.html.*$/i, '').replace(/\/+$/, '');

const interviewerPortal = portalBase + '/interviewer.html';

const publicBase = resolvePublicBase(base, cfg);

// Injected at send time by MAIL node (must be the node immediately before WAIT):
//   $json.mail_body_html.replace('{{RESUME_URL}}', encodeURIComponent($execution.resumeUrl))
const RESUME_PLACEHOLDER = '{{RESUME_URL}}';
const schedulingLink = interviewerPortal + '?resumeUrl=' + RESUME_PLACEHOLDER;

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
  base.interviewer_email ||
    ctx.interviewer_email ||
    cfg.interviewer_email ||
    base.config?.interviewer_email ||
    ctx.config?.interviewer_email ||
    ''
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
      resume_url: RESUME_PLACEHOLDER,
      interviewer_portal_base: interviewerPortal,
      scheduling_link: schedulingLink,
      interviewer_email: interviewerEmail,
      mail_subject: mailSubject,
      mail_body: mailBody,
      mail_body_html: mailBodyHtml,
      _debug_public_base: publicBase,
      // Paste this ENTIRE string into MAIL node → Message field (Expression mode ON):
      gmail_message_n8n:
        "={{ (() => { const ru = String($execution.resumeUrl || '').trim(); if (!ru) throw new Error('resumeUrl empty — wire MAIL directly to WAIT only (remove PATCH→WAIT)'); return $json.mail_body_html.split('{{RESUME_URL}}').join(encodeURIComponent(ru)); })() }}",
    },
  },
];

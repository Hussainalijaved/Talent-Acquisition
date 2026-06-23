// n8n: CODE - Build interviewer mail context
// Place BEFORE: MAIL - Interviewer pitch mail
// Frontend scheduling: email link uses ?session=UUID (no n8n WAIT / resumeUrl)
//
// MAIL node settings:
//   To:      {{ $json.interviewer_email }}
//   Subject: {{ $json.mail_subject }}
//   Message: {{ $json.mail_body_html }}  (HTML — no expression injection needed)

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
    'CFG - Live Speech Config (complete)',
    'CFG - Live Speech Config (start)',
    'CFG - Reply track (merge)',
    'CODE - Normalize Data',
    'CODE - Normalize Data1',
    'CODE - Normalize Live Speech Complete',
    'CODE - Prep scheduling from PASS',
    'CODE - Prep scheduling from PASS1',
    'CODE - Parse Result',
    'CODE - Parse Result1',
    'CODE - Parse Live Speech Result',
    'CODE - Pick Parse Result',
    'CODE - Pick Parse Result1',
  ];
  const rows = names.map((n) => pickNodeJson(n)).filter(Boolean);
  return mergeConfig(...rows);
}

function pickAssessmentContext() {
  const input = $input.first().json || {};
  const names = [
    'CODE - Prep scheduling from PASS',
    'CODE - Prep scheduling from PASS1',
    'CODE - Parse Live Speech Result',
    'CODE - Pick Parse Result',
    'CODE - Pick Parse Result1',
    'CODE - Parse Result',
    'CODE - Parse Result1',
    'CODE - Normalize Data',
    'CODE - Normalize Data1',
    'CODE - Normalize Live Speech Complete',
    'HTTP - Fetch Session Complete',
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

function parseJson(raw, fallback = {}) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function interviewerFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  const rowCfg = parseJson(row.config, row.config || {});
  const email = normalizeEmail(row.interviewer_email || rowCfg.interviewer_email);
  return email;
}

function pickInterviewerNodeRows() {
  const names = [
    'CODE - Prep scheduling from PASS',
    'CODE - Prep scheduling from PASS1',
    'CODE - Parse Live Speech Result',
    'CODE - Parse Result',
    'CODE - Parse Result1',
    'CODE - Frontend intake (JD + CV)',
    'CODE - Frontend intake (JD + CV)1',
    'CODE - Expand CVs and duplicate flag',
    'CODE - Expand CVs and duplicate flag1',
  ];
  return names.map((n) => pickNodeJson(n)).filter(Boolean);
}

function pickSessionRow(base, ctx) {
  const fetchRaw = pickNodeJson(
    'HTTP - Fetch Session Complete',
    'HTTP - Fetch Session',
    'HTTP - Fetch Session1'
  );
  const fetched = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;
  if (fetched?.id) return fetched;
  if (base?.id && (base.config || base.candidate_email)) return base;
  if (ctx?.id && (ctx.config || ctx.candidate_email)) return ctx;
  return null;
}

async function lookupJobInterviewer({ supabaseUrl, supabaseKey, requisitionId, requisitionTitle }) {
  const sb = String(supabaseUrl || '').replace(/\/+$/, '');
  const key = String(supabaseKey || '').trim();
  if (!sb || !key) return '';

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const reqId = String(requisitionId || '').trim();
  if (reqId) {
    try {
      const url =
        `${sb}/rest/v1/jobs?select=interviewer_email&job_id=eq.${encodeURIComponent(reqId)}&limit=1`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const rows = await res.json();
        const email = normalizeEmail(rows?.[0]?.interviewer_email);
        if (email) return email;
      }
    } catch (_) {}
  }

  const title = String(requisitionTitle || '').trim();
  if (title) {
    try {
      const url =
        `${sb}/rest/v1/jobs?select=interviewer_email&title=eq.${encodeURIComponent(title)}&limit=1`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const rows = await res.json();
        const email = normalizeEmail(rows?.[0]?.interviewer_email);
        if (email) return email;
      }
    } catch (_) {}
  }

  return '';
}

async function resolveInterviewerEmail({ base, ctx, cfg, sessionRow }) {
  const sessionCfg = parseJson(sessionRow?.config, {});
  const nodeRows = pickInterviewerNodeRows();
  const fromNodes = nodeRows.map((row) => interviewerFromRow(row)).filter(Boolean);

  let email = normalizeEmail(
    sessionCfg.interviewer_email ||
      sessionRow?.interviewer_email ||
      base.interviewer_email ||
      base.config?.interviewer_email ||
      ctx.interviewer_email ||
      ctx.config?.interviewer_email ||
      fromNodes[0] ||
      ''
  );

  if (!email) {
    email = await lookupJobInterviewer({
      supabaseUrl: cfg.supabase_url,
      supabaseKey: cfg.supabase_key,
      requisitionId:
        sessionRow?.requisition_id ||
        base.requisition_id ||
        ctx.requisition_id ||
        sessionCfg.requisition_id ||
        cfg.requisition_id,
      requisitionTitle:
        base.requisition_title ||
        ctx.requisition_title ||
        sessionCfg.requisition_title ||
        cfg.requisition_title,
    });
  }

  if (!email) email = normalizeEmail(cfg.interviewer_email);
  return email;
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
const sessionRow = pickSessionRow(base, ctx);
const cfg = {
  ...loadWorkflowConfig(),
  ...mergeConfig(base, ctx, sessionRow || {}),
};

const portalBase = String(
  base.interviewer_portal_base ||
    cfg.interviewer_portal_base ||
    cfg.portal_base_url ||
    'https://talent-acquisition-six.vercel.app'
).replace(/\/interviewer\.html.*$/i, '').replace(/\/+$/, '');

const interviewerPortal = portalBase + '/interviewer.html';

const candidateEmail = String(
  base.candidate_email || ctx.candidate_email || cfg.candidate_email || ''
).trim();

const candidateName = String(
  base.candidate_name || ctx.candidate_name || nameFromEmail(candidateEmail)
).trim();

const sessionId = String(
  base.session_id || ctx.session_id || ctx.session_db_id || ctx.id || sessionRow?.id || ''
).trim();

const scoreRaw = base.score ?? ctx.score ?? ctx.average_score ?? ctx.phase_score;
const score = scoreRaw != null && scoreRaw !== '' ? scoreRaw : '—';

const role = String(
  base.requisition_title ||
    ctx.requisition_title ||
    sessionRow?.requisition_title ||
    cfg.requisition_title ||
    'Open role'
).trim();

return (async () => {
const interviewerEmail = await resolveInterviewerEmail({ base, ctx, cfg, sessionRow });

if (!candidateEmail) {
  throw new Error(
    'candidate_email missing — check CODE - Parse Result / CODE - Prep scheduling from PASS output.'
  );
}

if (!interviewerEmail) {
  throw new Error(
    'interviewer_email missing — set interviewer on the job in admin (apply form sends it) or ensure session.config.interviewer_email is stored.'
  );
}

if (interviewerEmail.toLowerCase() === candidateEmail.toLowerCase()) {
  throw new Error(
    'interviewer_email equals candidate_email — update the job interviewer in admin panel and session.config (old test value may be cached on this session row).'
  );
}

if (!sessionId) {
  throw new Error('session_id missing — required for frontend scheduling link.');
}

const schedulingLink =
  interviewerPortal + '?session=' + encodeURIComponent(sessionId);

// Do not reuse session.mail_subject — that is the candidate thread subject (CV shortlist).
const mailSubject = `Schedule interview — ${candidateName} (${role})`;

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
            <tr><td style="padding:4px 0;">Session</td><td style="padding:4px 0;"><strong>${esc(sessionId)}</strong></td></tr>
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

const sb = String(cfg.supabase_url || '').replace(/\/+$/, '');
const tb = cfg.table_assessment_sessions || 'assessment_sessions';
const nowIso = new Date().toISOString();

return [
  {
    json: {
      ...base,
      ...ctx,
      ...(sessionRow || {}),
      config: { ...cfg, interviewer_email: interviewerEmail },
      candidate_email: candidateEmail,
      candidate_name: candidateName,
      requisition_title: role,
      session_id: sessionId,
      score,
      interviewer_portal_base: interviewerPortal,
      scheduling_link: schedulingLink,
      interviewer_email: interviewerEmail,
      mail_subject: mailSubject,
      mail_body: mailBody,
      mail_body_html: mailBodyHtml,
      _scheduling_patch_url: sessionId
        ? `${sb}/rest/v1/${tb}?id=eq.${encodeURIComponent(sessionId)}`
        : '',
      _scheduling_patch_body: {
        scheduling_status: 'pending_interviewer',
        scheduling_updated_at: nowIso,
        updated_at: nowIso,
      },
      _supabase_key: String(cfg.supabase_key || '').trim(),
    },
  },
];
})();

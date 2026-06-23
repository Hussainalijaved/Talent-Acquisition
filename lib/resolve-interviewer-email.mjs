/**
 * Resolve interviewer email for scheduling mail chain.
 * Source priority: session.config (apply form) → frontend intake → expand → jobs table → workflow cfg last.
 * Keep in sync with lookupJobInterviewer() in n8n_code_prep_scheduling_from_pass.js and
 * n8n_code_build_interviewer_mail_context.js.
 */

export function parseJson(raw, fallback = {}) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

export function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function firstNonEmptyEmail(...values) {
  for (const value of values) {
    const email = normalizeEmail(value);
    if (email) return email;
  }
  return '';
}

export function interviewerFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  const cfg = parseJson(row.config, row.config || {});
  return firstNonEmptyEmail(row.interviewer_email, cfg.interviewer_email);
}

export function slugFromTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

async function fetchFirstJobEmail(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return '';
    const rows = await res.json();
    if (!Array.isArray(rows)) return '';
    for (const row of rows) {
      const email = normalizeEmail(row?.interviewer_email);
      if (email) return email;
    }
    return '';
  } catch (_) {
    return '';
  }
}

export async function lookupJobInterviewer({ supabaseUrl, supabaseKey, requisitionId, requisitionTitle }) {
  const sb = String(supabaseUrl || '').replace(/\/+$/, '');
  const key = String(supabaseKey || '').trim();
  if (!sb || !key) return '';

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const reqId = String(requisitionId || '').trim();
  if (reqId) {
    const email = await fetchFirstJobEmail(
      `${sb}/rest/v1/jobs?select=interviewer_email&job_id=eq.${encodeURIComponent(reqId)}&limit=1`,
      headers
    );
    if (email) return email;
  }

  const title = String(requisitionTitle || '').trim();
  if (!title) return '';

  const attempts = [
    `${sb}/rest/v1/jobs?select=interviewer_email&title=eq.${encodeURIComponent(title)}&limit=1`,
    `${sb}/rest/v1/jobs?select=interviewer_email&title=ilike.${encodeURIComponent(title)}&limit=3`,
    `${sb}/rest/v1/jobs?select=interviewer_email&title=ilike.${encodeURIComponent(`%${title.replace(/\s+/g, '%')}%`)}&limit=3`,
  ];

  const slug = slugFromTitle(title);
  if (slug && slug !== reqId) {
    attempts.push(
      `${sb}/rest/v1/jobs?select=interviewer_email&job_id=eq.${encodeURIComponent(slug)}&limit=1`
    );
  }

  for (const url of attempts) {
    const email = await fetchFirstJobEmail(url, headers);
    if (email) return email;
  }

  return '';
}

export async function resolveInterviewerEmail({
  sessionRow,
  base,
  ctx,
  nodeRows = [],
  workflowCfgEmail = '',
  supabaseUrl = '',
  supabaseKey = '',
  requisitionId = '',
  requisitionTitle = '',
}) {
  const sessionCfg = parseJson(sessionRow?.config, {});
  const fromNodes = nodeRows.map((row) => interviewerFromRow(row)).filter(Boolean);

  let email = firstNonEmptyEmail(
    sessionCfg.interviewer_email,
    sessionRow?.interviewer_email,
    interviewerFromRow(base),
    interviewerFromRow(ctx),
    ...fromNodes
  );

  if (!email) {
    email = await lookupJobInterviewer({
      supabaseUrl,
      supabaseKey,
      requisitionId:
        requisitionId ||
        sessionRow?.requisition_id ||
        base?.requisition_id ||
        ctx?.requisition_id ||
        sessionCfg.requisition_id,
      requisitionTitle:
        requisitionTitle ||
        sessionCfg.requisition_title ||
        sessionRow?.requisition_title ||
        base?.requisition_title ||
        ctx?.requisition_title,
    });
  }

  if (!email) email = normalizeEmail(workflowCfgEmail);
  return email;
}

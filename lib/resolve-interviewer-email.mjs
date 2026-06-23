/**
 * Resolve interviewer email for scheduling mail chain.
 * Source priority: session.config (apply form) → frontend intake → expand → jobs table → workflow cfg last.
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

export async function lookupJobInterviewer({ supabaseUrl, supabaseKey, requisitionId, requisitionTitle }) {
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
        sessionRow?.requisition_title ||
        base?.requisition_title ||
        ctx?.requisition_title ||
        sessionCfg.requisition_title,
    });
  }

  if (!email) email = normalizeEmail(workflowCfgEmail);
  return email;
}

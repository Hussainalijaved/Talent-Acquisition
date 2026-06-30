// n8n: CODE - Build assessment result mail (PASS/FAIL)
// Place AFTER: IF - Result PASS? (false / FAIL branch)
// Place BEFORE: IF - Result mail thread reply? → MAIL Reply OR MAIL Send
//
// Thread reply (preferred):
//   Resource: thread | Operation: reply
//   Thread ID: {{ $json.gmail_thread_id }}
//   Message ID: {{ $json.gmail_message_id }}
//
// Send fallback (no gmail thread on session — e.g. manual shortlist):
//   To: {{ $json.mail_to }}
//   Subject: {{ $json.mail_subject }}
//   Message: {{ $json.mail_body_html }}

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

function pickSessionRow() {
  const built =
    pickNodeJson(
      'CODE - Build Speech LLM context',
      'CODE - Build Speech LLM context1',
      'CODE - Build LLM context',
      'CODE - Build LLM context1'
    ) || {};
  if (built.session?.id) return built.session;

  const fetchNames = [
    'HTTP - Fetch Session Complete',
    'HTTP - Fetch Session',
    'HTTP - Fetch Session1',
    'HTTP - SB PATCH session interview_history',
    'HTTP - SB PATCH session interview_history1',
    'HTTP - SB PATCH session',
    'HTTP - SB PATCH session1',
  ];
  for (const name of fetchNames) {
    const fetchRaw = pickNodeJson(name);
    const row = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;
    if (row?.id) return row;
  }
  return {};
}

function mergeGmailMeta(...sources) {
  let threadId = '';
  let msgId = '';
  let subject = '';
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    if (!threadId) threadId = String(src.gmail_thread_id || '').trim();
    if (!msgId) msgId = String(src.gmail_message_id || '').trim();
    if (!subject) subject = String(src.mail_subject || '').trim();
  }
  return { threadId, msgId, subject };
}

function isValidThread(id) {
  const t = String(id || '').trim();
  return t.length > 0 && !/^pending$/i.test(t) && !t.startsWith('draft-');
}

async function fetchSessionGmailMeta(sessionId, cfg) {
  const base = String(cfg.supabase_url || '').replace(/\/+$/, '');
  const key = String(cfg.supabase_key || '').trim();
  const sid = String(sessionId || '').trim();
  if (!base || !key || !sid) return null;
  try {
    const tb = cfg.table_assessment_sessions || 'assessment_sessions';
    const url =
      `${base}/rest/v1/${tb}?id=eq.${encodeURIComponent(sid)}` +
      '&select=id,gmail_thread_id,gmail_message_id,mail_subject,candidate_email,requisition_id';
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : null;
  } catch (_) {
    return null;
  }
}

async function lookupSiblingSessionThread(sessionId, email, requisitionId, cfg) {
  const base = String(cfg.supabase_url || '').replace(/\/+$/, '');
  const key = String(cfg.supabase_key || '').trim();
  const em = String(email || '').trim().toLowerCase();
  if (!base || !key || !em) return null;

  const tb = cfg.table_assessment_sessions || 'assessment_sessions';
  const req = String(requisitionId || '').trim();
  const urls = [];
  if (req) {
    urls.push(
      `${base}/rest/v1/${tb}?candidate_email=eq.${encodeURIComponent(em)}` +
        `&requisition_id=eq.${encodeURIComponent(req)}` +
        '&select=gmail_thread_id,gmail_message_id,mail_subject,id' +
        '&order=updated_at.desc&limit=5'
    );
  }
  urls.push(
    `${base}/rest/v1/${tb}?candidate_email=eq.${encodeURIComponent(em)}` +
      '&select=gmail_thread_id,gmail_message_id,mail_subject,id,requisition_id' +
      '&order=updated_at.desc&limit=5'
  );

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) continue;
      const rows = await res.json();
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (String(row.id || '') === String(sessionId || '')) continue;
        const threadId = String(row.gmail_thread_id || '').trim();
        if (isValidThread(threadId)) return row;
      }
    } catch (_) {
      /* next */
    }
  }
  return null;
}

return (async () => {
const parse =
  pickNodeJson(
    'CODE - Pick Parse Result',
    'CODE - Pick Parse Result1',
    'CODE - Parse Live Speech Result',
    'CODE - Parse Speech Result',
    'CODE - Parse Speech Result1',
    'CODE - Parse Technical Result',
    'CODE - Parse Technical Result1'
  ) || $input.first().json || {};

const session = pickSessionRow();
const cfg = parse.config || session.config || {};
const sessionId = String(parse.session_id || session.id || '').trim();

let gmail = mergeGmailMeta(parse, session, $input.first().json);

if ((!isValidThread(gmail.threadId) || !gmail.msgId) && sessionId) {
  const fresh = await fetchSessionGmailMeta(sessionId, cfg);
  if (fresh) {
    gmail = mergeGmailMeta(gmail, fresh);
  }
}

if (!isValidThread(gmail.threadId) && sessionId) {
  const sibling = await lookupSiblingSessionThread(
    sessionId,
    parse.candidate_email || session.candidate_email,
    parse.requisition_id || session.requisition_id,
    cfg
  );
  if (sibling) {
    gmail = mergeGmailMeta(gmail, sibling);
  }
}

const result = String(parse.result || 'FAIL').toUpperCase();
const passed = result === 'PASS';
const score = parse.score ?? parse.average_score ?? '—';
const role = String(cfg.requisition_title || parse.requisition_title || 'the role');
const org = String(cfg.organization_name || 'Talent Acquisition Team');
const feedback = String(parse.feedback || '').trim();
const candidateEmail = String(
  parse.candidate_email || session.candidate_email || ''
)
  .trim()
  .toLowerCase();

// PASS: candidate mail deferred to scheduling-slots webhook.
if (passed) {
  return [
    {
      json: {
        ...parse,
        session_id: sessionId,
        skip_candidate_result_mail: true,
        mail_stage: 'pass_deferred_to_scheduling',
        result,
        candidate_email: candidateEmail,
        config: cfg,
      },
    },
  ];
}

const useThreadReply =
  isValidThread(gmail.threadId) && Boolean(gmail.msgId);
const mailMode = useThreadReply ? 'thread_reply' : 'send';
const defaultSubject = `Your assessment result — ${role.replace(/[\r\n]+/g, ' ').slice(0, 120)}`;
const mailSubject =
  gmail.subject ||
  defaultSubject;

const sectionTitle = 'Assessment Result';
const headline = `Thank you for completing the assessment for <strong>${role.replace(/</g, '&lt;')}</strong>.`;

const nextStep =
  '<p>Unfortunately you did not meet the pass threshold for this role at this time.</p>';

const mailBodyHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:28px;">
        <tr><td style="color:#334155;font-size:15px;line-height:1.6;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;">── ${sectionTitle} ──</p>
          <p>Hi,</p>
          <p>${headline}</p>
          <p><strong>Overall score:</strong> ${score}/100 &nbsp;|&nbsp; <strong>Result:</strong> ${result}</p>
          ${feedback ? `<p style="color:#475569;font-size:14px;">${feedback.replace(/</g, '&lt;')}</p>` : ''}
          ${nextStep}
          <p>Best regards,<br>${org.replace(/</g, '&lt;')}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

if (!candidateEmail) {
  throw new Error(
    'candidate_email missing — cannot send assessment result mail for session ' +
      (sessionId || 'unknown')
  );
}

return [
  {
    json: {
      ...parse,
      session_id: sessionId,
      mail_mode: mailMode,
      mail_to: candidateEmail,
      gmail_thread_id: useThreadReply ? gmail.threadId : undefined,
      gmail_message_id: useThreadReply ? gmail.msgId : undefined,
      mail_subject: mailSubject,
      mail_body_html: mailBodyHtml,
      mail_stage: 'fail',
      candidate_email: candidateEmail,
      config: cfg,
      gmail_lookup_used_send_fallback: mailMode === 'send',
    },
  },
];
})();

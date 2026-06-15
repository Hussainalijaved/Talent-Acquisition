// n8n: CODE - Build assessment result mail (PASS/FAIL — thread reply)
// Place AFTER: IF - Assessment finished? (true branch)
// Place BEFORE: MAIL - Reply candidate (assessment result)
//
// Gmail node settings:
//   Resource:   thread
//   Operation:  reply
//   Thread ID:  {{ $json.gmail_thread_id }}
//   Message ID: {{ $json.gmail_message_id }}
//   Email Type: HTML
//   Message:    {{ $json.mail_body_html }}

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

  const fetchRaw = pickNodeJson(
    'HTTP - Fetch Session',
    'HTTP - Fetch Session1',
    'HTTP - SB PATCH session interview_history',
    'HTTP - SB PATCH session interview_history1'
  );
  const row = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;
  if (row?.id) return row;

  return {};
}

const parse =
  pickNodeJson(
    'CODE - Pick Parse Result',
    'CODE - Pick Parse Result1',
    'CODE - Parse Speech Result',
    'CODE - Parse Speech Result1',
    'CODE - Parse Technical Result',
    'CODE - Parse Technical Result1'
  ) || $input.first().json || {};

const session = pickSessionRow();
const cfg = parse.config || session.config || {};

const threadId = String(
  parse.gmail_thread_id || session.gmail_thread_id || ''
).trim();
const msgId = String(
  parse.gmail_message_id || session.gmail_message_id || ''
).trim();

if (!threadId || threadId.startsWith('draft-')) {
  const sid = parse.session_id || session.id || 'unknown';
  throw new Error(
    'gmail_thread_id missing on session ' +
      sid +
      ' — CV screening shortlist mail must PATCH gmail_thread_id to assessment_sessions. ' +
      'Check Supabase row, run supabase_gmail_thread_columns.sql, and verify CV Screening workflow: ' +
      'MAIL - Email outreach agent (shortlist) → HTTP - SB PATCH session gmail thread.'
  );
}
if (!msgId) {
  throw new Error(
    'gmail_message_id missing on session — re-run shortlist flow or set from first mail.'
  );
}

const result = String(parse.result || 'FAIL').toUpperCase();
const passed = result === 'PASS';
const score = parse.score ?? parse.average_score ?? '—';
const role = String(cfg.requisition_title || 'the role');
const org = String(cfg.organization_name || 'Talent Acquisition Team');
const feedback = String(parse.feedback || '').trim();
const sessionId = String(parse.session_id || session.id || '');

const sectionTitle = passed ? 'Assessment Passed' : 'Assessment Result';
const headline = passed
  ? `Congratulations — you passed the assessment for <strong>${role.replace(/</g, '&lt;')}</strong>.`
  : `Thank you for completing the assessment for <strong>${role.replace(/</g, '&lt;')}</strong>.`;

const portalBase = String(
  cfg.portal_base_url || 'https://talent-acquisition-six.vercel.app'
).replace(/\/+$/, '');
const schedulingWaitLink = sessionId
  ? `${portalBase}/scheduling-wait.html?session=${encodeURIComponent(sessionId)}`
  : portalBase;

const nextStep = passed
  ? `<p>Next step: schedule your interview. Open this page to pick a time as soon as slots are ready (you can leave and return later):</p>
     <p style="text-align:center;margin:20px 0;"><a href="${schedulingWaitLink}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Schedule interview</a></p>
     <p style="font-size:13px;color:#64748b;">If the interviewer is not available right now, they may add slots later — we will email you when options are ready.</p>`
  : '<p>Unfortunately you did not meet the pass threshold for this role at this time.</p>';

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

return [
  {
    json: {
      ...parse,
      session_id: sessionId,
      gmail_thread_id: threadId,
      gmail_message_id: msgId,
      mail_subject: session.mail_subject || parse.mail_subject || '',
      mail_body_html: mailBodyHtml,
      mail_stage: passed ? 'pass' : 'fail',
      candidate_email: parse.candidate_email || session.candidate_email,
      config: cfg,
    },
  },
];

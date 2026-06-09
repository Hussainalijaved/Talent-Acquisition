// n8n: CODE - Build assessment result mail (PASS/FAIL — thread reply)
// Place AFTER: CODE - Parse Result (when isFinal = true)
// Place BEFORE: Gmail Thread Reply node
//
// Gmail node settings:
//   Resource:   thread
//   Operation:  reply
//   Thread ID:  {{ $json.gmail_thread_id }}
//   Message ID: {{ $json.gmail_message_id }}
//   Email Type: HTML
//   Message:    {{ $json.mail_body_html }}

function pickSessionRow() {
  const names = ['HTTP - Fetch Session', 'CODE - Build LLM context'];
  for (const name of names) {
    try {
      const raw = $(name).first().json;
      const row = Array.isArray(raw) ? raw[0] : raw;
      if (row?.id) return row;
    } catch (_) {}
  }
  return {};
}

const parse = $('CODE - Parse Result').first().json;
const session = pickSessionRow();
const cfg = parse.config || session.config || {};

const threadId = String(session.gmail_thread_id || parse.gmail_thread_id || '').trim();
const msgId = String(session.gmail_message_id || parse.gmail_message_id || '').trim();

if (!threadId || threadId.startsWith('draft-')) {
  throw new Error(
    'gmail_thread_id missing on session — run CV screening shortlist mail first and PATCH thread.'
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
const sessionId = String(session.id || parse.session_id || '');

const sectionTitle = passed ? 'Assessment Passed' : 'Assessment Result';
const headline = passed
  ? `Congratulations — you passed the technical assessment for <strong>${role.replace(/</g, '&lt;')}</strong>.`
  : `Thank you for completing the assessment for <strong>${role.replace(/</g, '&lt;')}</strong>.`;

const nextStep = passed
  ? '<p>Our team will share interview scheduling options in this same email thread shortly.</p>'
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

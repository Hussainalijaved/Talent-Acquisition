// n8n: Webhook — Send assessment invite after manual shortlist
// Create workflow: TRG Webhook POST /webhook/talent/manual-shortlist-mail → this Code → Gmail Send
//
// Gmail node:
//   sendTo: {{ $json.candidate_email }}
//   subject: {{ $json.mail_subject }}
//   emailType: html
//   message: {{ $json.mail_body_html }}

const body = $input.first().json?.body || $input.first().json || {};

const email = String(body.candidate_email || '').trim().toLowerCase();
const sessionId = String(body.session_id || '').trim();
const role = String(body.requisition_title || 'Open role').trim();
const score = body.score != null ? Number(body.score) : null;
const maxQ = Number(body.max_questions || 5);
const org = String(body.organization_name || 'CONVO').trim();
const portalBase = String(body.portal_base_url || 'https://talent-acquisition-six.vercel.app').replace(/\/+$/, '');
const link =
  String(body.assessment_link || '').trim() ||
  `${portalBase}/?session=${encodeURIComponent(sessionId)}&email=${encodeURIComponent(email)}`;

if (!email || !sessionId) {
  throw new Error('manual-shortlist-mail: candidate_email and session_id required');
}

const scoreLine =
  Number.isFinite(score) && score != null
    ? ` with a CV screening score of <strong style="color:#1d4ed8;">${Math.round(score)}/100</strong>`
    : '';

const mailBodyHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:Segoe UI,Arial,sans-serif;color:#1e293b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,.08);">
        <tr><td style="background:linear-gradient(135deg,#1d4ed8,#2563eb);padding:28px 32px;text-align:center;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.75);">Talent Assessment</p>
          <h1 style="margin:0;font-size:24px;line-height:1.3;color:#ffffff;">You are shortlisted</h1>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hello,</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Your application for <strong>${role}</strong> has been approved by our hiring team${scoreLine}.</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Please complete our interactive technical assessment (${maxQ} timed written phases, then a short voice round).</p>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0;"><tr><td style="border-radius:8px;background:#2563eb;">
            <a href="${link}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">Start your assessment</a>
          </td></tr></table>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#64748b;">If the button does not work, copy this link:</p>
          <p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${link}" style="color:#2563eb;">${link}</a></p>
          <p style="margin:0;font-size:16px;line-height:1.6;">Regards,<br><strong>${org}</strong></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

return [
  {
    json: {
      ...body,
      candidate_email: email,
      session_id: sessionId,
      session_db_id: sessionId,
      assessment_link: link,
      mail_subject: `Your application — next step: technical assessment (${role})`,
      mail_body_html: mailBodyHtml,
      session_phase: 1,
      config: { max_questions: maxQ, organization_name: org, requisition_title: role },
    },
  },
];

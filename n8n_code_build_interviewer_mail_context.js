// n8n: CODE - Build interviewer mail context
// Place BEFORE: MAIL - Interviewer pick slot
// Place AFTER:  nodes that set session_id, candidate_email, score, config

const base = $input.first().json;
const cfg = base.config || {};

const portalBase = String(
  base.interviewer_portal_base ||
    cfg.interviewer_portal_base ||
    cfg.portal_base_url ||
    'https://talent-acquisition-six.vercel.app/interviewer.html'
).replace(/\/interviewer\.html.*$/i, '').replace(/\/+$/, '');

const interviewerPortal = portalBase + '/interviewer.html';

let resumeUrl = String($execution.resumeUrl || base.resume_url || '').trim();
const publicBase = String(
  cfg.n8n_public_url || cfg.n8n_webhook_url || cfg.public_n8n_url || ''
).replace(/\/+$/, '');

function rewriteLocalResume(url) {
  if (!url) return url;
  if (!/localhost|127\.0\.0\.1/i.test(url)) return url;
  if (!publicBase) {
    throw new Error(
      'resumeUrl is localhost but config.n8n_public_url is missing. ' +
        'Set n8n WEBHOOK_URL to your public URL (ngrok/cloud) OR add config.n8n_public_url in CFG.'
    );
  }
  return url.replace(/^https?:\/\/[^/]+/i, publicBase);
}

resumeUrl = rewriteLocalResume(resumeUrl);

if (!resumeUrl) {
  throw new Error('Missing $execution.resumeUrl — this node must run BEFORE WAIT - Interviewer availability.');
}

const schedulingLink =
  interviewerPortal + '?resumeUrl=' + encodeURIComponent(resumeUrl);

const candidateEmail = String(base.candidate_email || '').trim();
const sessionId = String(base.session_id || '').trim();
const score = base.score != null ? base.score : '—';
const interviewerEmail = String(
  base.interviewer_email || cfg.interviewer_email || ''
).trim();

const mailSubject =
  base.mail_subject || `Schedule interview — ${candidateEmail} passed`;

const mailBody =
  `Hello,\n\n` +
  `Candidate ${candidateEmail} passed the technical assessment (score: ${score}/100).\n\n` +
  `Please select the interview date and time (45–60 minutes):\n` +
  `${schedulingLink}\n\n` +
  `Session ID: ${sessionId}\n\n` +
  `Thank you.`;

const mailBodyHtml =
  `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td style="color:#334155;font-size:15px;line-height:1.6;">
          <p>Hello,</p>
          <p>Candidate <strong>${candidateEmail}</strong> passed the technical assessment (score: <strong>${score}/100</strong>).</p>
          <p>Please select the interview date and time (45–60 minutes):</p>
          <p style="text-align:center;margin:28px 0;">
            <a href="${schedulingLink}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;">Propose interview slots</a>
          </p>
          <p style="font-size:13px;color:#64748b;">Session ID: ${sessionId}</p>
          <p>Thank you.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

return [
  {
    json: {
      ...base,
      config: cfg,
      resume_url: resumeUrl,
      interviewer_portal_base: interviewerPortal,
      scheduling_link: schedulingLink,
      interviewer_email: interviewerEmail,
      mail_subject: mailSubject,
      mail_body: mailBody,
      mail_body_html: mailBodyHtml,
    },
  },
];

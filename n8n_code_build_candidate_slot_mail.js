// n8n: CODE - Build candidate slot mail (PASS + pick interview — ONE email)
// Place AFTER:  CODE - Parse interviewer slot (slots ready)
// Place BEFORE: MAIL - Candidate pick slot
// IMPORTANT: Disable or bypass "MAIL - Pass" — candidate gets ONLY this mail.

const base = $input.first().json;
const cfg = base.config || {};

const portalBase = String(
  cfg.portal_base_url || cfg.candidate_portal_base || 'https://talent-acquisition-six.vercel.app'
).replace(/\/+$/, '');

const pickPortal = portalBase + '/candidate-pick.html';

let resumeUrl = String($execution.resumeUrl || base.candidate_resume_url || base.resume_url || '').trim();
const publicBase = String(cfg.n8n_public_url || cfg.n8n_webhook_url || '').replace(/\/+$/, '');

function rewriteLocalResume(url) {
  if (!url) return url;
  if (!/localhost|127\.0\.0\.1/i.test(url)) return url;
  if (!publicBase) {
    throw new Error('resumeUrl is localhost — set config.n8n_public_url or WEBHOOK_URL on n8n.');
  }
  return url.replace(/^https?:\/\/[^/]+/i, publicBase);
}

resumeUrl = rewriteLocalResume(resumeUrl);
if (!resumeUrl) {
  throw new Error('Missing $execution.resumeUrl — run BEFORE WAIT - Candidate slot status.');
}

const slots = Array.isArray(base.slots)
  ? base.slots
  : Array.isArray(base.proposed_slots)
    ? base.proposed_slots
    : [];

if (!slots.length) {
  throw new Error('No interview slots in payload — interviewer must submit slots first.');
}

const slotsParam = encodeURIComponent(JSON.stringify(slots));
const schedulingLink =
  pickPortal +
  '?resumeUrl=' +
  encodeURIComponent(resumeUrl) +
  '&slots_json=' +
  slotsParam;

const candidateEmail = String(base.candidate_email || '').trim();
const score = base.score != null ? base.score : '—';
const org = String(cfg.organization_name || 'Talent Acquisition Team');
const role = String(cfg.requisition_title || base.requisition_title || 'the role');

const mailSubject = base.mail_subject || `Congratulations — pick your interview time (${role})`;

const mailBody =
  `Hi,\n\n` +
  `Congratulations! You passed our technical assessment for ${role} (score: ${score}/100).\n\n` +
  `Next step: choose your interview time from the slots proposed by our team:\n` +
  `${schedulingLink}\n\n` +
  `The link opens a short page where you pick one time slot.\n\n` +
  `Best regards,\n${org}`;

const slotListHtml = slots
  .map((s) => `<li style="margin:6px 0;">${String(s.label || s.start_iso || '').replace(/</g, '&lt;')}</li>`)
  .join('');

const mailBodyHtml =
  `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;">
        <tr><td style="color:#334155;font-size:15px;line-height:1.6;">
          <p>Hi,</p>
          <p><strong>Congratulations!</strong> You passed our technical assessment for <strong>${role.replace(/</g, '&lt;')}</strong> (score: <strong>${score}/100</strong>).</p>
          <p>Next step — pick your interview time:</p>
          <ul style="padding-left:20px;color:#475569;">${slotListHtml}</ul>
          <p style="text-align:center;margin:28px 0;">
            <a href="${schedulingLink}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;">Choose interview time</a>
          </p>
          <p style="font-size:13px;color:#64748b;">Or copy this link: ${schedulingLink}</p>
          <p>Best regards,<br>${org.replace(/</g, '&lt;')}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

return [
  {
    json: {
      ...base,
      config: cfg,
      resume_url: resumeUrl,
      scheduling_link: schedulingLink,
      mail_subject: mailSubject,
      mail_body: mailBody,
      mail_body_html: mailBodyHtml,
      candidate_email: candidateEmail,
    },
  },
];

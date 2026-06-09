// n8n: CODE - Build interviewer confirmed mail (interviewer thread reply)
// Place AFTER: CAL - Create interview event
// Place BEFORE: Gmail Thread Reply (interviewer)

function pickSessionRow() {
  const names = ['HTTP - Fetch Session', 'CODE - Parse candidate choice', 'CODE - Prep scheduling from PASS'];
  for (const name of names) {
    try {
      const raw = $(name).first().json;
      const row = raw?.session_row || (Array.isArray(raw) ? raw[0] : raw);
      if (row?.id) return row;
    } catch (_) {}
  }
  return {};
}

const base = $input.first().json;
const session = pickSessionRow();
const cfg = { ...(session.config || {}), ...(base.config || {}) };

const threadId = String(session.interviewer_gmail_thread_id || base.interviewer_gmail_thread_id || '').trim();
const msgId = String(session.interviewer_gmail_message_id || base.interviewer_gmail_message_id || '').trim();

if (!threadId) throw new Error('interviewer_gmail_thread_id missing — send interviewer pitch mail first.');
if (!msgId) throw new Error('interviewer_gmail_message_id missing — PATCH after interviewer pitch mail.');

const role = String(cfg.requisition_title || base.requisition_title || 'the role');
const candidateEmail = String(base.candidate_email || session.candidate_email || '');
const slotLabel = String(
  base.selected_slot_label || base.slot_label || base.chosen_slot || base.start_iso || 'scheduled time'
);
const org = String(cfg.organization_name || 'Talent Acquisition Team');

const mailBodyHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:28px;">
        <tr><td style="color:#334155;font-size:15px;line-height:1.6;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;">── Interview Confirmed ──</p>
          <p>Hello,</p>
          <p>Interview scheduled for <strong>${candidateEmail.replace(/</g, '&lt;')}</strong> — <strong>${role.replace(/</g, '&lt;')}</strong>.</p>
          <p><strong>Time:</strong> ${slotLabel.replace(/</g, '&lt;')}</p>
          <p>Calendar invite has been created. Candidate confirmation sent in their thread.</p>
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
      session_id: session.id || base.session_id,
      interviewer_email: base.interviewer_email || cfg.interviewer_email,
      interviewer_gmail_thread_id: threadId,
      interviewer_gmail_message_id: msgId,
      mail_body_html: mailBodyHtml,
      config: cfg,
    },
  },
];

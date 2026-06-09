// n8n: CODE - Build interview confirmed mail (thread reply)
// Place AFTER: candidate picks slot / calendar event created
// Place BEFORE: Gmail Thread Reply node
//
// Input should include: candidate_email, selected slot, session row or thread ids

function pickSessionRow() {
  const names = [
    'HTTP - Fetch Session',
    'CODE - Parse candidate slot',
    'CODE - Prep scheduling from PASS',
    'CODE - Build candidate slot mail',
  ];
  for (const name of names) {
    try {
      const raw = $(name).first().json;
      const row = raw?.session_row || (Array.isArray(raw) ? raw[0] : raw);
      if (row?.gmail_thread_id || row?.id) return row;
    } catch (_) {}
  }
  return {};
}

const base = $input.first().json;
const session = pickSessionRow();
const cfg = { ...(session.config || {}), ...(base.config || {}) };

const threadId = String(session.gmail_thread_id || base.gmail_thread_id || '').trim();
const msgId = String(session.gmail_message_id || base.gmail_message_id || '').trim();

if (!threadId) throw new Error('gmail_thread_id missing — cannot reply in candidate thread.');
if (!msgId) throw new Error('gmail_message_id missing — send scheduling reply first.');

const role = String(cfg.requisition_title || base.requisition_title || 'the role');
const org = String(cfg.organization_name || 'Talent Acquisition Team');
const slotLabel = String(
  base.selected_slot_label ||
    base.slot_label ||
    base.chosen_slot ||
    base.start_iso ||
    'your selected time'
);
const sessionId = String(session.id || base.session_id || '');

const mailBodyHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:28px;">
        <tr><td style="color:#334155;font-size:15px;line-height:1.6;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;">── Interview Confirmed ──</p>
          <p>Hi,</p>
          <p>Your interview for <strong>${role.replace(/</g, '&lt;')}</strong> is confirmed.</p>
          <p><strong>Time:</strong> ${slotLabel.replace(/</g, '&lt;')}</p>
          <p>Please join on time. If you need to reschedule, reply to this email.</p>
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
      session_id: sessionId,
      gmail_thread_id: threadId,
      gmail_message_id: msgId,
      mail_body_html: mailBodyHtml,
      mail_stage: 'confirmed',
      candidate_email: base.candidate_email || session.candidate_email,
      config: cfg,
    },
  },
];

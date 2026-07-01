// n8n: CODE - Build interviewer confirmed mail (interviewer thread reply)
// After CAL (or scheduling-confirmed webhook)

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

function parseJson(raw, fallback = {}) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function pickSessionRow() {
  const names = [
    'CODE - Scheduling confirmed from session',
    'HTTP - SB GET session (confirmed)',
    'HTTP - SB GET session (slots)',
    'HTTP - Fetch Session',
    'HTTP - Fetch Session1',
    'CODE - Parse candidate choice',
    'CODE - Prep scheduling from PASS',
    'CODE - Prep scheduling from PASS1',
  ];
  for (const name of names) {
    const raw = pickNodeJson(name);
    if (!raw) continue;
    const row = raw?.session_row || (Array.isArray(raw) ? raw[0] : raw);
    if (row?.id) return row;
  }
  return {};
}

const ctx = pickNodeJson('CODE - Scheduling confirmed from session') || {};
const base = { ...ctx, ...($input.first().json || {}) };
const session = pickSessionRow();
const cfg = {
  ...parseJson(session.config, {}),
  ...(base.config || {}),
};
const screening = parseJson(session.screening, {});

const threadId = String(
  session.interviewer_gmail_thread_id ||
    base.interviewer_gmail_thread_id ||
    ctx.interviewer_gmail_thread_id ||
    screening.interviewer_gmail_thread_id ||
    cfg.interviewer_gmail_thread_id ||
    ''
).trim();
const msgId = String(
  session.interviewer_gmail_message_id ||
    base.interviewer_gmail_message_id ||
    ctx.interviewer_gmail_message_id ||
    screening.interviewer_gmail_message_id ||
    cfg.interviewer_gmail_message_id ||
    ''
).trim();

const role = String(cfg.requisition_title || base.requisition_title || 'the role');
const candidateEmail = String(base.candidate_email || session.candidate_email || '');
const slotLabel = String(
  base.selected_slot_label ||
    base.slot_label ||
    (typeof base.chosen_slot === 'object' ? base.chosen_slot?.label : base.chosen_slot) ||
    base.start_iso ||
    'scheduled time'
);
const org = String(cfg.organization_name || 'Talent Acquisition Team');
const interviewerEmail = String(
  base.interviewer_email || cfg.interviewer_email || session.interviewer_email || ''
).trim();
const sessionId = String(session.id || base.session_id || ctx.session_id || '').trim();

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

const out = {
  ...base,
  session_id: sessionId,
  interviewer_email: interviewerEmail,
  mail_body_html: mailBodyHtml,
  config: cfg,
};

// No interviewer pitch thread — skip Gmail reply (calendar + candidate mail still proceed).
if (!threadId || !msgId) {
  return [
    {
      json: {
        ...out,
        _skip_interviewer_confirmed_mail: true,
        _skip_reason:
          'interviewer_gmail_thread_id missing on session — PASS chain should run MAIL - Interviewer pitch mail and HTTP - PATCH interviewer thread (pitch) before scheduling confirm.',
        _debug_session_id: sessionId,
      },
    },
  ];
}

return [
  {
    json: {
      ...out,
      _skip_interviewer_confirmed_mail: false,
      interviewer_gmail_thread_id: threadId,
      interviewer_gmail_message_id: msgId,
    },
  },
];

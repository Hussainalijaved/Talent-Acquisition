// n8n: CODE - Build candidate slot mail (scheduling — thread reply)
// Triggered by: POST /webhook/talent/scheduling-slots { session_id }
// Input: HTTP - SB GET session (slots) — reads proposed_slots from Supabase
//
// Gmail node settings:
//   Resource:   thread
//   Operation:  reply
//   Thread ID:  {{ $json.gmail_thread_id }}
//   Message ID: {{ $json.gmail_message_id }}
//   Email Type: HTML
//   Message:    {{ $json.mail_body_html }}

function extractConfig(row) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  if (row.config && typeof row.config === 'object') Object.assign(out, row.config);
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('config.') && v != null && String(v).trim()) {
      out[k.slice(7)] = String(v).trim();
    }
  }
  return out;
}

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
  const fetchRaw = pickNodeJson(
    'HTTP - SB GET session (slots)',
    'HTTP - SB GET session (scheduling)',
    'HTTP - Fetch Session',
    'HTTP - Fetch Session1'
  );
  const row = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;
  if (row?.id) return row;

  const input = $input.first().json;
  if (input?.id) return input;
  return {};
}

function normalizeSlots(raw) {
  if (!raw) return [];
  let slots = raw;
  if (typeof slots === 'string') {
    try {
      slots = JSON.parse(slots);
    } catch (_) {
      return [];
    }
  }
  if (!Array.isArray(slots)) return [];
  return slots
    .map((s, i) => ({
      start_iso: s.start_iso || s.start || '',
      end_iso: s.end_iso || s.end || '',
      label: s.label || s.start_iso || `Slot ${i + 1}`,
    }))
    .filter((s) => s.start_iso || s.label);
}

const session = pickSessionRow();
const cfg = {
  ...extractConfig(session),
  ...(typeof session.config === 'object' ? session.config : {}),
};

const threadId = String(session.gmail_thread_id || '').trim();
const msgId = String(session.gmail_message_id || '').trim();
if (!threadId || threadId.startsWith('draft-')) {
  throw new Error('gmail_thread_id missing — shortlist mail must run first.');
}
if (!msgId) {
  throw new Error('gmail_message_id missing — PATCH after shortlist/result mail first.');
}

const portalBase = String(
  cfg.portal_base_url || cfg.candidate_portal_base || 'https://talent-acquisition-six.vercel.app'
).replace(/\/+$/, '');

const pickPortal = portalBase + '/candidate-pick.html';
const sessionId = String(session.id || '').trim();
if (!sessionId) {
  throw new Error('session id missing from Supabase row.');
}

const slots = normalizeSlots(session.proposed_slots);
if (!slots.length) {
  throw new Error(
    'proposed_slots empty on session — interviewer must submit slots on interviewer.html first.'
  );
}

const schedulingLink = pickPortal + '?session=' + encodeURIComponent(sessionId);

const candidateEmail = String(session.candidate_email || '').trim();
const score = session.score != null ? session.score : '—';
const org = String(cfg.organization_name || 'Talent Acquisition Team');
const role = String(cfg.requisition_title || session.requisition_id || 'the role');

const mailBody =
  `Hi,\n\n` +
  `Congratulations! You passed our technical assessment for ${role} (score: ${score}/100).\n\n` +
  `Next step: choose your interview time:\n` +
  `${schedulingLink}\n\n` +
  `Best regards,\n${org}`;

const slotListHtml = slots
  .map(
    (s) =>
      `<li style="margin:6px 0;">${String(s.label || s.start_iso || '').replace(/</g, '&lt;')}</li>`
  )
  .join('');

const mailBodyHtml =
  `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;">
        <tr><td style="color:#334155;font-size:15px;line-height:1.6;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;">── Interview Scheduling ──</p>
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
      ...session,
      config: cfg,
      session_id: sessionId,
      gmail_thread_id: threadId,
      gmail_message_id: msgId,
      scheduling_link: schedulingLink,
      proposed_slots: slots,
      slots,
      mail_body: mailBody,
      mail_body_html: mailBodyHtml,
      mail_stage: 'scheduling',
      candidate_email: candidateEmail,
      score,
      requisition_title: role,
    },
  },
];

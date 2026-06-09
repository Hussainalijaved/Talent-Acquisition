// n8n: CODE - Merge Gmail send response
// Runs AFTER: HTTP - SB PATCH session gmail thread (PATCH already saved gmail ids)
// Prepares data for HTTP - SB candidates shortlisted

function pickGmailPayload(raw) {
  if (!raw || typeof raw !== 'object') return {};
  if (raw.id || raw.messageId || raw.threadId || raw.thread_id) return raw;
  if (raw.message && typeof raw.message === 'object') return raw.message;
  if (Array.isArray(raw) && raw[0]) return pickGmailPayload(raw[0]);
  return raw;
}

const mapped = $('CODE - SB map session id').first().json;
const parse = $('CODE - Parse CV screening outcome').first().json;

let gmail = {};
try {
  gmail = pickGmailPayload($('MAIL - Email outreach agent (shortlist)').first().json);
} catch (_) {
  gmail = pickGmailPayload($input.first().json);
}

const msgId = String(gmail.id || gmail.messageId || '').trim();
const threadId = String(gmail.threadId || gmail.thread_id || msgId || '').trim();
const cfg = parse.config || mapped.config || {};
const maxQ = Number(cfg.max_questions ?? 5);
const phase = Number(mapped.session_phase || 1);
const mailSubject = `Your application — next step: technical assessment (Phase ${phase}/${maxQ})`;

return [
  {
    json: {
      ...parse,
      ...mapped,
      config: cfg,
      session_db_id: mapped.session_db_id || mapped.id,
      gmail_message_id: msgId || undefined,
      gmail_thread_id: threadId || undefined,
      mail_subject: mailSubject,
      session_phase: phase,
    },
  },
];

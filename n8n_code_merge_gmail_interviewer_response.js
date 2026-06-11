// n8n: CODE - Merge Gmail interviewer mail response
// After MAIL - Interviewer pitch (Send) OR MAIL - Reply interviewer thread
// Saves interviewer_gmail_thread_id + interviewer_gmail_message_id on session

function pickContext() {
  const names = [
    'CODE - Build interviewer mail context',
    'CODE - Build interviewer confirmed mail',
    'CODE - Prep scheduling from PASS',
    'CODE - Parse Result',
    'HTTP - Fetch Session',
  ];
  let merged = {};
  for (const name of names) {
    try {
      merged = { ...merged, ...($input.first().json || {}), ...$(name).first().json };
    } catch (_) {}
  }
  return merged;
}

function resolveGmailPayload(input, ...mailNodeNames) {
  if (input && (input.id || input.messageId || input.threadId || input.thread_id)) {
    return input;
  }
  for (const name of mailNodeNames) {
    if (!name) continue;
    try {
      const raw = $(name).first().json;
      if (raw && (raw.id || raw.messageId || raw.threadId || raw.thread_id)) return raw;
    } catch (_) {}
  }
  return input || {};
}

const gmail = resolveGmailPayload($input.first().json, 'MAIL - Interviewer pitch mail', 'MAIL - Interviewer pitch mail1', 'MAIL - Notify interviewer', 'MAIL - Notify interviewer1');
const ctx = pickContext();
const cfg = ctx.config || {};

const msgId = String(gmail.id || gmail.messageId || '').trim();
const threadId = String(gmail.threadId || gmail.thread_id || ctx.interviewer_gmail_thread_id || '').trim();
const sessionId = String(ctx.session_id || ctx.session_db_id || ctx.id || '').trim();
const mailSubject = String(ctx.mail_subject || ctx.interviewer_mail_subject || '').trim();

const patchReady = Boolean(sessionId && threadId && msgId);
const b = String(cfg.supabase_url || '').replace(/\/+$/, '');
const tb = cfg.table_assessment_sessions || 'assessment_sessions';

return [
  {
    json: {
      ...ctx,
      interviewer_gmail_thread_id: threadId || ctx.interviewer_gmail_thread_id || null,
      interviewer_gmail_message_id: msgId || ctx.interviewer_gmail_message_id || null,
      interviewer_mail_subject: mailSubject || ctx.interviewer_mail_subject || null,
      _interviewer_patch_skipped: !patchReady,
      _interviewer_patch_skip_reason: !patchReady
        ? [
            !sessionId ? 'missing session_id' : null,
            !threadId ? 'missing gmail threadId' : null,
            !msgId ? 'missing gmail message id' : null,
          ]
            .filter(Boolean)
            .join('; ')
        : '',
      _interviewer_patch_url: patchReady
        ? `${b}/rest/v1/${tb}?id=eq.${encodeURIComponent(sessionId)}`
        : '',
      _interviewer_patch_body: patchReady
        ? {
            interviewer_gmail_thread_id: threadId,
            interviewer_gmail_message_id: msgId,
            interviewer_mail_subject: mailSubject || undefined,
            updated_at: new Date().toISOString(),
          }
        : {},
    },
  },
];

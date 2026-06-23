// n8n: CODE - Merge Gmail interviewer mail response
// After MAIL - Interviewer pitch (Send) OR MAIL - Reply interviewer thread
// Saves interviewer_gmail_thread_id + interviewer_gmail_message_id on session

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

function pickContext() {
  const names = [
    'CODE - Build interviewer mail context',
    'CODE - Build interviewer mail context1',
    'CODE - Prep scheduling from PASS',
    'CODE - Prep scheduling from PASS1',
    'CODE - Pick Parse Result',
    'CODE - Pick Parse Result1',
    'CODE - Parse Live Speech Result',
    'CODE - Parse Result',
    'CODE - Parse Result1',
    'CFG - Live Speech Config (complete)',
    'CFG - Assessment Config',
    'CFG - Assessment Config1',
    'HTTP - Fetch Session Complete',
    'HTTP - Fetch Session',
    'HTTP - Fetch Session1',
  ];
  let merged = { ...($input.first().json || {}) };
  for (const name of names) {
    try {
      const row = $(name).first().json;
      if (row && typeof row === 'object') {
        merged = { ...merged, ...row };
        if (row.config && typeof row.config === 'object') {
          merged.config = { ...(merged.config || {}), ...row.config };
        }
      }
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

const gmail = resolveGmailPayload(
  $input.first().json,
  'MAIL - Interviewer pitch mail',
  'MAIL - Interviewer pitch mail1',
  'MAIL - Notify interviewer',
  'MAIL - Notify interviewer1'
);
const ctx = pickContext();
const built = pickNodeJson(
  'CODE - Build interviewer mail context',
  'CODE - Build interviewer mail context1'
);
const cfg = { ...(ctx.config || {}), ...(built?.config || {}) };

const msgId = String(gmail.id || gmail.messageId || '').trim();
const threadId = String(gmail.threadId || gmail.thread_id || ctx.interviewer_gmail_thread_id || '').trim();
const sessionId = String(
  ctx.session_id || ctx.session_db_id || ctx.id || built?.session_id || ''
).trim();
const mailSubject = String(
  built?.mail_subject || ctx.interviewer_mail_subject || ''
).trim();

const patchReady = Boolean(sessionId && threadId && msgId);
const b = String(cfg.supabase_url || '').replace(/\/+$/, '');
const tb = cfg.table_assessment_sessions || 'assessment_sessions';

if (!patchReady) {
  throw new Error(
    [
      'interviewer gmail PATCH not ready',
      !sessionId ? 'missing session_id' : null,
      !threadId ? 'missing gmail threadId from MAIL output' : null,
      !msgId ? 'missing gmail message id from MAIL output' : null,
    ]
      .filter(Boolean)
      .join('; ')
  );
}

if (!b || !/^https?:\/\//i.test(b)) {
  throw new Error('supabase_url missing in config — set in CFG node.');
}

return [
  {
    json: {
      ...ctx,
      session_id: sessionId,
      interviewer_gmail_thread_id: threadId,
      interviewer_gmail_message_id: msgId,
      interviewer_mail_subject: mailSubject || null,
      _interviewer_patch_skipped: false,
      _interviewer_patch_url: `${b}/rest/v1/${tb}?id=eq.${encodeURIComponent(sessionId)}`,
      _interviewer_patch_body: {
        interviewer_gmail_thread_id: threadId,
        interviewer_gmail_message_id: msgId,
        interviewer_mail_subject: mailSubject || undefined,
        updated_at: new Date().toISOString(),
      },
      _supabase_key: String(cfg.supabase_key || '').trim(),
    },
  },
];

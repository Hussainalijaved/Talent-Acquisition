// n8n: CODE - Merge Gmail reply response
// Paste AFTER any Gmail "Thread → Reply" node.
// Prepares Supabase PATCH so the next reply chains to this message.
//
// Wire:
//   Gmail Thread Reply → this node → HTTP PATCH session gmail message
//
// Set HTTP PATCH node:
//   URL:  {{ $json._gmail_patch_url }}
//   Body: {{ $json._gmail_patch_body }}

function pickSessionContext() {
  const names = [
    'CODE - Build assessment result mail',
    'CODE - Build candidate slot mail',
    'CODE - Build interview confirmed mail',
    'CODE - Build Gmail thread reply context',
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

const gmail = resolveGmailPayload(
  $input.first().json,
  'MAIL - Candidate pitch mail',
  'MAIL - Candidate pitch mail1',
  'MAIL - Notify candidate',
  'MAIL - Notify candidate1'
);
const ctx = pickSessionContext();
const cfg = ctx.config || {};

const msgId = String(gmail.id || gmail.messageId || '').trim();
const threadId = String(gmail.threadId || gmail.thread_id || ctx.gmail_thread_id || '').trim();

const sessionId = String(
  ctx.session_id || ctx.session_db_id || ctx.id || ''
).trim();

const patchReady = Boolean(sessionId && threadId && msgId);
if (!patchReady) {
  return [
    {
      json: {
        ...ctx,
        _gmail_patch_skipped: true,
        _gmail_patch_skip_reason: [
          !sessionId ? 'missing session_id' : null,
          !threadId ? 'missing gmail_thread_id' : null,
          !msgId ? 'missing gmail message id' : null,
        ]
          .filter(Boolean)
          .join('; '),
        _gmail_patch_url: '',
        _gmail_patch_body: {},
      },
    },
  ];
}

const b = String(cfg.supabase_url || '').replace(/\/+$/, '');
const tb = cfg.table_assessment_sessions || 'assessment_sessions';

return [
  {
    json: {
      ...ctx,
      gmail_message_id: msgId,
      gmail_thread_id: threadId,
      _gmail_patch_url: `${b}/rest/v1/${tb}?id=eq.${encodeURIComponent(sessionId)}`,
      _gmail_patch_body: {
        gmail_message_id: msgId,
        gmail_thread_id: threadId,
        updated_at: new Date().toISOString(),
      },
    },
  },
];

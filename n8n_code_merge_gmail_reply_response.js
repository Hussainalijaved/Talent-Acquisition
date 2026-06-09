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

const gmail = $input.first().json;
const ctx = pickSessionContext();
const cfg = ctx.config || {};

const msgId = String(gmail.id || gmail.messageId || '').trim();
const threadId = String(gmail.threadId || gmail.thread_id || ctx.gmail_thread_id || '').trim();

const sessionId = String(
  ctx.session_id || ctx.session_db_id || ctx.id || ''
).trim();

if (!sessionId) {
  throw new Error('Missing session_id — cannot update gmail_message_id after reply.');
}
if (!threadId) {
  throw new Error('Missing gmail_thread_id — first shortlist mail must create the thread.');
}
if (!msgId) {
  throw new Error('Gmail reply returned no message id.');
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

// n8n: CODE - Build PASS session PATCH body
// Use BEFORE "HTTP - PATCH session thread after PASS"
//
// Pass mail remove karne ke baad gmail_thread_id null hota hai — DB NOT NULL error aata hai.
// Yeh node sirf woh fields bhejta hai jo set honi chahiye; null gmail_thread_id skip karta hai.
//
// HTTP node settings:
//   URL:  {{ $json._pass_session_patch_url }}
//   Body: {{ $json._pass_session_patch_body }}

const item = $input.first().json;
const cfg = item.config || {};
const sessionId = String(
  item.session_id || item.session_db_id || item.id || ''
).trim();
const result = String(item.result || 'PASS').trim().toUpperCase();

if (!sessionId) {
  throw new Error('Missing session_id for PASS session PATCH');
}

const base = String(cfg.supabase_url || '').replace(/\/+$/, '');
const tb = cfg.table_assessment_sessions || 'assessment_sessions';

const body = {
  result,
  status: 'completed',
};

const threadId = String(item.gmail_thread_id || '').trim();
const isRealThread =
  threadId.length > 0 &&
  !threadId.startsWith('pending-') &&
  !threadId.startsWith('draft-');

if (isRealThread) {
  body.gmail_thread_id = threadId;
}

return [
  {
    json: {
      ...item,
      _pass_session_patch_url: `${base}/rest/v1/${tb}?id=eq.${encodeURIComponent(sessionId)}`,
      _pass_session_patch_body: body,
    },
  },
];

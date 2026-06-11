// n8n: CODE - Scheduling webhook normalize
// After TRG - Webhook (scheduling-slots or scheduling-confirmed)

const raw = $input.first().json || {};
const body = raw.body || raw;
const sessionId = String(body.session_id || body.sessionId || raw.session_id || '').trim();

if (!sessionId) {
  throw new Error('session_id required in webhook body.');
}

return [
  {
    json: {
      session_id: sessionId,
      webhook_kind: raw.webhook_kind || body.webhook_kind || 'scheduling',
    },
  },
];

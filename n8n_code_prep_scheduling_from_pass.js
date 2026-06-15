// n8n: CODE - Prep scheduling from PASS
// After assessment result mail PATCH — loads session row for scheduling chain

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
  const built =
    pickNodeJson(
      'CODE - Build Speech LLM context',
      'CODE - Build Speech LLM context1',
      'CODE - Build LLM context',
      'CODE - Build LLM context1'
    ) || {};
  if (built.session?.id) return built.session;

  const fetchRaw = pickNodeJson('HTTP - Fetch Session', 'HTTP - Fetch Session1');
  const row = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;
  if (row?.id) return row;

  return {};
}

const parse =
  pickNodeJson(
    'CODE - Pick Parse Result',
    'CODE - Pick Parse Result1',
    'CODE - Parse Speech Result',
    'CODE - Parse Speech Result1',
    'CODE - Parse Technical Result',
    'CODE - Parse Technical Result1'
  ) || $input.first().json || {};
const session = pickSessionRow();
const cfg = { ...(session.config || {}), ...(parse.config || {}) };

return [
  {
    json: {
      ...parse,
      ...session,
      session_id: session.id || parse.session_id,
      candidate_email: parse.candidate_email || session.candidate_email,
      score: parse.score ?? session.score,
      result: parse.result || session.result,
      requisition_title: cfg.requisition_title || session.requisition_title,
      config: cfg,
      gmail_thread_id: session.gmail_thread_id,
      gmail_message_id: session.gmail_message_id,
      mail_subject: session.mail_subject,
      interviewer_gmail_thread_id: session.interviewer_gmail_thread_id,
      interviewer_gmail_message_id: session.interviewer_gmail_message_id,
    },
  },
];

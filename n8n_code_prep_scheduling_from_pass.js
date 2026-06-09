// n8n: CODE - Prep scheduling from PASS
// After assessment result mail PATCH — loads session row for scheduling chain

function pickSessionRow() {
  const names = ['HTTP - Fetch Session', 'CODE - Parse Result'];
  for (const name of names) {
    try {
      const raw = $(name).first().json;
      const row = Array.isArray(raw) ? raw[0] : raw;
      if (row?.id) return row;
    } catch (_) {}
  }
  return {};
}

const parse = $('CODE - Parse Result').first().json;
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

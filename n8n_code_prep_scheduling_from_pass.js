// n8n: CODE - Prep scheduling from PASS
// After IF PASS — loads session row for scheduling chain (interviewer mail first)

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

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function pickSessionRow() {
  const built =
    pickNodeJson(
      'CODE - Build Live Speech Relay Context',
      'CODE - Build Speech LLM context',
      'CODE - Build Speech LLM context1',
      'CODE - Build LLM context',
      'CODE - Build LLM context1'
    ) || {};
  if (built.session?.id) return built.session;

  const fetchRaw = pickNodeJson(
    'HTTP - Fetch Session Complete',
    'HTTP - Fetch Session',
    'HTTP - Fetch Session1'
  );
  const row = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;
  if (row?.id) return row;

  return {};
}

const parse =
  pickNodeJson(
    'CODE - Pick Parse Result',
    'CODE - Pick Parse Result1',
    'CODE - Parse Live Speech Result',
    'CODE - Parse Speech Result',
    'CODE - Parse Speech Result1',
    'CODE - Parse Technical Result',
    'CODE - Parse Technical Result1'
  ) || $input.first().json || {};
const session = pickSessionRow();
const sessionCfg = parseJson(session.config, {});
const parseCfg = parseJson(parse.config, parse.config || {});
const cfg = { ...sessionCfg, ...parseCfg };

const interviewerEmail = String(
  sessionCfg.interviewer_email ||
    parseCfg.interviewer_email ||
    parse.interviewer_email ||
    cfg.interviewer_email ||
    ''
).trim();

return [
  {
    json: {
      ...parse,
      ...session,
      session_id: session.id || parse.session_id,
      candidate_email: parse.candidate_email || session.candidate_email,
      score: parse.score ?? session.score,
      result: parse.result || session.result,
      requisition_title:
        cfg.requisition_title || session.requisition_title || parse.requisition_title,
      interviewer_email: interviewerEmail,
      config: { ...cfg, interviewer_email: interviewerEmail },
      gmail_thread_id: session.gmail_thread_id,
      gmail_message_id: session.gmail_message_id,
      mail_subject: session.mail_subject,
      interviewer_gmail_thread_id: session.interviewer_gmail_thread_id,
      interviewer_gmail_message_id: session.interviewer_gmail_message_id,
    },
  },
];

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

function extractConfig(row) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  if (row.config && typeof row.config === 'object') Object.assign(out, row.config);
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('config.') && v != null && String(v).trim()) {
      out[k.slice(7)] = String(v).trim();
    }
  }
  return out;
}

function mergeConfig(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    Object.assign(out, extractConfig(src));
    if (src.config && typeof src.config === 'object') {
      for (const [k, v] of Object.entries(src.config)) {
        if (v != null && String(v).trim()) out[k] = String(v).trim();
      }
    }
  }
  return out;
}

function loadWorkflowConfig() {
  const names = [
    'CFG - Live Speech Config (complete)',
    'CFG - Live Speech Config (start)',
    'CFG - Assessment Config',
    'CFG - Assessment Config1',
    'CFG - Workflow configuration',
    'CFG - Workflow configuration1',
  ];
  return mergeConfig(...names.map((n) => pickNodeJson(n)).filter(Boolean));
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
const cfg = {
  ...loadWorkflowConfig(),
  ...sessionCfg,
  ...parseCfg,
};

const interviewerEmail = String(
  sessionCfg.interviewer_email ||
    parseCfg.interviewer_email ||
    parse.interviewer_email ||
    cfg.interviewer_email ||
    ''
).trim();

const sessionId = String(session.id || parse.session_id || '').trim();
const sb = String(cfg.supabase_url || '').replace(/\/+$/, '');
const tb = cfg.table_assessment_sessions || 'assessment_sessions';
const nowIso = new Date().toISOString();

return [
  {
    json: {
      ...parse,
      ...session,
      session_id: sessionId,
      candidate_email: parse.candidate_email || session.candidate_email,
      candidate_name: parse.candidate_name || session.candidate_name || null,
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
      _supabase_key: String(cfg.supabase_key || '').trim(),
      _scheduling_patch_url: sessionId
        ? `${sb}/rest/v1/${tb}?id=eq.${encodeURIComponent(sessionId)}`
        : '',
      _scheduling_patch_body: {
        scheduling_status: 'pending_interviewer',
        scheduling_updated_at: nowIso,
        updated_at: nowIso,
      },
    },
  },
];

"""n8n Code node bodies — frontend JD + assessment session.config."""

EXPAND_CVS_AND_DUPLICATE_FLAG = r"""const cfg = $('CFG - Workflow configuration').first().json;
const pdf = $('PDF - Extract text').first().json;
const rows = $input.all().map((i) => i.json);

let triggerData = {};
try {
  triggerData = $('MUX - Combine manual and webhook').first().json;
} catch (e) {
  try {
    triggerData = $('TRG - Webhook CV ingest').first().json;
  } catch (err) {
    try {
      triggerData = $('TRG - Manual (testing)').first().json;
    } catch (err2) {
      triggerData = {};
    }
  }
}

const body = triggerData.body || triggerData;
const emailRaw =
  body.candidate_email ||
  triggerData.query?.candidate_email ||
  cfg.body?.candidate_email ||
  cfg.demo?.candidate_email ||
  '';
const cvRaw = pdf.text || body.cv_text || cfg.body?.cv_text || cfg.demo?.cv_text || '';

const email = (emailRaw || 'candidate@example.com').trim().toLowerCase();
const cv = cvRaw.trim();
const canon = String(cv || '').replace(/\s+/g, ' ').trim().slice(0, 6144);
const fingerprint = `${email}|${canon}`;

// Duplicate only when BOTH email and fingerprint (email + CV text) match an existing row.
const is_duplicate = rows.some(
  (r) =>
    (r.candidate_email && r.candidate_email.toLowerCase() === email) &&
    (r.fingerprint && r.fingerprint === fingerprint)
);

const requisition_id =
  body.requisition_id ||
  triggerData.query?.requisition_id ||
  cfg.body?.requisition_id ||
  cfg.demo?.requisition_id ||
  '';

const baseConfig = cfg.config || {};
const config = {
  ...baseConfig,
  requisition_title:
    body.requisition_title ||
    body.job_title ||
    baseConfig.requisition_title ||
    'Open role',
  requisition_requirements:
    body.requisition_requirements ||
    body.jd_text ||
    baseConfig.requisition_requirements ||
    '',
};

return [{
  json: {
    ...cfg,
    config,
    candidate_email: email,
    cv_text: cv,
    fingerprint,
    is_duplicate,
    requisition_id,
  },
}];"""

PREP_SHORTLIST_BEFORE_DB = r"""const base = $('CODE - Parse CV screening outcome').first().json;
const cfgNode = $('CFG - Workflow configuration').first().json;
const cfg = base.config || cfgNode.config || cfgNode;

const b = String(cfg.supabase_url || '').replace(/\/+$/, '');
const email = String(base.candidate_email || '').trim().toLowerCase();
const pendingThread = `pending-${email.replace(/[^a-z0-9@._-]/gi, '')}-${Date.now()}`;

return [{
  json: {
    ...base,
    config: cfg,
    candidate_email: email,
    gmail_thread_id: pendingThread,
    session_phase: base.session_phase || 1,
    _sb_insert_candidates: `${b}/rest/v1/${cfg.table_candidates || 'candidates'}`,
    _sb_insert_sessions: `${b}/rest/v1/${cfg.table_assessment_sessions || 'assessment_sessions'}`,
  },
}];"""

SB_PREPARE_SESSION_INSERT = r"""function timerBounds(config) {
  const min = Number(config?.timer_min_seconds);
  const max = Number(config?.timer_max_seconds);
  return {
    min: Number.isFinite(min) && min > 0 ? min : 60,
    max: Number.isFinite(max) && max > 0 ? max : 600,
  };
}

function useAiTimeLimitSeconds(raw, config) {
  const { min, max } = timerBounds(config);
  let sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) {
    sec = Number(config?.default_phase_seconds ?? config?.phase_1_timer_seconds ?? 240);
  }
  if (!Number.isFinite(sec) || sec <= 0) sec = 240;
  return Math.min(max, Math.max(min, Math.round(sec)));
}

function buildDeadline(isoStart, seconds) {
  const start = isoStart ? new Date(isoStart) : new Date();
  return new Date(start.getTime() + seconds * 1000).toISOString();
}

function isRealGmailThreadId(id) {
  const s = String(id || '').trim();
  return s.length > 0 && !s.startsWith('pending-');
}

function pickGmailThreadId(...candidates) {
  for (const id of candidates) {
    if (isRealGmailThreadId(id)) return String(id).trim();
  }
  return '';
}

const parse = $('CODE - Parse CV screening outcome').first().json;
const inp = $input.first().json || {};
const httpOut =
  inp.candidate_email || inp.stage || inp.notes || inp.gmail_thread_id ? inp : {};
const notes =
  typeof httpOut?.notes === 'object' && httpOut.notes ? httpOut.notes : parse.screening || {};

const cfg =
  parse.config || $('CFG - Workflow configuration').first().json.config || {};

const jdTitle = String(cfg.requisition_title || '').trim();
const jdReq = String(cfg.requisition_requirements || '').trim();
if (!jdTitle || !jdReq) {
  throw new Error(
    'JD missing in config — recruiter form must run before session insert.'
  );
}

const nowIso = new Date().toISOString();
const candidate_email = String(
  httpOut.candidate_email || parse.candidate_email || inp.candidate_email || ''
).trim().toLowerCase();

const qText = String(
  parse.phase_1_question || notes.phase_1_question || ''
).trim();

const aiSeconds =
  parse.phase_1_time_limit_seconds ??
  notes.time_limit_seconds ??
  notes.timeLimitSeconds;

const time_limit_seconds = useAiTimeLimitSeconds(aiSeconds, cfg);
const deadline_at = buildDeadline(nowIso, time_limit_seconds);
const complexity_tier =
  parse.phase_1_complexity_tier || notes.complexity_tier || notes.complexityTier || null;

const cv = String(parse.cv_plaintext || parse.cv_text || '').slice(0, 12000);
const realThread = pickGmailThreadId(
  parse.gmail_thread_id,
  httpOut.gmail_thread_id,
  inp.gmail_thread_id
);
const gmail_thread_id =
  realThread ||
  `pending-${candidate_email.replace(/[^a-z0-9@._-]/gi, '')}-${Date.now()}`;

const requisition_id =
  String(parse.requisition_id || httpOut.requisition_id || inp.requisition_id || '').trim() ||
  jdTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

const sessionBody = {
  gmail_thread_id,
  candidate_email,
  current_phase: 1,
  max_phases: cfg.max_questions ?? 5,
  status: 'assessment',
  screening: parse.screening || notes,
  score: httpOut.score ?? parse.score ?? null,
  requisition_id,
  fingerprint: httpOut.fingerprint || parse.fingerprint || '',
  cv_plaintext: cv,
  last_question_sent_at: nowIso,
  updated_at: nowIso,
  config: {
    requisition_title: jdTitle,
    requisition_requirements: jdReq,
    organization_name: cfg.organization_name,
    groq_model: cfg.groq_model,
    gemini_model: cfg.gemini_model,
    max_questions: cfg.max_questions,
    interviewer_email: cfg.interviewer_email,
    supabase_url: cfg.supabase_url,
    supabase_key: cfg.supabase_key,
    table_assessment_sessions: cfg.table_assessment_sessions,
    fail_score_threshold: cfg.fail_score_threshold ?? 30,
    pass_score_threshold: cfg.pass_score_threshold ?? 60,
    timer_min_seconds: cfg.timer_min_seconds ?? 60,
    timer_max_seconds: cfg.timer_max_seconds ?? 600,
  },
  interview_history: [
    {
      phase: 1,
      question_text: qText,
      answer_text: null,
      score: null,
      suggested_answer: null,
      feedback: null,
      time_limit_seconds,
      deadline_at,
      complexity_tier,
      sent_at: nowIso,
    },
  ],
};

const b = String(cfg.supabase_url || '').replace(/\/+$/, '');

return [
  {
    json: {
      ...parse,
      ...httpOut,
      config: cfg,
      candidate_email,
      gmail_thread_id,
      gmail_thread_is_pending: !realThread,
      requisition_id,
      phase_1_question: qText,
      phase_1_time_limit_seconds: time_limit_seconds,
      _sb_insert_sessions: `${b}/rest/v1/${cfg.table_assessment_sessions || 'assessment_sessions'}`,
      _session_body: sessionBody,
      _now: nowIso,
      _q_text: qText,
    },
  },
];"""

BUILD_LLM_CONTEXT = r"""const norm = $('CODE - Normalize Data').first().json;
const raw = $input.first().json;
const session = Array.isArray(raw) ? raw[0] : raw;
if (!session?.id) {
  throw new Error('No assessment session row for id=' + norm.session_id);
}

let history = session.interview_history;
if (typeof history === 'string') {
  try { history = JSON.parse(history); } catch (e) { history = []; }
}
if (!Array.isArray(history)) history = [];

let sessionConfig = session.config;
if (typeof sessionConfig === 'string') {
  try {
    sessionConfig = JSON.parse(sessionConfig);
  } catch (e) {
    sessionConfig = {};
  }
}
if (!sessionConfig || typeof sessionConfig !== 'object') sessionConfig = {};

const cfg = {
  ...norm.config,
  ...sessionConfig,
  requisition_title:
    sessionConfig.requisition_title || norm.config?.requisition_title || '',
  requisition_requirements:
    sessionConfig.requisition_requirements || norm.config?.requisition_requirements || '',
};

if (!cfg.requisition_title || !cfg.requisition_requirements) {
  throw new Error(
    'JD missing on assessment session.config — use CV screening with frontend JD or PATCH session.config in Supabase.'
  );
}

const ph = Number(norm.current_phase || 1);
const maxQ = Number(cfg.max_questions || 5);
const isFinal = ph >= maxQ;
const failThreshold = Number(cfg.fail_score_threshold ?? 30);
const passThreshold = Number(cfg.pass_score_threshold ?? 60);
const jdTitle = cfg.requisition_title;
const jdReq = cfg.requisition_requirements;
const cvText = String(session.cv_plaintext || '').slice(0, 8000);

const historyText = history
  .map((h) =>
    [
      `Phase ${h.phase}`,
      `Q: ${h.question_text || h.question || ''}`,
      `A: ${h.answer_text ?? 'pending'}`,
      `Score: ${h.score ?? 'N/A'}`,
      `Time: ${h.time_limit_seconds ?? 'N/A'}s`,
      `Tier: ${h.complexity_tier ?? 'N/A'}`,
    ].join(' | ')
  )
  .join('\n');

const lastPhase = history.filter((h) => h.time_limit_seconds != null).slice(-1)[0];

const lastTimeHint = lastPhase
  ? `Previous question: time_limit_seconds=${lastPhase.time_limit_seconds}, tier=${lastPhase.complexity_tier || 'N/A'}. If next question is simpler, use less time; if harder/longer, use more. Do NOT repeat the same seconds unless complexity is identical.`
  : 'No previous timed question in this session.';

const contextBlock = [
  `Assessment phase: ${ph} of ${maxQ}`,
  isFinal ? 'MODE: FINAL — grade holistically and finish.' : 'MODE: IN_PROGRESS — grade current answer and emit next question.',
  '',
  `Job title: ${jdTitle}`,
  `JD requirements:\n${jdReq}`,
  '',
  `Candidate CV (excerpt):\n${cvText}`,
  '',
  'STRICT TOPIC RULE: Question topics must come from CV evidence only. Do not ask about JD skills absent from the CV (e.g. no Blazor questions if CV has no Blazor). Use JD for role context and to pick which CV-backed skill to probe deeper.',
  '',
  `Prior Q&A:\n${historyText || '(none)'}`,
  '',
  lastTimeHint,
  '',
  `Current answer (phase ${ph}):\n${norm.answer}`,
  '',
  `Tab switches recorded: ${norm.tab_switches || 0}`,
  `Fail threshold (this phase): below ${failThreshold}/100`,
  `Pass threshold (final decision guide): ${passThreshold}/100`,
].join('\n');

const prompt = `${contextBlock}\n\nFollow your system instructions exactly.\nReturn valid JSON only — no markdown, no extra text.`;

return [{
  json: {
    prompt,
    session,
    norm: { ...norm, config: cfg },
    isFinal,
    failThreshold,
    passThreshold,
  },
}];"""

UPDATE_INTERVIEW_HISTORY_CONFIG_MERGE = r"""// Ensures portal response uses merged JD from session when available
const built = $('CODE - Build LLM context').first().json;
const session = built.session;
let sessionConfig = session.config;
if (typeof sessionConfig === 'string') {
  try { sessionConfig = JSON.parse(sessionConfig); } catch (e) { sessionConfig = {}; }
}
const mergedConfig = { ...built.norm.config, ...(sessionConfig || {}) };
// rest of node unchanged — applied via suffix in patch script only for config line
"""

PARSE_INTERVIEWER_SLOT_END_FIX = None  # patched inline in patch script

CODE_PATCHES = {
    "CODE - Expand CVs and duplicate flag": EXPAND_CVS_AND_DUPLICATE_FLAG,
    "CODE - Prep shortlist before DB": PREP_SHORTLIST_BEFORE_DB,
    "CODE - SB prepare session insert": SB_PREPARE_SESSION_INSERT,
    "CODE - Build LLM context": BUILD_LLM_CONTEXT,
}

# Fix 1h end time in parse interviewer slot (was 60 * 60000 ms typo)
PARSE_INTERVIEWER_SLOT_FIX_OLD = "60 * 60000"
PARSE_INTERVIEWER_SLOT_FIX_NEW = "60 * 60 * 1000"

GROQ_AUTH_EXPR = "=Bearer {{ $env.GROQ_API_KEY }}"

CFG_WORKFLOW_EXTRA_ASSIGNMENTS = [
    {"id": "cfg_fail", "name": "config.fail_score_threshold", "value": 30, "type": "number"},
    {"id": "cfg_pass", "name": "config.pass_score_threshold", "value": 60, "type": "number"},
    {"id": "cfg_tmin", "name": "config.timer_min_seconds", "value": 60, "type": "number"},
    {"id": "cfg_tmax", "name": "config.timer_max_seconds", "value": 600, "type": "number"},
]

CFG_ASSESSMENT_NODE_NAMES = ["CFG - Workflow", "CFG - Assessment Config"]

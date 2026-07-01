// n8n: CODE - SB prepare session insert
// Flow: GATE Shortlist → this node → HTTP insert (always new row) → map session id → MAIL → PATCH thread
//
// HTTP - SB insert assessment session:
//   URL:     {{ $json._sb_insert_sessions }}
//   Prefer:  {{ $json._session_prefer }}
//   Body:    {{ $json._session_body }}

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

function timerBounds(config) {
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

function slugFromTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

function normalizeWrittenQuestionBounds(rawMin, rawMax) {
  let min = Number(rawMin);
  let max = Number(rawMax);
  if (!Number.isFinite(min)) min = 4;
  if (!Number.isFinite(max)) max = 10;
  min = Math.min(20, Math.max(1, Math.round(min)));
  max = Math.min(20, Math.max(1, Math.round(max)));
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

function clampWrittenQuestionCount(n, min, max) {
  const bounds = normalizeWrittenQuestionBounds(min, max);
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(v)));
}

function questionBoundsFromConfig(cfg) {
  return normalizeWrittenQuestionBounds(cfg?.written_questions_min, cfg?.written_questions_max);
}

function resolveEffectiveWrittenMaxQuestions(cfg, sessionRow) {
  const bounds = questionBoundsFromConfig(cfg || {});
  const raw =
    cfg?.written_question_count ??
    cfg?.max_questions ??
    sessionRow?.max_phases;
  return clampWrittenQuestionCount(raw, bounds.min, bounds.max);
}

const parse =
  pickNodeJson('CODE - Parse CV screening outcome', 'CODE - Parse CV screening outcome1') || {};
const expand =
  pickNodeJson(
    'CODE - Expand CVs and duplicate flag',
    'CODE - Expand CVs and duplicate flag1'
  ) || {};
const intake =
  pickNodeJson(
    'CODE - Frontend intake (JD + CV)',
    'CODE - Frontend intake (JD + CV)1'
  ) || {};
const inp = $input.first().json || {};
const httpOut =
  inp.candidate_email || inp.stage || inp.notes || inp.gmail_thread_id ? inp : {};

const notes =
  typeof httpOut?.notes === 'object' && httpOut.notes ? httpOut.notes : parse.screening || {};

const cfgRow =
  pickNodeJson('CFG - Workflow configuration', 'CFG - Workflow configuration1') || {};
const cfg = parse.config || cfgRow.config || cfgRow || {};

const jdTitle = String(cfg.requisition_title || expand.requisition_title || '').trim();
const jdReq = String(cfg.requisition_requirements || '').trim();
if (!jdTitle || !jdReq) {
  throw new Error(
    'JD missing in config — recruiter form (requisition_title + requisition_requirements) must run before session insert.'
  );
}

const nowIso = new Date().toISOString();
const candidate_email = String(
  httpOut.candidate_email ||
    parse.candidate_email ||
    expand.candidate_email ||
    inp.candidate_email ||
    ''
)
  .trim()
  .toLowerCase();

const qText = String(parse.phase_1_question || notes.phase_1_question || '').trim();
if (!qText) {
  throw new Error('Phase 1 question missing — cannot create assessment session without phase_1_question.');
}

const aiSeconds =
  parse.phase_1_time_limit_seconds ??
  notes.time_limit_seconds ??
  notes.timeLimitSeconds;

const time_limit_seconds = useAiTimeLimitSeconds(aiSeconds, cfg);
const deadline_at = buildDeadline(nowIso, time_limit_seconds);
const complexity_tier =
  parse.phase_1_complexity_tier || notes.complexity_tier || notes.complexityTier || null;

const cv = String(
  parse.cv_plaintext || parse.cv_text || expand.cv_text || expand.cv_plaintext || ''
).slice(0, 12000);

const fingerprint = String(
  httpOut.fingerprint || parse.fingerprint || expand.fingerprint || inp.fingerprint || ''
).trim();

const interviewerForSession = String(
  parse.config?.interviewer_email ||
    parse.interviewer_email ||
    expand.config?.interviewer_email ||
    expand.interviewer_email ||
    intake.interviewer_email ||
    cfg.interviewer_email ||
    ''
)
  .trim()
  .toLowerCase();

const requisition_id =
  String(
    parse.requisition_id ||
      expand.requisition_id ||
      httpOut.requisition_id ||
      inp.requisition_id ||
      ''
  ).trim() || slugFromTitle(jdTitle);

// Always null on insert — MAIL+PATCH sets the real Gmail thread on this new row only.
const gmail_thread_id = null;

const decidedRaw = Number(
  parse.written_question_count ??
    parse.max_questions ??
    cfg.written_question_count ??
    cfg.max_questions ??
    5
);
const qBounds = questionBoundsFromConfig(parse.config || cfg || {});
const writtenCount = resolveEffectiveWrittenMaxQuestions(
  {
    ...(parse.config || cfg || {}),
    written_question_count: decidedRaw,
    max_questions: decidedRaw,
  },
  { max_phases: decidedRaw }
);

const profile_photo_url = String(
  notes.profile_photo_url ||
    parse.profile_photo_url ||
    intake.profile_photo_url ||
    expand.profile_photo_url ||
    ''
).trim();

const candidate_name = String(
  notes.candidate_name ||
    parse.candidate_name ||
    intake.candidate_name ||
    ''
).trim();

const sessionBody = {
  gmail_thread_id,
  candidate_email,
  current_phase: 1,
  max_phases: writtenCount,
  status: 'assessment',
  screening: parse.screening || notes,
  score: httpOut.score ?? parse.score ?? null,
  requisition_id,
  fingerprint,
  cv_plaintext: cv,
  last_question_sent_at: nowIso,
  updated_at: nowIso,
  config: {
    requisition_id,
    requisition_title: jdTitle,
    requisition_requirements: jdReq,
    organization_name: cfg.organization_name,
    groq_model: cfg.groq_model,
    gemini_model: cfg.gemini_model,
    max_questions: writtenCount,
    written_question_count: writtenCount,
    written_questions_min: qBounds.min,
    written_questions_max: qBounds.max,
    interviewer_email: interviewerForSession,
    supabase_url: cfg.supabase_url,
    supabase_key: cfg.supabase_key,
    table_assessment_sessions: cfg.table_assessment_sessions,
    fail_score_threshold: cfg.fail_score_threshold ?? 30,
    pass_score_threshold: cfg.pass_score_threshold ?? 60,
    default_pass_score_thresholds: cfg.default_pass_score_thresholds || {
      junior: 55,
      mid: 60,
      senior: 70,
    },
    timer_min_seconds: cfg.timer_min_seconds ?? 60,
    timer_max_seconds: cfg.timer_max_seconds ?? 600,
    speech_timer_min_seconds: cfg.speech_timer_min_seconds ?? 30,
    speech_timer_max_seconds: cfg.speech_timer_max_seconds ?? 120,
    speech_answer_seconds: cfg.speech_answer_seconds ?? 75,
    speech_enabled:
      cfg.speech_enabled === true ||
      cfg.speech_enabled === 'true' ||
      Number(cfg.speech_phases ?? 5) > 0,
    speech_phases: Number(cfg.speech_phases ?? 5),
    technical_weight: Number(cfg.technical_weight ?? 0.7),
    speech_weight: Number(cfg.speech_weight ?? 0.3),
    ...(profile_photo_url ? { profile_photo_url } : {}),
    ...(candidate_name ? { candidate_name } : {}),
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
const tb = cfg.table_assessment_sessions || 'assessment_sessions';
const baseUrl = `${b}/rest/v1/${tb}`;

// Always INSERT a new row — one session per distinct application (email + job + CV).
// Never upsert on gmail_thread_id (that overwrote completed sessions for returning candidates).
const _sb_insert_sessions = baseUrl;
const _session_prefer = 'return=representation';

return [
  {
    json: {
      ...parse,
      ...expand,
      ...httpOut,
      config: cfg,
      candidate_email,
      fingerprint,
      gmail_thread_id,
      gmail_thread_is_pending: true,
      phase_1_question: qText,
      phase_1_time_limit_seconds: time_limit_seconds,
      requisition_id,
      _sb_insert_sessions,
      _session_prefer,
      _session_body: sessionBody,
      _now: nowIso,
      _q_text: qText,
    },
  },
];

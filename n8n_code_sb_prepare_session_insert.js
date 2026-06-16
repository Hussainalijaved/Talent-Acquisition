// n8n: CODE - SB prepare session insert
// Flow: GATE Shortlist → this node → HTTP upsert/insert → map session id → MAIL → PATCH thread
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

function isRealGmailThreadId(id) {
  const s = String(id || '').trim();
  return (
    s.length > 0 &&
    !/^pending$/i.test(s) &&
    !s.startsWith('pending-') &&
    !s.startsWith('draft-')
  );
}

function pickGmailThreadId(...candidates) {
  for (const id of candidates) {
    if (isRealGmailThreadId(id)) return String(id).trim();
  }
  return '';
}

const parse =
  pickNodeJson('CODE - Parse CV screening outcome', 'CODE - Parse CV screening outcome1') || {};
const inp = $input.first().json || {};
const httpOut =
  inp.candidate_email || inp.stage || inp.notes || inp.gmail_thread_id ? inp : {};

const notes =
  typeof httpOut?.notes === 'object' && httpOut.notes ? httpOut.notes : parse.screening || {};

const cfgRow =
  pickNodeJson('CFG - Workflow configuration', 'CFG - Workflow configuration1') || {};
const cfg = parse.config || cfgRow.config || cfgRow || {};

const jdTitle = String(cfg.requisition_title || '').trim();
const jdReq = String(cfg.requisition_requirements || '').trim();
if (!jdTitle || !jdReq) {
  throw new Error(
    'JD missing in config — recruiter form (requisition_title + requisition_requirements) must run before session insert.'
  );
}

const nowIso = new Date().toISOString();
const candidate_email = String(
  httpOut.candidate_email || parse.candidate_email || inp.candidate_email || ''
)
  .trim()
  .toLowerCase();

const qText = String(parse.phase_1_question || notes.phase_1_question || '').trim();

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
// null until MAIL+PATCH — avoids unique constraint collisions on placeholder values
const gmail_thread_id = realThread || null;

const requisition_id =
  String(parse.requisition_id || httpOut.requisition_id || inp.requisition_id || '').trim() ||
  jdTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

const sessionBody = {
  gmail_thread_id,
  candidate_email,
  current_phase: 1,
  max_phases: cfg.max_questions ?? 5,
  status: 'assessment',
  screening: parse.screening || notes,
  score: httpOut.score ?? parse.score ?? null,
  requisition_id,
  fingerprint: httpOut.fingerprint || parse.fingerprint || inp.fingerprint || '',
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
    interviewer_email: cfg.interviewer_email || parse.interviewer_email || '',
    supabase_url: cfg.supabase_url,
    supabase_key: cfg.supabase_key,
    table_assessment_sessions: cfg.table_assessment_sessions,
      fail_score_threshold: cfg.fail_score_threshold ?? 30,
      pass_score_threshold: cfg.pass_score_threshold ?? 60,
      timer_min_seconds: cfg.timer_min_seconds ?? 60,
      timer_max_seconds: cfg.timer_max_seconds ?? 600,
      speech_enabled:
        cfg.speech_enabled === true ||
        cfg.speech_enabled === 'true' ||
        Number(cfg.speech_phases ?? 5) > 0,
      speech_phases: Number(cfg.speech_phases ?? 5),
      technical_weight: Number(cfg.technical_weight ?? 0.7),
      speech_weight: Number(cfg.speech_weight ?? 0.3),
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

// Re-apply / same Gmail thread → update existing row instead of duplicate-key error
const _sb_insert_sessions = realThread
  ? `${baseUrl}?on_conflict=gmail_thread_id`
  : baseUrl;
const _session_prefer = realThread
  ? 'resolution=merge-duplicates,return=representation'
  : 'return=representation';

return [
  {
    json: {
      ...parse,
      ...httpOut,
      config: cfg,
      candidate_email,
      gmail_thread_id,
      gmail_thread_is_pending: !realThread,
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

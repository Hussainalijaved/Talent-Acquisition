// n8n: CODE - Normalize Data (technical + speech assessment)
// Paste into: CODE - Normalize Data (after CFG - Assessment Config)

const item = $input.first().json;
const body = item.body || {};
const query = item.query || {};

const cleanEmail = (raw) => {
  const first = String(raw || '').trim().toLowerCase().split(/\n/)[0].trim();
  return first.split(/\s+regards/i)[0].trim();
};

const session_id = String(
  body.sessionId || body.session_id || query.sessionId || query.session_id || ''
).trim();
const candidate_email = cleanEmail(
  body.email || body.candidate_email || query.email || query.candidate_email
);
const answer = String(body.answer || query.answer || '').trim();
const current_phase = parseInt(body.phase || body.current_phase || query.phase || '1', 10);
const tab_switches = parseInt(body.tabSwitches ?? body.tab_switches ?? '0', 10);
const assessment_mode = String(
  body.assessment_mode || body.mode || query.assessment_mode || 'text'
).trim().toLowerCase();

const speech_metrics =
  body.speech_metrics && typeof body.speech_metrics === 'object'
    ? body.speech_metrics
    : {};
const audio_url = String(body.audio_url || body.audioUrl || '').trim();

const nested = item.config || {};
const config = {
  supabase_url: nested.supabase_url || item.supabase_url || '',
  supabase_key: nested.supabase_key || item.supabase_key || '',
  gemini_model: nested.gemini_model || nested.groq_model || item.gemini_model || item.groq_model || '',
  groq_model: nested.groq_model || item.groq_model || '',
  max_questions: Number(nested.max_questions ?? item.max_questions ?? 5),
  speech_phases: Number(nested.speech_phases ?? item.speech_phases ?? 3),
  speech_enabled:
    nested.speech_enabled === true ||
    nested.speech_enabled === 'true' ||
    item.speech_enabled === true ||
    item.speech_enabled === 'true' ||
    Number(nested.speech_phases ?? item.speech_phases ?? 3) > 0,
  technical_weight: Number(nested.technical_weight ?? item.technical_weight ?? 0.7),
  speech_weight: Number(nested.speech_weight ?? item.speech_weight ?? 0.3),
  interviewer_email: nested.interviewer_email || item.interviewer_email || '',
  organization_name: nested.organization_name || item.organization_name || '',
  requisition_title: nested.requisition_title || '',
  requisition_requirements: nested.requisition_requirements || '',
  fail_score_threshold: Number(nested.fail_score_threshold ?? item.fail_score_threshold ?? 30),
  pass_score_threshold: Number(nested.pass_score_threshold ?? item.pass_score_threshold ?? 60),
  timer_min_seconds: Number(nested.timer_min_seconds ?? item.timer_min_seconds ?? 60),
  timer_max_seconds: Number(nested.timer_max_seconds ?? item.timer_max_seconds ?? 600),
  table_assessment_sessions: nested.table_assessment_sessions || 'assessment_sessions',
};

return [
  {
    json: {
      session_id,
      candidate_email,
      answer,
      current_phase,
      tab_switches,
      assessment_mode,
      speech_metrics,
      audio_url,
      config,
    },
  },
];

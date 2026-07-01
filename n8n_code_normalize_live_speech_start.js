// n8n: CODE - Normalize Live Speech Start
// After: TRG - Live Speech Start → CFG - Live Speech Config

function safeEnv(name) {
  try {
    return String($env[name] || '').trim();
  } catch (_) {
    return '';
  }
}

const item = $input.first().json;
const body = item.body || item || {};
const cfg = {
  ...(typeof item.config === 'object' && item.config ? item.config : {}),
  ...item,
};

const cleanEmail = (raw) => {
  const first = String(raw || '').trim().toLowerCase().split(/\n/)[0].trim();
  return first.split(/\s+regards/i)[0].trim();
};

const session_id = String(
  body.session_id || body.sessionId || body.session_db_id || ''
).trim();
const candidate_email = cleanEmail(body.email || body.candidate_email);

if (!session_id) throw new Error('live-speech-start: session_id required');
if (!candidate_email) throw new Error('live-speech-start: email required');

return [
  {
    json: {
      flow: 'live_speech_start',
      session_id,
      candidate_email,
      assessment_mode: 'live_speech',
      config: {
        supabase_url: String(
          cfg.supabase_url || safeEnv('SUPABASE_URL') || ''
        ).trim(),
        supabase_key: String(
          cfg.supabase_key ||
            safeEnv('SUPABASE_SERVICE_ROLE_KEY') ||
            safeEnv('SUPABASE_KEY') ||
            ''
        ).trim(),
        max_questions: Number(cfg.max_questions ?? 5),
        speech_phases: Number(cfg.live_speech_turns ?? cfg.speech_phases ?? 5),
        speech_timer_min_seconds: Number(cfg.speech_timer_min_seconds ?? 30),
        speech_timer_max_seconds: Number(cfg.speech_timer_max_seconds ?? 120),
        speech_answer_seconds: Number(cfg.speech_answer_seconds ?? 75),
        technical_weight: Number(cfg.technical_weight ?? 0.7),
        speech_weight: Number(cfg.speech_weight ?? 0.3),
        pass_score_threshold: Number(cfg.pass_score_threshold ?? 60),
        fail_score_threshold: Number(cfg.fail_score_threshold ?? 30),
        organization_name: String(cfg.organization_name || 'CONVO'),
        portal_base_url: String(cfg.portal_base_url || 'https://talent-acquisition-six.vercel.app'),
        n8n_public_url: String(cfg.n8n_public_url || '').replace(/\/+$/, ''),
        live_relay_url: String(cfg.live_relay_url || ''),
        live_complete_webhook: String(
          cfg.live_complete_webhook ||
            (cfg.n8n_public_url
              ? `${String(cfg.n8n_public_url).replace(/\/+$/, '')}/webhook/talent/live-speech-complete`
              : '')
        ),
        gemini_live_model: String(
          cfg.gemini_live_model || 'gemini-2.5-flash-native-audio-preview-12-2025'
        ),
        table_assessment_sessions: String(cfg.table_assessment_sessions || 'assessment_sessions'),
      },
    },
  },
];

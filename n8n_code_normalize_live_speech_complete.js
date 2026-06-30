// n8n: CODE - Normalize Live Speech Complete
// After: TRG - Live Speech Complete → CFG - Live Speech Config

const item = $input.first().json;
const body = item.body || item || {};
const cfg = item.config || item;

const cleanEmail = (raw) => {
  const first = String(raw || '').trim().toLowerCase().split(/\n/)[0].trim();
  return first.split(/\s+regards/i)[0].trim();
};

const session_id = String(
  body.session_id || body.sessionId || body.session_db_id || ''
).trim();
const candidate_email = cleanEmail(body.email || body.candidate_email);
const turns = Array.isArray(body.turns) ? body.turns : [];
const partial = body.partial === true;

if (!session_id) throw new Error('live-speech-complete: session_id required');
if (!candidate_email) throw new Error('live-speech-complete: email required');
if (!turns.length) throw new Error('live-speech-complete: turns[] required');

return [
  {
    json: {
      flow: partial ? 'live_speech_turn' : 'live_speech_complete',
      partial,
      session_id,
      candidate_email,
      assessment_mode: 'live_speech',
      turns,
      combined_speech_score:
        body.combined_speech_score != null ? Number(body.combined_speech_score) : null,
      session_audio_url: String(body.session_audio_url || body.audio_url || '').trim(),
      duration_seconds: Number(body.duration_seconds || 0),
      final_feedback: String(body.final_feedback || body.feedback || '').trim(),
      live_session_summary: String(body.live_session_summary || '').trim(),
      tab_switches: Number(body.tab_switches ?? body.tabSwitches ?? 0),
      result: String(body.result || '').trim().toUpperCase() || null,
      score: body.score != null ? Number(body.score) : null,
      technical_score: body.technical_score != null ? Number(body.technical_score) : null,
      speech_score: body.speech_score != null ? Number(body.speech_score) : null,
      config: {
        supabase_url: String(cfg.supabase_url || '').trim(),
        supabase_key: String(cfg.supabase_key || '').trim(),
        max_questions: Number(cfg.max_questions ?? 5),
        speech_phases: Number(cfg.live_speech_turns ?? cfg.speech_phases ?? 5),
        technical_weight: Number(cfg.technical_weight ?? 0.7),
        speech_weight: Number(cfg.speech_weight ?? 0.3),
        pass_score_threshold: Number(cfg.pass_score_threshold ?? 60),
        fail_score_threshold: Number(cfg.fail_score_threshold ?? 30),
        organization_name: String(cfg.organization_name || 'CONVO'),
        portal_base_url: String(cfg.portal_base_url || 'https://talent-acquisition-six.vercel.app'),
        interviewer_email: String(cfg.interviewer_email || ''),
        table_assessment_sessions: String(cfg.table_assessment_sessions || 'assessment_sessions'),
      },
    },
  },
];

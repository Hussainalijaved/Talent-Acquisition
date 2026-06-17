// n8n: CODE - Parse Live Speech Result
// After: HTTP - Fetch Session (complete branch)
// Merges relay turns into interview_history; finalizes combined score.

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function computeTechnicalAverage(rows, maxQ) {
  const scores = rows
    .filter((row) => {
      const phase = Number(row.phase);
      return phase >= 1 && phase <= maxQ && row.score != null;
    })
    .map((row) => Number(row.score))
    .filter((n) => Number.isFinite(n));
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function computeSpeechAverage(rows, maxQ, speechPhases) {
  const scores = rows
    .filter((row) => {
      const phase = Number(row.phase);
      return phase > maxQ && phase <= maxQ + speechPhases && row.score != null;
    })
    .map((row) => Number(row.score))
    .filter((n) => Number.isFinite(n));
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

const norm = $('CODE - Normalize Live Speech Complete').first().json;
const cfg = norm.config || {};
const fetchRaw = $input.first().json;
const session = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;
if (!session?.id) throw new Error('Session not found for live speech complete');

const sessCfg = { ...parseJson(session.config, {}), ...cfg };
const maxQ = Number(sessCfg.max_questions || cfg.max_questions || 5);
const speechPhases = Number(cfg.speech_phases || sessCfg.speech_phases || 5);
const passThreshold = Number(cfg.pass_score_threshold ?? 60);
const techWeight = Number(cfg.technical_weight ?? 0.7);
const speechWeight = Number(cfg.speech_weight ?? 0.3);
const iso = new Date().toISOString();

let history = session.interview_history;
history = parseJson(history, []);
if (!Array.isArray(history)) history = [];

const turns = Array.isArray(norm.turns) ? norm.turns : [];
for (const turn of turns) {
  const ph = Number(turn.phase);
  if (!Number.isFinite(ph) || ph <= maxQ) continue;

  const patch = {
    phase: ph,
    mode: 'live_speech',
    question_text: String(turn.question_text || turn.question || '').trim(),
    answer_text: String(turn.answer_text || turn.transcript || turn.answer || '').trim(),
    received_at: turn.received_at || iso,
    sent_at: turn.sent_at || iso,
    feedback: turn.feedback || null,
    score: Math.max(0, Math.min(100, Math.round(Number(turn.score ?? 0)))),
    soft_skills: turn.soft_skills || {
      clarity: Math.round(Number(turn.clarity ?? turn.score ?? 0)),
      confidence: Math.round(Number(turn.confidence ?? turn.score ?? 0)),
      professionalism: Math.round(Number(turn.professionalism ?? turn.score ?? 0)),
      relevance: Math.round(Number(turn.relevance ?? turn.score ?? 0)),
    },
    speech_metrics: turn.speech_metrics || {},
    answer_audio_url: turn.audio_url || norm.session_audio_url || null,
    stt_source: turn.stt_source || 'gemini_live',
    scoring_source: turn.scoring_source || 'gemini_live',
  };

  const idx = history.findIndex((x) => Number(x.phase) === ph);
  if (idx >= 0) history[idx] = { ...history[idx], ...patch };
  else history.push(patch);
}

const techAvg =
  Number(session.technical_score) || computeTechnicalAverage(history, maxQ) || 0;
let speechAvg =
  norm.combined_speech_score != null && Number.isFinite(Number(norm.combined_speech_score))
    ? Math.round(Number(norm.combined_speech_score))
    : computeSpeechAverage(history, maxQ, speechPhases);

if (speechAvg == null) {
  const turnScores = turns
    .map((t) => Number(t.score))
    .filter((n) => Number.isFinite(n));
  speechAvg = turnScores.length
    ? Math.round(turnScores.reduce((a, b) => a + b, 0) / turnScores.length)
    : 0;
}

const combinedScore = Math.round(techAvg * techWeight + speechAvg * speechWeight);
const finalResult = combinedScore >= passThreshold ? 'PASS' : 'FAIL';
const lastPhase = maxQ + speechPhases;

const finalFeedback = [
  norm.final_feedback || norm.live_session_summary || '',
  `Technical: ${techAvg}/100 | Live communication: ${speechAvg}/100 | Combined: ${combinedScore}/100 (pass ${passThreshold}).`,
]
  .filter(Boolean)
  .join(' ');

const body = {
  interview_history: history,
  updated_at: iso,
  assessment_stage: 'completed',
  current_phase: lastPhase,
  status: 'completed',
  technical_score: techAvg,
  speech_score: speechAvg,
  score: combinedScore,
  result: finalResult,
  live_speech_audio_url: norm.session_audio_url || null,
  live_speech_duration_seconds: norm.duration_seconds || null,
  tab_switches: norm.tab_switches || 0,
};

const b = String(cfg.supabase_url || sessCfg.supabase_url || '').replace(/\/+$/, '');
const patchUrl = `${b}/rest/v1/${cfg.table_assessment_sessions || 'assessment_sessions'}?id=eq.${encodeURIComponent(String(session.id))}`;

const lastTurn = turns[turns.length - 1] || {};
const phaseScore = Math.round(Number(lastTurn.score ?? speechAvg));

return [
  {
    json: {
      score: combinedScore,
      phase_score: phaseScore,
      soft_skills: lastTurn.soft_skills || null,
      feedback: finalFeedback,
      nextQuestion: '',
      time_limit_seconds: null,
      deadline_at: null,
      complexity_tier: null,
      isFinal: true,
      assessment_mode: 'live_speech',
      speech_phases: speechPhases,
      result: finalResult,
      average_score: combinedScore,
      candidate_email: norm.candidate_email || session.candidate_email,
      session_id: session.id,
      current_phase: lastPhase,
      config: sessCfg,
      gmail_thread_id: session.gmail_thread_id || null,
      gmail_message_id: session.gmail_message_id || null,
      mail_subject: session.mail_subject || null,
      _session_patch_url: patchUrl,
      _session_patch_body: body,
    },
  },
];

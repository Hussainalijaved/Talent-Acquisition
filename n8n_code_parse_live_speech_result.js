// n8n: CODE - Parse Live Speech Result
// WORKFLOW: Talent Acquisition — Live Speech ONLY
// NODE: CODE - Parse Live Speech Result (after HTTP - Fetch Session Complete)
// DO NOT paste into Assessment workflow "CODE - Build LLM context" — use n8n_code_build_llm_context.js there.

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function pickNodeJson(name) {
  try {
    const raw = $(name).first().json;
    if (raw && typeof raw === 'object') return raw;
  } catch (_) {}
  return null;
}

function cleanEmail(raw) {
  const first = String(raw || '').trim().toLowerCase().split(/\n/)[0].trim();
  return first.split(/\s+regards/i)[0].trim();
}

function buildConfig(cfg) {
  const c = cfg || {};
  return {
    supabase_url: String(c.supabase_url || '').trim(),
    supabase_key: String(c.supabase_key || '').trim(),
    max_questions: Number(c.max_questions ?? 5),
    speech_phases: Number(c.live_speech_turns ?? c.speech_phases ?? 5),
    technical_weight: Number(c.technical_weight ?? 0.7),
    speech_weight: Number(c.speech_weight ?? 0.3),
    pass_score_threshold: Number(c.pass_score_threshold ?? 60),
    fail_score_threshold: Number(c.fail_score_threshold ?? 30),
    organization_name: String(c.organization_name || 'CONVO'),
    portal_base_url: String(c.portal_base_url || 'https://talent-acquisition-six.vercel.app'),
    interviewer_email: String(c.interviewer_email || ''),
    table_assessment_sessions: String(c.table_assessment_sessions || 'assessment_sessions'),
  };
}

function resolveLiveSpeechNorm() {
  const normalized = pickNodeJson('CODE - Normalize Live Speech Complete');
  if (normalized?.session_id && Array.isArray(normalized.turns) && normalized.turns.length) {
    return normalized;
  }

  const triggerRaw = pickNodeJson('TRG - Live Speech Complete');
  const cfgNode = pickNodeJson('CFG - Live Speech Config (complete)');
  const body = triggerRaw?.body || triggerRaw || {};
  const cfg = buildConfig(normalized?.config || cfgNode?.config || cfgNode);

  const session_id = String(
    body.session_id || body.sessionId || body.session_db_id || normalized?.session_id || ''
  ).trim();
  const candidate_email = cleanEmail(
    body.email || body.candidate_email || normalized?.candidate_email
  );
  const turns = Array.isArray(body.turns)
    ? body.turns
    : Array.isArray(normalized?.turns)
      ? normalized.turns
      : [];

  if (!session_id) {
    throw new Error(
      'live-speech-complete: session_id required — run from TRG - Live Speech Complete (not assessment-answer webhook).'
    );
  }
  if (!candidate_email) throw new Error('live-speech-complete: email required');
  if (!turns.length) {
    throw new Error(
      'live-speech-complete: turns[] required — relay must POST scored Q&A pairs to this webhook.'
    );
  }

  return {
    flow: normalized?.partial ? 'live_speech_turn' : 'live_speech_complete',
    partial: normalized?.partial === true || body.partial === true,
    session_id,
    candidate_email,
    assessment_mode: 'live_speech',
    turns,
    combined_speech_score:
      body.combined_speech_score != null
        ? Number(body.combined_speech_score)
        : normalized?.combined_speech_score ?? null,
    session_audio_url: String(
      body.session_audio_url || body.audio_url || normalized?.session_audio_url || ''
    ).trim(),
    duration_seconds: Number(body.duration_seconds || normalized?.duration_seconds || 0),
    final_feedback: String(
      body.final_feedback || body.feedback || normalized?.final_feedback || ''
    ).trim(),
    live_session_summary: String(
      body.live_session_summary || normalized?.live_session_summary || ''
    ).trim(),
    tab_switches: Number(body.tab_switches ?? body.tabSwitches ?? normalized?.tab_switches ?? 0),
    config: cfg,
  };
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

const norm = resolveLiveSpeechNorm();
const cfg = norm.config || {};
const fetchRaw = $input.first().json;
const session = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;
if (!session?.id) throw new Error('Session not found for live speech complete');

const sessionCfg = parseJson(session.config, {});
const sessCfg = { ...sessionCfg, ...cfg };
// JD intake stores interviewer on session.config — do not let blank n8n CFG wipe it.
const sessionInterviewer = String(sessionCfg.interviewer_email || '').trim();
if (sessionInterviewer) sessCfg.interviewer_email = sessionInterviewer;
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

  const idx = history.findIndex((x) => Number(x.phase) === ph);
  const existing = idx >= 0 ? history[idx] : {};

  const incomingQ = String(turn.question_text || turn.question || '').trim();
  const incomingA = String(turn.answer_text || turn.transcript || turn.answer || '').trim();
  const hasNewScore = turn.score != null && Number.isFinite(Number(turn.score));
  const score = hasNewScore
    ? Math.max(0, Math.min(100, Math.round(Number(turn.score))))
    : (existing.score ?? null);

  const patch = {
    phase: ph,
    mode: 'live_speech',
    voice_question_number:
      Number(turn.voice_question_number || ph - maxQ) || existing.voice_question_number || null,
    question_text: incomingQ || String(existing.question_text || existing.question || '').trim(),
    answer_text: incomingA || String(existing.answer_text || '').trim(),
    received_at: turn.received_at || existing.received_at || iso,
    sent_at: turn.sent_at || existing.sent_at || iso,
    feedback: turn.feedback || existing.feedback || null,
    score,
    soft_skills: turn.soft_skills || (hasNewScore
      ? {
          clarity: Math.round(Number(turn.clarity ?? turn.score ?? 0)),
          confidence: Math.round(Number(turn.confidence ?? turn.score ?? 0)),
          professionalism: Math.round(Number(turn.professionalism ?? turn.score ?? 0)),
          relevance: Math.round(Number(turn.relevance ?? turn.score ?? 0)),
        }
      : (existing.soft_skills ?? null)),
    speech_metrics: turn.speech_metrics || existing.speech_metrics || {},
    answer_audio_url: turn.audio_url || norm.session_audio_url || existing.answer_audio_url || null,
    stt_source: turn.stt_source || 'gemini_live',
    scoring_source: turn.scoring_source || 'gemini_live',
  };

  if (idx >= 0) history[idx] = { ...existing, ...patch };
  else history.push(patch);
}

const b = String(cfg.supabase_url || sessCfg.supabase_url || '').replace(/\/+$/, '');
if (!b || !/^https?:\/\//i.test(b)) {
  throw new Error(
    'live-speech save: supabase_url missing/invalid. Set supabase_url in CFG - Live Speech Config (complete) (e.g. https://xxx.supabase.co) so voice turns persist.'
  );
}
const patchUrl = `${b}/rest/v1/${cfg.table_assessment_sessions || 'assessment_sessions'}?id=eq.${encodeURIComponent(String(session.id))}`;

// Incremental save after each voice Q&A — do not finalize the session yet.
if (norm.partial === true) {
  const lastTurn = turns[turns.length - 1] || {};
  const currentPhase = Number(lastTurn.phase || maxQ + 1);
  const partialBody = {
    interview_history: history,
    updated_at: iso,
    assessment_stage: 'live_speech',
    current_phase: currentPhase,
    status: 'assessment',
  };

  return [
    {
      json: {
        partial: true,
        ok: true,
        isFinal: false,
        session_id: session.id,
        candidate_email: norm.candidate_email || session.candidate_email,
        phase: currentPhase,
        turns_saved: turns.length,
        assessment_mode: 'live_speech',
        config: sessCfg,
        _session_patch_url: patchUrl,
        _session_patch_body: partialBody,
      },
    },
  ];
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

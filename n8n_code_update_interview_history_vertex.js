// n8n: CODE - Update interview_history (after Basic LLM Chain + Vertex/Gemini)
// Purana code DELETE karke poora yeh paste karo — sirf ek return, end par.

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
  if (!Number.isFinite(sec) || sec <= 0) sec = 240;
  return Math.min(max, Math.max(min, Math.round(sec)));
}

function buildDeadline(isoStart, seconds) {
  const start = isoStart ? new Date(isoStart) : new Date();
  return new Date(start.getTime() + seconds * 1000).toISOString();
}

function extractLlmText(api) {
  if (!api || typeof api !== 'object') return '';
  if (typeof api.text === 'string' && api.text.trim()) return api.text.trim();
  if (typeof api.output === 'string' && api.output.trim()) return api.output.trim();
  if (typeof api.response === 'string' && api.response.trim()) return api.response.trim();
  const c0 = api.choices?.[0];
  if (c0?.message?.content) return String(c0.message.content).trim();
  if (typeof c0?.text === 'string') return c0.text.trim();
  const parts = api.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts[0]?.text) return String(parts[0].text).trim();
  return '';
}

function parseLlmContent(api) {
  if (
    api &&
    (api.score != null ||
      api.feedback ||
      api.next_question ||
      api.nextQuestion ||
      api.result ||
      api.status === 'finished')
  ) {
    return api;
  }
  const rawText = extractLlmText(api);
  if (!rawText) {
    return {
      status: 'in_progress',
      score: 0,
      feedback: 'Empty model output.',
      next_question: '',
      nextQuestion: '',
    };
  }
  try {
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return {
      status: 'in_progress',
      score: 0,
      feedback: 'Could not parse model output.',
      next_question: '',
      nextQuestion: '',
    };
  }
}

const llm = $input.first().json;
const built = $('CODE - Build LLM context').first().json;
const session = built.session;
const current = built.norm;
const cfg = current.config || {};
const content = parseLlmContent(llm);

let history = session.interview_history;
if (typeof history === 'string') {
  try {
    history = JSON.parse(history);
  } catch (err) {
    history = [];
  }
}
if (!Array.isArray(history)) history = [];

const ph = Number(current.current_phase || 1);
const maxQ = Number(cfg.max_questions || 5);
const failThreshold = Number(cfg.fail_score_threshold ?? 30);
const passThreshold = Number(cfg.pass_score_threshold ?? 60);
const iso = new Date().toISOString();

let idx = history.findIndex((x) => Number(x.phase) === ph);
const patch = {
  answer_text: current.answer,
  received_at: iso,
  feedback: content.feedback || null,
  suggested_answer: content.suggested_answer || content.suggestedAnswer || null,
  score: content.score ?? null,
};
if (idx >= 0) history[idx] = { ...history[idx], ...patch };
else history.push({ phase: ph, question_text: '', sent_at: iso, ...patch });

const getPhaseScore = (phase) => {
  const row = history.find((x) => Number(x.phase) === phase);
  if (!row || row.answer_text == null || row.score == null) return null;
  const n = Number(row.score);
  return Number.isFinite(n) ? n : null;
};

function computeAverageScore(rows, maxPhases) {
  const scores = rows
    .filter((row) => {
      const phase = Number(row.phase);
      if (!Number.isFinite(phase) || phase < 1 || phase > maxPhases) return false;
      if (row.answer_text == null || row.score == null) return false;
      const n = Number(row.score);
      return Number.isFinite(n);
    })
    .map((row) => Number(row.score));
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

let earlyTerminate = false;
let earlyTerminateReason = '';
// Sirf Phase 3 grade hone ke baad (Phase 4 se pehle) — Phase 4 par dubara check mat karo
if (ph === 3) {
  const s1 = getPhaseScore(1);
  const s2 = getPhaseScore(2);
  const s3 = getPhaseScore(3);
  if (
    s1 != null &&
    s2 != null &&
    s3 != null &&
    s1 < failThreshold &&
    s2 < failThreshold &&
    s3 < failThreshold
  ) {
    earlyTerminate = true;
    earlyTerminateReason = `Assessment terminated after Phase 3: scores below ${failThreshold} (P1:${s1}, P2:${s2}, P3:${s3}).`;
  }
}

let nextQ = String(content.nextQuestion || content.next_question || '').trim();
let timeLimitSeconds = null;
let complexityTier = null;

const isActualFinalPhase = ph >= maxQ;

// Phase 1–4: Gemini kabhi jaldi FAIL/finished bhej deta hai — ignore karo
if (!isActualFinalPhase && !earlyTerminate) {
  if (content.status === 'finished') content.status = 'in_progress';
  if (content.result) content.result = '';
}

let isFinal = isActualFinalPhase || earlyTerminate;
if (isActualFinalPhase && !earlyTerminate) {
  if (content.status === 'finished' || content.result) isFinal = true;
}

if (earlyTerminate) {
  nextQ = '';
  content.result = 'FAIL';
  content.feedback = [content.feedback || '', earlyTerminateReason].filter(Boolean).join(' ');
}

if (nextQ && ph < maxQ && !earlyTerminate) {
  timeLimitSeconds = useAiTimeLimitSeconds(content.time_limit_seconds, cfg);
  complexityTier = content.complexity_tier || content.complexityTier || null;
}

if (nextQ && !isFinal) {
  const sentAt = iso;
  history.push({
    phase: ph + 1,
    question_text: nextQ,
    answer_text: null,
    sent_at: sentAt,
    received_at: null,
    score: null,
    suggested_answer: null,
    feedback: null,
    time_limit_seconds: timeLimitSeconds,
    complexity_tier: complexityTier,
    deadline_at: timeLimitSeconds ? buildDeadline(sentAt, timeLimitSeconds) : null,
  });
}

// Phase 4 ke baad Q5 missing — assessment mat band karo
if (ph === maxQ - 1 && !nextQ && !earlyTerminate) {
  isFinal = false;
}

const body = { interview_history: history, updated_at: iso };
if (nextQ && !isFinal) body.current_phase = ph + 1;
else if (!isFinal) body.current_phase = ph;
else body.current_phase = ph;

const phaseScore = Number(content.score ?? 0);
const averageScore = computeAverageScore(history, maxQ);

let finalResult = null;
let finalFeedback = content.feedback || '';
if (isFinal) {
  body.status = 'completed';
  const finalScore = averageScore ?? (Number.isFinite(phaseScore) ? phaseScore : 0);
  body.score = finalScore;

  if (earlyTerminate) {
    body.result = 'FAIL';
    finalResult = 'FAIL';
  } else {
    body.result = finalScore >= passThreshold ? 'PASS' : 'FAIL';
    finalResult = body.result;
  }

  if (averageScore != null) {
    const phaseSummary = history
      .filter((row) => row.answer_text != null && row.score != null)
      .map((row) => `P${row.phase}:${row.score}`)
      .join(', ');
    finalFeedback = [
      finalFeedback,
      `Average score across all phases: ${averageScore}/100 (${phaseSummary}). Pass mark: ${passThreshold}.`,
    ]
      .filter(Boolean)
      .join(' ');
  }
}

const b = String(cfg.supabase_url || '').replace(/\/+$/, '');
const patchUrl = `${b}/rest/v1/assessment_sessions?id=eq.${encodeURIComponent(String(session.id))}`;
const nextRow = history.find((x) => Number(x.phase) === ph + 1);

return [
  {
    json: {
      score: isFinal ? (body.score ?? averageScore ?? phaseScore) : phaseScore,
      phase_score: phaseScore,
      average_score: isFinal ? (body.score ?? averageScore) : null,
      feedback: isFinal ? finalFeedback : (content.feedback || ''),
      nextQuestion: nextQ,
      suggested_answer: content.suggested_answer || content.suggestedAnswer || '',
      time_limit_seconds: nextRow?.time_limit_seconds ?? timeLimitSeconds,
      deadline_at: nextRow?.deadline_at ?? null,
      complexity_tier: nextRow?.complexity_tier ?? complexityTier,
      isFinal,
      result: isFinal ? finalResult : null,
      terminatedEarly: earlyTerminate,
      candidate_email: current.candidate_email,
      session_id: current.session_id,
      current_phase: ph,
      config: cfg,
      _session_patch_url: patchUrl,
      _session_patch_body: body,
    },
  },
];

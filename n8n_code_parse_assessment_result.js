// n8n: CODE - Parse Result (assessment scoring)
// Paste into: CODE - Parse Result (after Groq/Gemini/Basic LLM Chain)
// Replaces: CODE - Update interview_history if that is your node name

function timerBounds(config) {
  const min = Number(config?.timer_min_seconds);
  const max = Number(config?.timer_max_seconds);
  return {
    min: Number.isFinite(min) && min > 0 ? min : 60,
    max: Number.isFinite(max) && max > 0 ? max : 600,
  };
}

function clampSeconds(sec, config) {
  const { min, max } = timerBounds(config);
  return Math.min(max, Math.max(min, Math.round(sec)));
}

// Seconds band per complexity tier
function tierTimeRange(tier) {
  switch (String(tier || '').toUpperCase()) {
    case 'A':
      return [60, 120];
    case 'B':
      return [150, 240];
    case 'C':
      return [270, 390];
    case 'D':
      return [420, 600];
    default:
      return null;
  }
}

// Infer a tier when the model omits or returns a junk tier
function inferTierFromQuestion(questionText) {
  const q = String(questionText || '');
  const words = q.trim().split(/\s+/).filter(Boolean).length;
  const subParts =
    (q.match(/\?/g) || []).length +
    (q.match(/\b(and|also|furthermore|additionally|then|as well as)\b/gi) || []).length;
  const heavy =
    /\b(architecture|design|schema|scalable|scalability|concurrency|distributed|trade-?off|optimi[sz]e|throughput|migration|pipeline|multi-?tenant|security|performance|caching|indexing)\b/i.test(
      q
    );

  if (words <= 28 && subParts <= 1 && !heavy) return 'A';
  if (words >= 80 || (heavy && subParts >= 3)) return 'D';
  if (words >= 50 || heavy) return 'C';
  return 'B';
}

// Deterministic per-question time: tier sets the band, question length positions
// within it, the model's value (if sane) is blended in. Different questions →
// different times, longer/harder questions → more seconds.
function deriveTimeLimitSeconds(rawLlmTime, tier, questionText, config, phase) {
  const usableTier =
    tierTimeRange(tier) ? tier : inferTierFromQuestion(questionText);
  const [lo, hi] = tierTimeRange(usableTier) || [150, 240];

  const words = String(questionText || '').trim().split(/\s+/).filter(Boolean).length;
  const span = Math.max(1, 90 - 20);
  const t = Math.max(0, Math.min(1, (words - 20) / span));
  let computed = lo + t * (hi - lo);

  const llm = Number(rawLlmTime);
  if (Number.isFinite(llm) && llm >= lo && llm <= hi) {
    computed = (llm + computed) / 2;
  }

  let sec = Math.round(computed / 15) * 15;
  sec = Math.max(lo, Math.min(hi, sec));
  return { seconds: clampSeconds(sec, config), tier: usableTier };
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

function isIntegrityTermination(answerText) {
  return /^\[system\s+termination/i.test(String(answerText || '').trim());
}

function isScorablePhaseRow(row) {
  if (!row || row.answer_text == null || row.score == null) return false;
  if (row.integrity_terminated || isIntegrityTermination(row.answer_text)) return false;
  const n = Number(row.score);
  return Number.isFinite(n);
}

function buildPhaseSummary(rows) {
  return rows
    .filter((row) => row.answer_text != null)
    .map((row) => {
      if (row.integrity_terminated || isIntegrityTermination(row.answer_text)) {
        return `P${row.phase}:integrity-fail`;
      }
      if (row.score != null) return `P${row.phase}:${row.score}`;
      return null;
    })
    .filter(Boolean)
    .join(', ');
}

/** Clamp LLM scores — garbage/generic answers must not get 10–25 "free" points */
function normalizePhaseScore(answerText, llmScore) {
  const answer = String(answerText || '').trim();
  let score = Number(llmScore);
  if (!Number.isFinite(score)) score = 0;

  if (!answer) return 0;
  if (isIntegrityTermination(answer)) return null;
  if (/^\[timeout/i.test(answer)) return 0;

  const lower = answer.toLowerCase().replace(/\s+/g, ' ').trim();
  const compact = answer.replace(/\s+/g, '');
  const len = compact.length;

  // Keyboard mash: mmmm, qqqqq, ooooo (same char repeated)
  if (len >= 4) {
    const chars = compact.toLowerCase().split('');
    const freq = {};
    for (const c of chars) freq[c] = (freq[c] || 0) + 1;
    const top = Math.max(...Object.values(freq));
    if (Object.keys(freq).length === 1 || top / chars.length >= 0.8) return 0;
  }

  // Trivial non-answers
  if (/^(ok|okay|yes|no|n\/a|na|idk|dunno|sure|fine|\.+|-+)$/i.test(lower)) {
    return Math.min(score, 3);
  }
  if (/^(ok\s+ok|yes\s+yes|no\s+no)$/i.test(lower)) {
    return Math.min(score, 3);
  }

  const techMarkers =
    /\b(api|sql|database|entity|framework|asp\.net|\.net|core|jwt|controller|service|schema|ef\s*core|linq|rest|dto|validation|fluentvalidation|dependency|injection|tenant|auth|middleware|repository|campaign|promotion|bcrypt|rbac|sso|endpoint|migration|index|query|table|class|interface|async|await)\b/i;

  const wordCount = lower.split(/\s+/).filter(Boolean).length;

  // One-liner generic with no technical terms (e.g. phase 1 "yes, system handles products...")
  if (wordCount <= 25 && !techMarkers.test(answer)) {
    return Math.min(score, 15);
  }

  // Very short, no technical signal
  if (len < 30 && !techMarkers.test(answer)) {
    return Math.min(score, 8);
  }

  // Short answer without technical depth — cap generous LLM scores
  if (len < 120 && !techMarkers.test(answer)) {
    return Math.min(score, 18);
  }

  if (len < 200 && score > 40 && !techMarkers.test(answer)) {
    return Math.min(score, 25);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

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

function pickBuildContext() {
  const built =
    pickNodeJson('CODE - Build LLM context', 'CODE - Build LLM context1') || {};

  if (built.session?.id && built.norm) return built;

  const norm =
    pickNodeJson('CODE - Normalize Data', 'CODE - Normalize Data1') || {};
  const fetchRaw = pickNodeJson('HTTP - Fetch Session', 'HTTP - Fetch Session1');
  const session = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;

  if (session?.id) {
    let history = session.interview_history;
    if (typeof history === 'string') {
      try {
        history = JSON.parse(history);
      } catch (_) {
        history = [];
      }
    }
    return {
      session: { ...session, interview_history: history },
      norm,
    };
  }

  throw new Error(
    'Session context missing. Wire CODE - Build LLM context before Parse Result, or rename node to match (no stray "1" suffix).'
  );
}

function parseSessionConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function resolveWorkflowConfig(current, session, built) {
  const cfgNode =
    pickNodeJson('CFG - Assessment Config', 'CFG - Assessment Config1') || {};
  const normCfg = current?.config || {};
  const sessionCfg = parseSessionConfig(session?.config);
  const builtCfg = built?.norm?.config || {};

  const supabase_url =
    normCfg.supabase_url ||
    sessionCfg.supabase_url ||
    builtCfg.supabase_url ||
    cfgNode.supabase_url ||
    cfgNode.config?.supabase_url ||
    '';

  const supabase_key =
    normCfg.supabase_key ||
    sessionCfg.supabase_key ||
    builtCfg.supabase_key ||
    cfgNode.supabase_key ||
    cfgNode.config?.supabase_key ||
    '';

  return {
    ...cfgNode,
    ...builtCfg,
    ...sessionCfg,
    ...normCfg,
    supabase_url,
    supabase_key,
  };
}

const llm = $input.first().json;
const built = pickBuildContext();
const session = built.session;
const current = built.norm;
const cfg = resolveWorkflowConfig(current, session, built);
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

const integrityTerminated = isIntegrityTermination(current.answer);
const rawLlmScore = Number(content.score ?? 0);
let normalizedScore = null;
let scoreAdjusted = false;

if (integrityTerminated) {
  normalizedScore = null;
} else {
  normalizedScore = normalizePhaseScore(current.answer, rawLlmScore);
  scoreAdjusted = normalizedScore !== Math.round(rawLlmScore);
}

let idx = history.findIndex((x) => Number(x.phase) === ph);
const patch = {
  answer_text: current.answer,
  received_at: iso,
  feedback: content.feedback || null,
  suggested_answer: content.suggested_answer || content.suggestedAnswer || null,
  score: normalizedScore,
  integrity_terminated: integrityTerminated || undefined,
};
if (integrityTerminated) {
  patch.feedback =
    `Integrity violation on phase ${ph} — this phase is not scored. Prior completed phases keep their recorded scores.`;
} else if (scoreAdjusted && normalizedScore < rawLlmScore) {
  patch.feedback = [patch.feedback, `[Score adjusted ${rawLlmScore}→${normalizedScore}: answer lacks required technical substance.]`]
    .filter(Boolean)
    .join(' ');
}

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
      return isScorablePhaseRow(row);
    })
    .map((row) => Number(row.score));
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// Run all maxQ phases — no early exit on low scores (final PASS/FAIL only on phase maxQ).
const earlyTerminate = false;
const earlyTerminateReason = '';

let nextQ = String(content.nextQuestion || content.next_question || '').trim();
let timeLimitSeconds = null;
let complexityTier = null;

const isActualFinalPhase = ph >= maxQ;

// Ignore premature LLM finished/PASS/FAIL before the last phase.
if (!isActualFinalPhase) {
  if (content.status === 'finished') content.status = 'in_progress';
  content.result = '';
}

let isFinal = isActualFinalPhase || integrityTerminated;

if (integrityTerminated) {
  nextQ = '';
  content.result = 'FAIL';
}

if (nextQ && ph < maxQ && !integrityTerminated) {
  const llmTier = content.complexity_tier || content.complexityTier || null;
  const derived = deriveTimeLimitSeconds(
    content.time_limit_seconds,
    llmTier,
    nextQ,
    cfg,
    ph + 1
  );
  timeLimitSeconds = derived.seconds;
  complexityTier = derived.tier;
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

// Before final phase: missing next question must not end the assessment.
if (ph < maxQ && !integrityTerminated && !nextQ) {
  isFinal = false;
  content.feedback = [
    content.feedback || '',
    `[System: model did not return phase ${ph + 1} question — submit again or contact support.]`,
  ]
    .filter(Boolean)
    .join(' ');
}

const phaseScore = normalizedScore;

if (isActualFinalPhase && !integrityTerminated) {
  if (content.status === 'finished' || content.result) isFinal = true;
  if (!content.result) {
    const avg = computeAverageScore(history, maxQ);
    const finalScore =
      avg ?? (Number.isFinite(phaseScore) && phaseScore != null ? phaseScore : 0);
    content.result = finalScore >= passThreshold ? 'PASS' : 'FAIL';
  }
}

const body = { interview_history: history, updated_at: iso };
if (nextQ && !isFinal) body.current_phase = ph + 1;
else if (!isFinal) body.current_phase = ph;
else body.current_phase = ph;

const averageScore = computeAverageScore(history, maxQ);

let finalResult = null;
let finalFeedback = content.feedback || '';
if (isFinal) {
  body.status = 'completed';
  const finalScore =
    averageScore ??
    (Number.isFinite(phaseScore) && phaseScore != null ? phaseScore : null) ??
    0;
  body.score = finalScore;

  if (integrityTerminated) {
    body.result = 'FAIL';
    finalResult = 'FAIL';
    const phaseSummary = buildPhaseSummary(history);
    finalFeedback = [
      `Assessment failed: integrity violation on phase ${ph}.`,
      averageScore != null
        ? `Recorded average from completed phases before termination: ${averageScore}/100 (${phaseSummary}).`
        : `No prior scored phases (${phaseSummary || 'none'}).`,
    ]
      .filter(Boolean)
      .join(' ');
  } else if (earlyTerminate) {
    body.result = 'FAIL';
    finalResult = 'FAIL';
    const phaseSummary = buildPhaseSummary(history);
    if (averageScore != null) {
      finalFeedback = [
        finalFeedback,
        `Average score across completed phases: ${averageScore}/100 (${phaseSummary}). Pass mark: ${passThreshold}.`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  } else {
    body.result = finalScore >= passThreshold ? 'PASS' : 'FAIL';
    finalResult = body.result;
    if (averageScore != null) {
      const phaseSummary = buildPhaseSummary(history);
      finalFeedback = [
        finalFeedback,
        `Average score across all phases: ${averageScore}/100 (${phaseSummary}). Pass mark: ${passThreshold}.`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  }
}

const b = String(cfg.supabase_url || '').replace(/\/+$/, '');
if (!b || !/^https?:\/\//i.test(b)) {
  throw new Error(
    'supabase_url missing or invalid. Set top-level supabase_url in CFG - Assessment Config (e.g. https://xxx.supabase.co).'
  );
}
const patchUrl = `${b}/rest/v1/assessment_sessions?id=eq.${encodeURIComponent(String(session.id))}`;
const nextRow = history.find((x) => Number(x.phase) === ph + 1);

return [
  {
    json: {
      score: isFinal ? (body.score ?? averageScore ?? phaseScore) : phaseScore,
      phase_score: phaseScore,
      llm_score_raw: rawLlmScore,
      score_adjusted: scoreAdjusted,
      average_score: isFinal ? (body.score ?? averageScore) : null,
      feedback: isFinal ? finalFeedback : (patch.feedback || content.feedback || ''),
      nextQuestion: nextQ,
      suggested_answer: content.suggested_answer || content.suggestedAnswer || '',
      time_limit_seconds: nextRow?.time_limit_seconds ?? timeLimitSeconds,
      deadline_at: nextRow?.deadline_at ?? null,
      complexity_tier: nextRow?.complexity_tier ?? complexityTier,
      isFinal,
      result: isFinal ? finalResult : null,
      terminatedEarly: earlyTerminate,
      integrity_terminated: integrityTerminated,
      candidate_email: current.candidate_email,
      session_id: current.session_id,
      current_phase: ph,
      config: cfg,
      _session_patch_url: patchUrl,
      _session_patch_body: body,
    },
  },
];

// n8n: CODE - Parse Speech Result
// Paste into: CODE - Parse Speech Result (after Basic LLM Chain Speech)

function parseProctorReportRaw(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function mergeTabCountIntoProctorReport(session, tabCount) {
  if (!session || !Object.prototype.hasOwnProperty.call(session, 'proctor_report')) return {};
  const n = Number(tabCount);
  if (!Number.isFinite(n) || n < 0) return {};

  const existing = parseProctorReportRaw(session.proctor_report);
  const entries = Array.isArray(existing.entries) ? existing.entries.slice() : [];
  const fromEntries = entries.filter((e) => e && e.category === 'tab_switch').length;
  const total = Math.max(fromEntries, Math.round(n));

  if (total === fromEntries && Number(existing.tab_switches) === total) return {};

  return {
    proctor_report: {
      ...existing,
      entries,
      tab_switches: total,
    },
  };
}

function speechTimerBounds(config) {
  const min = Number(config?.speech_timer_min_seconds);
  const max = Number(config?.speech_timer_max_seconds);
  return {
    min: Number.isFinite(min) && min > 0 ? min : 30,
    max: Number.isFinite(max) && max > 0 ? max : 120,
  };
}

function clampSeconds(sec, config) {
  const { min, max } = speechTimerBounds(config);
  return Math.min(max, Math.max(min, Math.round(sec)));
}

function tierTimeRange(tier) {
  switch (String(tier || '').toUpperCase()) {
    case 'A':
      return [30, 45];
    case 'B':
      return [45, 75];
    case 'C':
      return [75, 105];
    case 'D':
      return [105, 120];
    default:
      return [45, 75];
  }
}

function deriveTimeLimitSeconds(rawLlmTime, tier, questionText, config) {
  const bounds = speechTimerBounds(config);
  const [loRaw, hiRaw] = tierTimeRange(tier) || [45, 75];
  const lo = Math.max(bounds.min, loRaw);
  const hi = Math.min(bounds.max, hiRaw);
  let sec = Number(rawLlmTime);
  if (!Number.isFinite(sec) || sec <= 0) sec = Math.round((lo + hi) / 2);
  sec = Math.max(lo, Math.min(hi, Math.round(sec)));
  return { seconds: clampSeconds(sec, config), tier: tier || 'B' };
}

function buildDeadline(isoStart, seconds) {
  const start = isoStart ? new Date(isoStart) : new Date();
  return new Date(start.getTime() + seconds * 1000).toISOString();
}

function extractLlmText(api) {
  if (!api || typeof api !== 'object') return '';
  if (typeof api.text === 'string' && api.text.trim()) return api.text.trim();
  if (typeof api.output === 'string' && api.output.trim()) return api.output.trim();
  const c0 = api.choices?.[0];
  if (c0?.message?.content) return String(c0.message.content).trim();
  const parts = api.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts[0]?.text) return String(parts[0].text).trim();
  return '';
}

function parseLlmContent(api) {
  if (api && (api.score != null || api.feedback || api.next_question || api.status === 'finished')) {
    return api;
  }
  const rawText = extractLlmText(api);
  if (!rawText) return { score: 0, feedback: 'Empty model output.', next_question: '' };
  try {
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    return { score: 0, feedback: 'Could not parse model output.', next_question: '' };
  }
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

function extractJdThemes(text) {
  const lines = String(text)
    .split(/\r?\n|(?<=[.;])\s+/)
    .flatMap((chunk) => chunk.split(/\s*[•\-*]\s+/))
    .map((s) => s.replace(/^[\s\d.)(]+/, '').trim())
    .filter((s) => s.length >= 12);
  return lines.length ? [...new Set(lines)].slice(0, 10) : [String(text).slice(0, 400)];
}

function extractCvAnchors(text) {
  const cv = String(text || '');
  const projects =
    cv.match(/(?:project|built|developed|engineered|implemented|led)[^.]{10,120}/gi) || [];
  const skills =
    cv.match(
      /\b(React|Angular|Vue|Node\.?js|Python|Django|Flask|SQL|PostgreSQL|MySQL|MongoDB|\.NET|ASP\.NET|C#|Java|Spring|AWS|Azure|GCP|Docker|Kubernetes|Redis|Kafka|REST|GraphQL|TypeScript|JavaScript|EF\s*Core|LINQ|JWT|OAuth|microservices?|APIM|CI\/CD|GitHub Actions)\b/gi
    ) || [];
  return [
    ...new Set([
      ...projects.slice(0, 5).map((p) => p.trim().slice(0, 80)),
      ...skills.slice(0, 6),
    ]),
  ].filter(Boolean);
}

function buildNextSpeechQuestion(cfg, speechIndex) {
  const role = String(cfg?.requisition_title || 'this role').trim();
  const lanes = [
    `Describe a situation where you had to explain a complex technical topic to a non-technical stakeholder. How did you ensure they understood?`,
    `Tell me about a time you faced pressure, a tight deadline, or conflict at work. How did you communicate and stay composed?`,
    `Why are you interested in the ${role} role, and what would you focus on in your first 90 days?`,
    `Describe a time you had to collaborate with another team or stakeholder who disagreed with your approach. How did you handle it?`,
    `Tell me about a mistake or setback you learned from. What did you change in how you communicate or work afterward?`,
  ];
  const idx = Math.max(0, Math.min(lanes.length - 1, Number(speechIndex || 1) - 1));
  return lanes[idx];
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

const llm = $input.first().json;
const built = pickNodeJson('CODE - Build Speech LLM context') || {};
const session = built.session || {};
const current = built.norm || $('CODE - Normalize Data').first().json;
const cfg = built.norm?.config || current.config || {};
const content = parseLlmContent(llm);

let history = session.interview_history;
if (typeof history === 'string') {
  try {
    history = JSON.parse(history);
  } catch (_) {
    history = [];
  }
}
if (!Array.isArray(history)) history = [];

const maxQ = Number(cfg.max_questions || built.max_questions || 5);
const speechPhases = Number(cfg.speech_phases || built.speech_phases || 5);
const ph = Number(current.current_phase || maxQ + 1);
const speechIndex = ph - maxQ;
const passThreshold = Number(cfg.pass_score_threshold ?? 60);
const techWeight = Number(cfg.technical_weight ?? 0.7);
const speechWeight = Number(cfg.speech_weight ?? 0.3);
const iso = new Date().toISOString();

const phaseScore = Math.max(0, Math.min(100, Math.round(Number(content.score ?? 0))));
const softSkills = {
  clarity: Math.round(Number(content.clarity ?? phaseScore)),
  confidence: Math.round(Number(content.confidence ?? phaseScore)),
  professionalism: Math.round(Number(content.professionalism ?? phaseScore)),
  relevance: Math.round(Number(content.relevance ?? phaseScore)),
};

const answerForPhase = String(
  built.transcribed_answer || built.norm?.answer || current.answer || ''
).trim();

const scoringSource = String(built.scoring_source || 'text-only');

let idx = history.findIndex((x) => Number(x.phase) === ph);
const patch = {
  mode: 'speech',
  answer_text: answerForPhase,
  received_at: iso,
  feedback: content.feedback || null,
  score: phaseScore,
  soft_skills: softSkills,
  speech_metrics: current.speech_metrics || {},
  answer_audio_url: current.audio_url || null,
  stt_source: built.stt_source || built.norm?.stt_source || 'browser',
  scoring_source: scoringSource,
};
if (idx >= 0) history[idx] = { ...history[idx], ...patch };
else history.push({ phase: ph, question_text: built.current_question_text || '', sent_at: iso, ...patch });

let nextQ = String(content.next_question || content.nextQuestion || '').trim();
let timeLimitSeconds = null;
let complexityTier = 'B';
const isSpeechFinal = speechIndex >= speechPhases;
let isFinal = isSpeechFinal;

if (!isSpeechFinal && !nextQ) {
  nextQ = built.fallback_next_question || buildNextSpeechQuestion(cfg, speechIndex + 1);
}

if (nextQ && !isFinal) {
  const derived = deriveTimeLimitSeconds(content.time_limit_seconds, content.complexity_tier, nextQ, cfg);
  timeLimitSeconds = derived.seconds;
  complexityTier = derived.tier;
  const nextPhase = ph + 1;
  const nextEntry = {
    phase: nextPhase,
    mode: 'speech',
    question_text: nextQ,
    answer_text: null,
    sent_at: iso,
    received_at: null,
    score: null,
    time_limit_seconds: timeLimitSeconds,
    complexity_tier: complexityTier,
    deadline_at: buildDeadline(iso, timeLimitSeconds),
  };
  const nextIdx = history.findIndex((x) => Number(x.phase) === nextPhase);
  if (nextIdx >= 0) history[nextIdx] = { ...history[nextIdx], ...nextEntry };
  else history.push(nextEntry);
}

const body = {
  interview_history: history,
  updated_at: iso,
  assessment_stage: isFinal ? 'completed' : 'speech',
};
Object.assign(body, mergeTabCountIntoProctorReport(session, current.tab_switches));

if (!isFinal) body.current_phase = ph + 1;
else body.current_phase = ph;

let finalResult = null;
let finalFeedback = content.feedback || '';
let combinedScore = null;

if (isFinal) {
  const techAvg =
    Number(session.technical_score) ||
    computeTechnicalAverage(history, maxQ) ||
    0;
  const speechAvg = computeSpeechAverage(history, maxQ, speechPhases) ?? phaseScore;
  combinedScore = Math.round(techAvg * techWeight + speechAvg * speechWeight);

  body.status = 'completed';
  body.technical_score = techAvg;
  body.speech_score = speechAvg;
  body.score = combinedScore;
  body.result = combinedScore >= passThreshold ? 'PASS' : 'FAIL';
  finalResult = body.result;
  finalFeedback = [
    finalFeedback,
    `Technical: ${techAvg}/100 | Communication: ${speechAvg}/100 | Combined: ${combinedScore}/100 (pass ${passThreshold}).`,
  ]
    .filter(Boolean)
    .join(' ');
}

const b = String(cfg.supabase_url || '').replace(/\/+$/, '');
const patchUrl = `${b}/rest/v1/assessment_sessions?id=eq.${encodeURIComponent(String(session.id))}`;
const nextRow = history.find((x) => Number(x.phase) === ph + 1);

return [
  {
    json: {
      score: isFinal ? combinedScore : phaseScore,
      phase_score: phaseScore,
      soft_skills: softSkills,
      feedback: isFinal ? finalFeedback : patch.feedback || '',
      nextQuestion: nextQ,
      time_limit_seconds: nextRow?.time_limit_seconds ?? timeLimitSeconds,
      deadline_at: nextRow?.deadline_at ?? null,
      complexity_tier: nextRow?.complexity_tier ?? complexityTier,
      isFinal,
      assessment_mode: 'speech',
      speech_phases: speechPhases,
      result: isFinal ? finalResult : null,
      candidate_email: current.candidate_email,
      session_id: session.id,
      current_phase: ph,
      config: cfg,
      gmail_thread_id: session.gmail_thread_id || null,
      gmail_message_id: session.gmail_message_id || null,
      mail_subject: session.mail_subject || null,
      _session_patch_url: patchUrl,
      _session_patch_body: body,
    },
  },
];

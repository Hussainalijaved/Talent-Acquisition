// n8n: CODE - Build Speech LLM context (communication phases)
// Paste into: CODE - Build Speech LLM context (speech branch, before Basic LLM Chain Speech)

const norm = $('CODE - Normalize Data').first().json;
const raw = $input.first().json;
const session = Array.isArray(raw) ? raw[0] : raw;
if (!session?.id) {
  throw new Error('No assessment session row for id=' + norm.session_id);
}

let history = session.interview_history;
if (typeof history === 'string') {
  try {
    history = JSON.parse(history);
  } catch (e) {
    history = [];
  }
}
if (!Array.isArray(history)) history = [];

let sessionConfig = session.config;
if (typeof sessionConfig === 'string') {
  try {
    sessionConfig = JSON.parse(sessionConfig);
  } catch (e) {
    sessionConfig = {};
  }
}
if (!sessionConfig || typeof sessionConfig !== 'object') sessionConfig = {};

const cfg = {
  ...norm.config,
  ...sessionConfig,
  requisition_title:
    sessionConfig.requisition_title || norm.config?.requisition_title || '',
  requisition_requirements:
    sessionConfig.requisition_requirements || norm.config?.requisition_requirements || '',
  groq_model:
    sessionConfig.groq_model || norm.config?.groq_model || 'llama-3.3-70b-versatile',
  max_questions: Number(sessionConfig.max_questions || norm.config?.max_questions || 5),
  speech_phases: Number(sessionConfig.speech_phases || norm.config?.speech_phases || 3),
  pass_score_threshold: Number(
    sessionConfig.pass_score_threshold ?? norm.config?.pass_score_threshold ?? 60
  ),
  timer_min_seconds: Number(sessionConfig.timer_min_seconds ?? norm.config?.timer_min_seconds ?? 60),
  timer_max_seconds: Number(sessionConfig.timer_max_seconds ?? norm.config?.timer_max_seconds ?? 600),
};

const maxQ = Number(cfg.max_questions || 5);
const speechPhases = Number(cfg.speech_phases || 3);
const ph = Number(norm.current_phase || maxQ + 1);
const speechIndex = ph - maxQ;
const isFinal = speechIndex >= speechPhases;

const jdTitle = String(cfg.requisition_title || '').trim();
const jdReq = String(cfg.requisition_requirements || '').trim();
const cvText = String(session.cv_plaintext || '').slice(0, 4000);

const currentRow = history.find((h) => Number(h.phase) === ph);
const currentQuestionText = String(
  currentRow?.question_text || currentRow?.question || ''
).trim();

const speechHistory = history
  .filter((h) => Number(h.phase) > maxQ)
  .map(
    (h) =>
      `Speech ${Number(h.phase) - maxQ} Q: ${h.question_text || ''} | A: ${h.answer_text ?? 'pending'} | Score: ${h.score ?? 'N/A'}`
  )
  .join('\n');

const metrics = norm.speech_metrics || {};
const metricsText = [
  metrics.duration_seconds != null ? `duration_seconds: ${metrics.duration_seconds}` : '',
  metrics.words_per_minute != null ? `words_per_minute: ${metrics.words_per_minute}` : '',
  metrics.filler_word_count != null ? `filler_word_count: ${metrics.filler_word_count}` : '',
  metrics.long_pause_count != null ? `long_pause_count: ${metrics.long_pause_count}` : '',
]
  .filter(Boolean)
  .join(', ');

const speechLanes = [
  'Communication — explain a technical concept to a non-technical audience (clarity, patience, structure)',
  'Confidence & composure — pressure, deadline, conflict, or failure (tone, ownership, calm)',
  'Professionalism & role fit — motivation for this role, collaboration, first 90 days (engagement, maturity)',
];

const nextLane = !isFinal ? speechLanes[Math.min(speechIndex, speechLanes.length - 1)] : '';

const systemContent = `You are an expert behavioral interviewer evaluating SPOKEN communication for ${cfg.organization_name || 'the company'}.

ROLE: ${jdTitle}
This is the COMMUNICATION round (speech phases ${speechIndex} of ${speechPhases}) after a technical assessment.

═══════════════════════════════════════ SCORING DIMENSIONS (0–100 each) ═══════════════════════════════════════
1. clarity — logical structure, easy to follow, complete thoughts
2. confidence — steady pace, minimal hesitation, assured delivery (use audio metrics + transcript)
3. professionalism — appropriate language, respectful tone, workplace-ready
4. relevance — directly answers the question asked (STAR when behavioral)

Phase score = weighted average:
  clarity 30%, confidence 25%, professionalism 20%, relevance 25%

Use delivery signals when provided (WPM, fillers, pauses):
  - High fillers (>5/min) or very slow WPM (<90) → cap confidence ≤ 55
  - Very fast WPM (>200) with thin content → cap clarity ≤ 50
  - Empty or < 20 words → score ≤ 15

JD context (role expectations):
${jdReq.slice(0, 1500)}

CV excerpt (for grounding examples — do not invent employers/projects):
${cvText || '(none)'}

Prior speech Q&A:
${speechHistory || '(none yet)'}

Question asked this phase:
${currentQuestionText || '(see history)'}

Candidate spoken answer (STT transcript):
${norm.answer}

Audio delivery metrics: ${metricsText || 'not provided'}

${!isFinal ? `Next speech phase ${speechIndex + 1} focus: ${nextLane}` : 'FINAL speech phase — no next_question.'}

OUTPUT — JSON ONLY:
${!isFinal
  ? '{"score":number,"clarity":number,"confidence":number,"professionalism":number,"relevance":number,"feedback":string,"next_question":string,"time_limit_seconds":number,"complexity_tier":"A"|"B"|"C"|"D"}'
  : '{"status":"finished","score":number,"clarity":number,"confidence":number,"professionalism":number,"relevance":number,"feedback":string,"next_question":""}'}`;

const body = {
  model: cfg.groq_model || 'llama-3.3-70b-versatile',
  messages: [
    { role: 'system', content: systemContent },
    { role: 'user', content: 'Evaluate the spoken answer. Respond with JSON only.' },
  ],
  temperature: 0.25,
  response_format: { type: 'json_object' },
};

return [
  {
    json: {
      groq_assessment_request: body,
      prompt: systemContent,
      session,
      norm: { ...norm, config: cfg },
      isFinal,
      speech_index: speechIndex,
      speech_phases: speechPhases,
      max_questions: maxQ,
      current_question_text: currentQuestionText,
    },
  },
];

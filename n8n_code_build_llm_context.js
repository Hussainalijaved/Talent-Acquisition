// n8n: CODE - Build LLM context (assessment phases 1–5)
// Paste into: CODE - Build LLM context (before Basic LLM Chain)

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
  fail_score_threshold: Number(
    sessionConfig.fail_score_threshold ?? norm.config?.fail_score_threshold ?? 30
  ),
  pass_score_threshold: Number(
    sessionConfig.pass_score_threshold ?? norm.config?.pass_score_threshold ?? 60
  ),
  timer_min_seconds: Number(sessionConfig.timer_min_seconds ?? norm.config?.timer_min_seconds ?? 60),
  timer_max_seconds: Number(sessionConfig.timer_max_seconds ?? norm.config?.timer_max_seconds ?? 600),
};

const ph = Number(norm.current_phase || 1);
const maxQ = Number(cfg.max_questions || 5);
const isFinal = ph >= maxQ;
const failThreshold = Number(cfg.fail_score_threshold ?? 30);

const jdTitle = String(cfg.requisition_title || '').trim();
const jdReq = String(cfg.requisition_requirements || '').trim();
if (!jdTitle || !jdReq) {
  throw new Error(
    'JD missing on assessment session. Complete CV screening with recruiter form JD first (session.config.requisition_title / requisition_requirements).'
  );
}

function extractJdThemes(text) {
  const lines = String(text)
    .split(/\r?\n|(?<=[.;])\s+/)
    .flatMap((chunk) => chunk.split(/\s*[•\-*]\s+/))
    .map((s) => s.replace(/^[\s\d.)(]+/, '').trim())
    .filter((s) => s.length >= 12);
  return lines.length ? [...new Set(lines)].slice(0, 10) : [String(text).slice(0, 500)];
}

const jdThemes = extractJdThemes(jdReq);
const phaseFocusLanes = [
  'JD core responsibilities and must-have skills for this role (breadth, not deep-dive on one tool)',
  'JD system design / architecture / integration — how systems connect and scale for this role',
  'JD hands-on implementation, APIs, data, delivery, or feature ownership',
  'JD quality bar: security, performance, reliability, testing, monitoring, or DevOps',
  'Holistic JD role fit — can this candidate perform the full job',
];

const cvText = String(session.cv_plaintext || '').slice(0, 8000);
const historyText = history
  .map(
    (h) =>
      `Phase ${h.phase} Q: ${h.question_text || h.question || ''} | A: ${h.answer_text ?? 'pending'} | Score: ${h.score ?? 'N/A'}`
  )
  .join('\n');

const themesAsked = history
  .filter((h) => h.question_text || h.question)
  .map((h) => `Phase ${h.phase}: ${String(h.question_text || h.question).slice(0, 140)}`)
  .join('\n');

const cvTopicsUsed = history
  .filter((h) => h.question_text || h.question)
  .map((h) => String(h.question_text || h.question).slice(0, 100))
  .join('\n');

function extractCvAnchors(text) {
  const cv = String(text || '');
  const projects =
    cv.match(/(?:project|built|developed|engineered|implemented|led)[^.]{10,120}/gi) || [];
  const skills =
    cv.match(
      /\b(React|Angular|Vue|Node\.?js|Python|Django|Flask|SQL|PostgreSQL|MySQL|MongoDB|\.NET|ASP\.NET|C#|Java|Spring|AWS|Azure|GCP|Docker|Kubernetes|Redis|Kafka|REST|GraphQL|TypeScript|JavaScript|EF\s*Core|LINQ|JWT|OAuth|microservices?|APIM|CI\/CD|GitHub Actions)\b/gi
    ) || [];
  const employers = cv.match(/(?:at|@)\s+[A-Z][A-Za-z0-9&.\s]{2,40}(?:,|\.|\s{2})/g) || [];
  const anchors = [
    ...new Set([
      ...projects.slice(0, 5).map((p) => p.trim().slice(0, 100)),
      ...skills.slice(0, 8),
      ...employers.slice(0, 3).map((e) => e.trim()),
    ]),
  ].filter(Boolean);
  return anchors.length ? anchors : ['(parse named projects, tools, employers from CV excerpt)'];
}

const cvAnchors = extractCvAnchors(cvText);

const currentQuestionRow = history.find((h) => Number(h.phase) === ph);
const currentQuestionText = String(
  currentQuestionRow?.question_text || currentQuestionRow?.question || ''
).trim();

const prevPhaseRow = history.find((h) => Number(h.phase) === ph - 1);
const prevTimeLimit = prevPhaseRow?.time_limit_seconds ?? null;

const nextPhaseNum = ph + 1;
const nextFocusLane = !isFinal
  ? phaseFocusLanes[Math.min(nextPhaseNum - 1, phaseFocusLanes.length - 1)]
  : '';
const nextJdTheme = !isFinal
  ? jdThemes[(nextPhaseNum - 1) % jdThemes.length] || nextFocusLane
  : '';
const nextCvAnchor = !isFinal
  ? cvAnchors[(nextPhaseNum - 1) % cvAnchors.length] || cvAnchors[0]
  : '';

const sharedRules = `"""You are an elite technical interviewer running a structured ${maxQ}-phase screening for ${cfg.organization_name || 'the company'}.

PRIMARY GOAL: Each phase tests a DIFFERENT combination of JD requirement + CV evidence. Never from CV alone. Never from JD alone.

═══════════════════════════════════════ CV + JD DUAL-SOURCE (MOST IMPORTANT) ═══════════════════════════════════════
Every question MUST explicitly combine BOTH sources in one cohesive prompt:
  (A) A specific JD requirement, responsibility, or outcome from the Job Description, AND
  (B) A specific CV anchor — named project, employer, tool, or experience from the candidate's CV.

Question formula (use every time):
  "The role requires [JD requirement]. Your CV shows [CV project/skill/employer] — how did/would you [technical task linking both]?"

Rules:
  - Each phase = NEW JD theme + NEW CV anchor (rotate both — do not reuse).
  - Spread coverage across the full JD AND across different parts of the CV.
  - NEVER ask a question answerable without reading BOTH the JD and this CV.
  - NEVER deep-dive the same CV project or same JD bullet in more than one phase.

Phase topic lanes (pair with a fresh JD theme + CV anchor each phase):
  Phase 1: ${phaseFocusLanes[0]}
  Phase 2: ${phaseFocusLanes[1]}
  Phase 3: ${phaseFocusLanes[2]}
  Phase 4: ${phaseFocusLanes[3]}
  Phase 5: ${phaseFocusLanes[4]}

JD themes (rotate — one per phase):
${jdThemes.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}

CV anchors detected (rotate — pick a different one each phase):
${cvAnchors.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}

When writing next_question:
  1. Pick JD theme for phase N NOT used in "Themes already asked".
  2. Pick CV anchor NOT used in "CV anchors already used".
  3. Write ONE question that names BOTH in the same sentence.
  4. If CV lacks a skill the JD requires, pair the JD theme with the closest related CV experience and ask how they would bridge the gap.

FORBIDDEN:
  - CV-only questions (no JD requirement named).
  - JD-only questions (no CV project/skill/employer named).
  - Repeating the same CV project or same JD theme across phases.
  - Generic textbook questions any candidate could answer.

═══════════════════════════════════════ SCORING — ANSWER MUST MATCH THE QUESTION ASKED ═══════════════════════════════════════
Score ONLY how well the candidate answered THE SPECIFIC question for this phase (see "Question asked this phase" below).

Weighting:
  - 50% RELEVANCE: Did they answer what was asked (both JD and CV parts of the question)?
  - 25% JD FIT: Does the answer show they can meet the role requirement?
  - 25% CV EVIDENCE: Concrete examples from their stated experience (not invented).

Off-topic / mismatch penalties (apply FIRST):
  - Answer is about a different topic than the question → score ≤ 15
  - Buzzwords only, no link to the question → score ≤ 25
  - Partially on-topic but vague → 30–50
  - Directly answers the question with technical detail → 55–75
  - Strong, specific, JD-aligned answer with evidence → 76–100

Do NOT give high scores for impressive but irrelevant content.

═══════════════════════════════════════ STRUCTURE ═══════════════════════════════════════
- Exactly ${maxQ} phases. Phases 1–4: score + one next_question. Phase ${maxQ}: score + PASS/FAIL, next_question "".
- Phase 1 question already exists in history — grade it; write phase 2 when current phase is 1.
- Empty/timeout/[SYSTEM TERMINATION] → score 0–15, next_question "" if integrity.

═══════════════════════════════════════ TIME LIMIT (phases 1–4) ═══════════════════════════════════════
Set time_limit_seconds (60–600) and complexity_tier A|B|C|D from next_question depth.

═══════════════════════════════════════ OUTPUT — JSON ONLY ═══════════════════════════════════════
Phases 1–4: {"score":number,"feedback":string,"suggested_answer":string,"next_question":string,"time_limit_seconds":number,"complexity_tier":"A"|"B"|"C"|"D"}
Phase ${maxQ}: {"status":"finished","result":"PASS"|"FAIL","score":number,"feedback":string,"suggested_answer":string,"next_question":""}

Job title: ${jdTitle}
JD requirements:
${jdReq}

Candidate CV (excerpt):
${cvText}

Prior Q&A:
${historyText || '(none yet)'}

Themes already asked (next question MUST use a DIFFERENT JD topic):
${themesAsked || '(none yet)'}

CV anchors already used (do NOT reuse same project/stack):
${cvTopicsUsed || '(none yet)'}

Tab switches: ${norm.tab_switches || 0}`;

let systemContent;
if (isFinal) {
  systemContent = `${sharedRules}

Current phase: ${ph} of ${maxQ} (FINAL).
Question asked this phase:
${currentQuestionText || '(see prior Q&A)'}

Answer to grade:
${norm.answer}

Tasks:
1. Score 0–100 based on relevance to the question above + JD holistic fit.
2. result = PASS only if candidate demonstrated breadth across JD topics in the session; else FAIL.
3. feedback + suggested_answer (max 2 short paragraphs).

Output: {"status":"finished","result":"PASS"|"FAIL","score":number,"feedback":string,"suggested_answer":string,"next_question":""}`;
} else {
  systemContent = `${sharedRules}

Current phase: ${ph} of ${maxQ}.
Question asked this phase (score against THIS):
${currentQuestionText || '(see prior Q&A)'}

Answer to grade:
${norm.answer}
${prevTimeLimit != null ? `Previous phase time_limit_seconds: ${prevTimeLimit}` : ''}

Next question target — phase ${nextPhaseNum}:
  Focus lane: ${nextFocusLane}
  JD theme to use: ${nextJdTheme}
  CV anchor to use: ${nextCvAnchor}

Tasks:
1. Score current answer 0–100 (must address BOTH JD and CV parts of the question asked).
2. feedback — note if answer ignored JD requirement or lacked CV-specific evidence.
3. suggested_answer (max 2 short paragraphs).
4. next_question for phase ${nextPhaseNum} — MUST name one JD requirement AND one CV anchor; new topic pair, no repeats.
5. time_limit_seconds + complexity_tier.

Output: {"score":number,"feedback":string,"suggested_answer":string,"next_question":string,"time_limit_seconds":number,"complexity_tier":"A"|"B"|"C"|"D"}`;
}

const body = {
  model: cfg.groq_model || 'llama-3.3-70b-versatile',
  messages: [
    { role: 'system', content: systemContent },
    { role: 'user', content: 'Evaluate and respond with JSON only.' },
  ],
  temperature: isFinal ? 0.1 : 0.35,
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
      failThreshold,
      current_question_text: currentQuestionText,
      next_jd_theme: nextJdTheme,
      next_cv_anchor: nextCvAnchor,
      next_focus_lane: nextFocusLane,
    },
  },
];

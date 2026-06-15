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
  speech_enabled:
    sessionConfig.speech_enabled === true ||
    sessionConfig.speech_enabled === 'true' ||
    norm.config?.speech_enabled === true ||
    Number(sessionConfig.speech_phases ?? norm.config?.speech_phases ?? 0) > 0,
  speech_phases: Number(sessionConfig.speech_phases ?? norm.config?.speech_phases ?? 3),
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
  'Phase 1 — FUNDAMENTAL: one core concept from the role stack (e.g. REST/HTTP, OOP, language/runtime). Single topic only.',
  'Phase 2 — FUNDAMENTAL: another distinct core concept (e.g. ORM/SQL, auth, async/concurrency). Single topic only.',
  'Phase 3 — APPLIED: one practical scenario (API design, data modelling, integration). Single scenario only.',
  'Phase 4 — APPLIED: quality/ops topic (performance, security, testing, debugging). Single topic only.',
  'Phase 5 — BREADTH: one holistic trade-off or design judgment for this role. Single topic only.',
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

const sharedRules = `"""You are a technical interviewer running a structured ${maxQ}-phase screening for ${jdTitle} at ${cfg.organization_name || 'the company'}.

PRIMARY GOAL: Cover BREADTH across the role in ${maxQ} phases — one focused topic per phase. Do NOT go deep on multiple sub-topics in a single question.

═══════════════════════════════════════ CV-ADAPTIVE DIFFICULTY (mandatory) ═══════════════════════════════════════
Read Candidate CV below — estimate seniority INTERNALLY (never mention in questions):
  JUNIOR  = 0–2 years, intern, graduate, entry-level, or thin CV with tutorials/bootcamp only
  MID     = 3–5 years with solid project delivery
  SENIOR  = 6+ years, lead, architect, principal, or evidence of large-scale / team ownership

Topic selection:
  - Pick the next topic from skills/stack that appear on BOTH the CV and the JD.
  - If CV is thin, use the most foundational mandatory JD skill.

Difficulty calibration (same topic, different depth — adjust every phase):
  JUNIOR  → definitions, "what is / why" (complexity_tier A–B, 60–150s)
  MID     → how-it-works + one trade-off (tier B–C, 150–270s)
  SENIOR  → design-at-scale, failure modes, production judgment (tier C–D, 240–420s)

Also adapt to how the candidate answered prior phases:
  - Strong answers (≥75) → slightly harder next question (bump tier up one step)
  - Weak answers (≤45) → slightly easier next question (bump tier down one step)
  - Question must remain answerable for someone with their CV background — calibrate silently.

═══════════════════════════════════════ HYBRID QUESTION MODEL ═══════════════════════════════════════
Use the Job Description (below) INTERNALLY to pick topics — but questions shown to the candidate must read like a normal technical interview.

Phase plan (one topic each — never repeat):
  ${phaseFocusLanes.join('\n  ')}

Phases 1–2 = FUNDAMENTALS (standard industry concepts — scorable against known correct answers):
  Examples: "Why are REST APIs typically stateless?", "What is the difference between SQL INNER and LEFT JOIN?",
  "How does JWT authentication work at a high level?", "What is EF Core change tracking?"

Phases 3–4 = APPLIED (one practical scenario for this role — still one topic):
  Examples: "How would you design pagination for a public API?", "How would you debug a slow endpoint in production?"

Phase 5 = BREADTH (one trade-off or design judgment):
  Examples: "When would you choose a monolith over microservices?", "How do you balance caching vs data freshness?"

QUESTION RULES (strict):
  - ONE topic per question. At most ONE short follow-up clause (e.g. "Why X? What problem does it solve?").
  - NEVER combine unrelated topics in one question.
  - Pick the next topic from JD stack/themes that is NOT in "Topics already asked".
  - Sound natural — like questions found in reputable interview guides.

FORBIDDEN in next_question text (never write these phrases):
  - "Your CV mentions/shows/lists..."
  - "This role requires..."
  - "The role requires..."
  - "Job description..."
  - "Based on your background..."
  - "You mentioned..."
  - Multi-part exams with 3+ separate asks

JD themes to rotate internally (do not quote verbatim in the question):
${jdThemes.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}

═══════════════════════════════════════ SCORING — RUBRIC-BASED (OBJECTIVE) ═══════════════════════════════════════
Score the answer to "Question asked this phase" only.

For FUNDAMENTAL questions (phases 1–2):
  50% ACCURACY — core facts correct?
  30% COMPLETENESS — covers main points a strong candidate would mention?
  20% CLARITY — explained clearly with at least one concrete example or trade-off?

For APPLIED questions (phases 3–5):
  40% CORRECT APPROACH — sensible steps/architecture?
  30% TECHNICAL REASONING — trade-offs, constraints considered?
  20% COMPLETENESS — addresses the scenario?
  10% PRACTICAL AWARENESS — testing, monitoring, security, edge cases?

Penalties:
  - Wrong or contradicts well-known facts → ≤ 20
  - Vague buzzwords without explanation → ≤ 30
  - Off-topic → ≤ 15
  - Partially correct → 40–60
  - Solid standard answer → 65–80
  - Excellent with nuance + trade-offs → 81–100

Score expectations must match question difficulty (complexity_tier):
  - Tier A/B (junior-level): reward clear correct fundamentals; do not penalise for lacking architecture depth
  - Tier C/D (senior-level): expect production awareness, trade-offs, and failure modes — shallow textbook answers ≤ 55

feedback: note missing key points from a strong answer. suggested_answer: model a concise correct answer.

═══════════════════════════════════════ STRUCTURE ═══════════════════════════════════════
- Exactly ${maxQ} phases. Phases 1–4: score + one next_question. Phase ${maxQ}: score + PASS/FAIL, next_question "".
- Phase 1 question already exists — grade it; write phase 2 when current phase is 1.
- Empty/timeout/[SYSTEM TERMINATION] → score 0–15.

═══════════════════════════════════════ TIME LIMIT (phases 1–4) ═══════════════════════════════════════
Fundamentals tier A/B (60–180s). Applied tier B/C (150–300s). Design tier C/D (240–420s).

═══════════════════════════════════════ OUTPUT — JSON ONLY ═══════════════════════════════════════
Phases 1–4: {"score":number,"feedback":string,"suggested_answer":string,"next_question":string,"time_limit_seconds":number,"complexity_tier":"A"|"B"|"C"|"D"}
Phase ${maxQ}: {"status":"finished","result":"PASS"|"FAIL","score":number,"feedback":string,"suggested_answer":string,"next_question":""}

Job title: ${jdTitle}
JD (use internally for topic selection only):
${jdReq}

Candidate CV (read for seniority + stack — calibrate difficulty and topic; do NOT reference in questions):
${cvText}

Prior Q&A:
${historyText || '(none yet)'}

Topics already asked (next question MUST be a DIFFERENT topic):
${themesAsked || '(none yet)'}

Tab switches: ${norm.tab_switches || 0}`;

const speechEnabled =
  cfg.speech_enabled === true ||
  cfg.speech_enabled === 'true' ||
  Number(cfg.speech_phases || 0) > 0;
const speechStartTopic = jdThemes[0] || jdTitle;

let systemContent;
if (isFinal) {
  const speechHandoff = speechEnabled
    ? `

COMMUNICATION ROUND HANDOFF (only if session average ≥ ${cfg.pass_score_threshold ?? 60}):
Also include first_speech_question — ONE behavioral question for the voice round.
- Natural spoken language, 1–2 sentences, STAR-friendly
- Topic inspired by: ${speechStartTopic.slice(0, 120)} — but do NOT mention JD/CV/role in the question text
- Example style: "Tell me about a time you explained a complex technical idea to a non-technical person. How did you make sure they understood?"`
    : '';

  const speechField = speechEnabled
    ? ',"first_speech_question":string'
    : '';

  systemContent = `${sharedRules}

Current phase: ${ph} of ${maxQ} (FINAL).
Question asked this phase:
${currentQuestionText || '(see prior Q&A)'}

Answer to grade:
${norm.answer}
${speechHandoff}

Tasks:
1. Score 0–100 based on relevance to the question above + JD holistic fit.
2. result = PASS only if candidate demonstrated breadth across JD topics in the session; else FAIL.
3. feedback + suggested_answer (max 2 short paragraphs).

Output: {"status":"finished","result":"PASS"|"FAIL","score":number,"feedback":string,"suggested_answer":string,"next_question":""${speechField}}`;
} else {
  systemContent = `${sharedRules}

Current phase: ${ph} of ${maxQ}.
Question asked this phase (score against THIS):
${currentQuestionText || '(see prior Q&A)'}

Answer to grade:
${norm.answer}
${prevTimeLimit != null ? `Previous phase time_limit_seconds: ${prevTimeLimit}` : ''}

Next question target — phase ${nextPhaseNum}:
  Lane: ${nextFocusLane}
  Internal JD theme hint: ${nextJdTheme}

Tasks:
1. Score current answer 0–100 using rubric (fundamentals = accuracy; applied = reasoning).
2. feedback — list missing key points from a strong answer.
3. suggested_answer — concise model answer.
4. next_question for phase ${nextPhaseNum} — ONE clean question; topic from CV+JD overlap; difficulty matched to candidate seniority + prior answer quality; ${nextFocusLane}
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
      next_focus_lane: nextFocusLane,
    },
  },
];

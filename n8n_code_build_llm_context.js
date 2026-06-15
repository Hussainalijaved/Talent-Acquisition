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

PRIMARY GOAL: Each phase tests whether the candidate can DEMONSTRATE real experience — not merely claim it. Use JD + CV together as anchors; score DEPTH and SPECIFICITY, not confident storytelling alone. Candidates may exaggerate or invent — your job is to detect shallow/generic answers.

═══════════════════════════════════════ CV + JD AS EXAMPLES (NOT BLIND TRUST) ═══════════════════════════════════════
Treat CV entries as CLAIMS TO VERIFY, not facts. Treat JD bullets as CAPABILITIES TO PROBE.

Every question MUST combine BOTH in one prompt:
  (A) One specific JD requirement / outcome for ${jdTitle}, AND
  (B) One specific CV anchor (named project, employer, tool, stack) from this candidate's CV.

Preferred question shapes (use these — avoid architecture tours):
  • TRADE-OFF: "Your CV shows [CV anchor]. The role requires [JD]. What trade-off did you make between [option A] and [option B], and what broke when you chose wrong?"
  • VALIDATION: "For [CV anchor], how did you prove [JD capability] worked — metrics, tests, or production signal?"
  • FAILURE/DEBUG: "Describe one real bug, outage, or performance issue in [CV anchor] and the exact steps you took."
  • CONSTRAINT: "Under what constraints (team size, deadline, legacy system) did you deliver [JD outcome] using [CV stack]?"

FORBIDDEN question types:
  - "Describe the full structure/architecture of your project" (too easy to fake — too broad)
  - "How would you design X from scratch" without tying to their CV claim
  - CV-only or JD-only questions
  - Generic textbook questions any candidate could answer
  - Reusing the same CV project or JD theme in more than one phase

Phase lanes (pair each with a NEW JD theme + NEW CV anchor):
  Phase 1: ${phaseFocusLanes[0]} — probe ONE concrete decision, not whole project overview
  Phase 2: ${phaseFocusLanes[1]} — integration/trade-off or failure mode
  Phase 3: ${phaseFocusLanes[2]} — hands-on implementation detail tied to CV claim
  Phase 4: ${phaseFocusLanes[3]} — quality, security, performance with measurable signal
  Phase 5: ${phaseFocusLanes[4]} — holistic fit; stress-test consistency with prior answers

JD themes (rotate — one per phase):
${jdThemes.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}

CV anchors detected (rotate — different anchor each phase):
${cvAnchors.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}

When writing next_question:
  1. Pick JD theme NOT in "Themes already asked".
  2. Pick CV anchor NOT in "CV anchors already used".
  3. Ask ONE focused verification question (not multi-part essay).
  4. If CV lacks JD skill, ask how they would bridge the gap using closest CV experience.

═══════════════════════════════════════ SCORING — CREDIBILITY & DEPTH (NOT JUST FLUENCY) ═══════════════════════════════════════
You cannot know if the candidate is lying, but you CAN score whether the answer shows authentic hands-on experience.

Score the answer to "Question asked this phase" using:

  40% RELEVANCE — addresses BOTH the JD part and the named CV anchor in the question
  30% TECHNICAL DEPTH — concrete mechanisms (tools, patterns, APIs, schema, deployment), not buzzwords
  20% SPECIFICITY — numbers, timelines, constraints, trade-offs, failures, or measurable outcomes
  10% JD FIT — demonstrates they can do this role's work

Apply penalties FIRST (likely generic or fabricated — cap score even if answer sounds confident):
  - Buzzwords only (scalable, robust, microservices, best practices) with no implementation detail → ≤ 28
  - No numbers AND no constraints AND no failure/trade-off/example → ≤ 32
  - Could be written by anyone without reading THIS CV → ≤ 25
  - Textbook definition / tutorial answer, not personal experience → ≤ 22
  - Off-topic or ignores JD or CV anchor in question → ≤ 15
  - Vague "we did X" with no I/me ownership or role clarity → ≤ 35

High scores (76–100) ONLY when answer includes MOST of:
  - Names the CV anchor and JD requirement explicitly
  - Specific technical steps (not just labels)
  - At least one of: metric, timeline, team constraint, bug/incident, or rejected alternative
  - Shows operational awareness (testing, monitoring, rollback, edge cases)

feedback MUST note: "credible depth" OR "generic — may lack hands-on experience" when relevant.

Do NOT reward impressive but irrelevant content. Do NOT assume CV claims in the answer are true — reward evidence of depth.

═══════════════════════════════════════ STRUCTURE ═══════════════════════════════════════
- Exactly ${maxQ} phases. Phases 1–4: score + one next_question. Phase ${maxQ}: score + PASS/FAIL, next_question "".
- Phase 1 question already exists in history — grade it with the same credibility rubric; write phase 2 when current phase is 1.
- Empty/timeout/[SYSTEM TERMINATION] → score 0–15, next_question "" if integrity.

═══════════════════════════════════════ TIME LIMIT (phases 1–4) ═══════════════════════════════════════
Set time_limit_seconds (60–600) and complexity_tier A|B|C|D from next_question depth.

═══════════════════════════════════════ OUTPUT — JSON ONLY ═══════════════════════════════════════
Phases 1–4: {"score":number,"feedback":string,"suggested_answer":string,"next_question":string,"time_limit_seconds":number,"complexity_tier":"A"|"B"|"C"|"D"}
Phase ${maxQ}: {"status":"finished","result":"PASS"|"FAIL","score":number,"feedback":string,"suggested_answer":string,"next_question":""}

Job title: ${jdTitle}
JD requirements:
${jdReq}

Candidate CV (excerpt) — treat as claims to verify:
${cvText}

Prior Q&A (check consistency — flag contradictions in feedback):
${historyText || '(none yet)'}

Themes already asked (next question MUST use a DIFFERENT JD topic):
${themesAsked || '(none yet)'}

CV anchors already used (do NOT reuse same project/stack):
${cvTopicsUsed || '(none yet)'}

Tab switches: ${norm.tab_switches || 0}`;

const speechEnabled =
  cfg.speech_enabled === true ||
  cfg.speech_enabled === 'true' ||
  Number(cfg.speech_phases || 0) > 0;
const speechStartJd = jdThemes[0] || jdTitle;
const speechStartCv = cvAnchors[0] || 'a project from your CV';

let systemContent;
if (isFinal) {
  const speechHandoff = speechEnabled
    ? `

COMMUNICATION ROUND HANDOFF (only if technical session warrants PASS — average across phases ≥ ${cfg.pass_score_threshold ?? 60}):
Also include first_speech_question — a behavioral SPOKEN question for the voice round (phase ${maxQ + 1}).
- MUST name JD requirement: "${speechStartJd.slice(0, 160)}"
- MUST reference CV anchor: ${speechStartCv}
- 2–4 sentences, natural to speak aloud, STAR-friendly
- Communication focus (clarity explaining to non-technical audience)`
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
  Focus lane: ${nextFocusLane}
  JD theme to use: ${nextJdTheme}
  CV anchor to use: ${nextCvAnchor}

Tasks:
1. Score current answer 0–100 using CREDIBILITY rubric (depth + specificity, not fluent claims alone).
2. feedback — note credible depth OR generic/fabricated signals; flag if answer ignores JD or CV anchor.
3. suggested_answer (max 2 short paragraphs) showing what a strong, specific answer looks like.
4. next_question for phase ${nextPhaseNum} — ONE verification question naming JD theme "${nextJdTheme}" AND CV anchor "${nextCvAnchor}"; no architecture overview; no repeats.
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

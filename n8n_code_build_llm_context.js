// n8n: CODE - Build LLM context (assessment phases 1–5)
// WORKFLOW: Assessment Answer workflow ONLY (NOT Live Speech)
// NODE: CODE - Build LLM context (before Basic LLM Chain)
// Requires upstream: CODE - Normalize Data
// Source file: n8n_code_build_llm_context.js — never paste parse_live_speech_result.js here.

let norm;
try {
  norm = $('CODE - Normalize Data').first().json;
} catch (_) {
  throw new Error(
    'Wrong code in this node. Paste n8n_code_build_llm_context.js into "CODE - Build LLM context". ' +
    'If you see "Normalize Live Speech Complete" errors, you accidentally pasted n8n_code_parse_live_speech_result.js.'
  );
}
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
  speech_phases: Number(sessionConfig.speech_phases ?? norm.config?.speech_phases ?? 5),
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

function inferExperienceTier(cvText) {
  const cv = String(cvText || '');
  const yearMatches = [...cv.matchAll(/(\d+)\+?\s*(?:years?|yrs?)(?:\s+of)?\s*(?:experience|exp)?/gi)];
  let maxYears = 0;
  for (const m of yearMatches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > maxYears) maxYears = n;
  }
  if (/\b(senior|lead|principal|architect|staff|head of|engineering manager)\b/i.test(cv) || maxYears >= 6) {
    return 'senior';
  }
  if (/\b(junior|intern|trainee|graduate|entry[- ]?level|fresher|bootcamp)\b/i.test(cv) || maxYears <= 2) {
    return 'junior';
  }
  return 'mid';
}

function stackHints(jdReq) {
  const jd = String(jdReq || '').toLowerCase();
  if (/\.net|asp\.net|c#|ef core|entity framework|linq/i.test(jd)) {
    return 'ASP.NET Core, REST, JWT/OAuth, EF Core, LINQ, middleware, DI';
  }
  if (/node|javascript|typescript|react/i.test(jd)) {
    return 'Node/JS APIs, REST, JWT, async I/O, HTTP';
  }
  if (/python|django|flask|fastapi/i.test(jd)) {
    return 'Python web APIs, REST, auth, ORM, HTTP';
  }
  return 'REST APIs, HTTP, auth, databases, backend fundamentals';
}

function phaseBlueprint(phaseNum, tier, jdReq) {
  const stack = stackHints(jdReq);
  const depth =
    tier === 'senior' ? 'advanced trade-offs and edge cases' : tier === 'junior' ? 'clear fundamentals' : 'solid mid-level reasoning';
  const lanes = {
    2: `Comparative concept from ${stack} — "what is the difference between X and Y?" or "when would you choose X over Y?" (${depth}).`,
    3: `Why / how-it-works — explain the reasoning behind a core idea in ${stack} (e.g. stateless REST, token auth, ORM behavior) (${depth}).`,
    4: `Failure or symptom reasoning — given a realistic symptom, explain likely causes and your diagnostic thinking — no code, no architecture design (${depth}).`,
    5: `Judgment — one conceptual scenario requiring a reasoned choice between options with justification; tie to ${stack} (${depth}).`,
  };
  return lanes[phaseNum] || `Follow-up conceptual probe on ${stack} aligned to prior answers (${depth}).`;
}

const cvText = String(session.cv_plaintext || '').slice(0, 8000);
const experienceTier = inferExperienceTier(cvText);
const jdThemes = extractJdThemes(jdReq).join('\n- ');
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

const questionRules = `ASSESSMENT QUESTION RULES (next_question and first_speech_question):
Written technical assessment — conceptual and logic-based only. Sound like a real interviewer.

Silent personalization (CV + JD internal only):
- Experience level: ${experienceTier}
- Role stack: ${stackHints(jdReq)}
- Pick topics in BOTH JD and CV; do not repeat themes already asked
- Calibrate depth to prior answers

Phase focus for next_question (phase ${nextPhaseNum}):
- ${phaseBlueprint(nextPhaseNum, experienceTier, jdReq)}

Question style (REQUIRED):
- Comparative: "What is the difference between X and Y?"
- Reasoning: "Why do teams use X instead of Y?" / "What problem does X solve?"
- Conceptual scenarios: symptom → explain likely causes (reasoning only)
- One clear question only — no multi-part lists
- Answers may exist online — test understanding and explanation quality, not memorized CV stories

GOOD examples:
- "What is the difference between JWT-based authentication and server-side session cookies, and when would you prefer each?"
- "Why are REST APIs typically stateless, and what problems does that solve?"
- "What is the difference between authentication and authorization?"

STRICTLY FORBIDDEN — never ask:
- Coding: write code, implement, algorithms, syntax, debug this snippet
- Design exercises: design a system/architecture, microservices layout, scalability design
- Implementation recipes: step-by-step how to build or configure something in code
- Generic fluff: "What is OOP?", "Explain REST in one sentence" with no role context
- CV quoting: "on your CV", company names, project titles, "At [Company]…"

BAD: "Design a rate-limited microservices architecture for our platform."
BAD: "Write a C# method to implement pagination."
BAD: "On your CV you used JWT at Acme — tell us about that."`;

const sharedRules = `"""You are an experienced technical interviewer for ${jdTitle}.

You have the job description, the candidate CV (for silent calibration only), and the full Q&A history below. Interview like a real hiring manager.

Each phase (except the last):
- Score the answer to the question asked this phase: 0-100
- Give honest feedback and a concise suggested_answer
- Write next_question: the single best follow-up for phase ${nextPhaseNum}

Final phase:
- Score the answer, then decide PASS or FAIL for the technical round overall

Scoring guidance:
- Do not repeat topics you already covered
- Calibrate difficulty to experience level (${experienceTier}) and prior answers
- Empty, timeout, or [SYSTEM TERMINATION] answers: score 0-15

${questionRules}

Job title: ${jdTitle}
Key JD themes:
- ${jdThemes || jdReq.slice(0, 500)}

Candidate CV (silent calibration — never quote in questions):
${cvText || '(none)'}

Prior Q&A:
${historyText || '(none yet)'}

Topics already asked:
${themesAsked || '(none yet)'}

Tab switches: ${norm.tab_switches || 0}`;

const speechEnabled =
  cfg.speech_enabled === true ||
  cfg.speech_enabled === 'true' ||
  Number(cfg.speech_phases || 0) > 0;

let systemContent;
if (isFinal) {
  const speechHandoff = speechEnabled
    ? `

If speech round is enabled (${cfg.speech_phases} voice questions after technical), also include first_speech_question — a natural spoken behavioral opener for the communication round. Apply the same FORBIDDEN rules (no CV/company names in the question text).`
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
1. Score the answer 0-100 using your judgment.
2. Decide PASS or FAIL for the technical round.
3. feedback + suggested_answer.

Output: {"status":"finished","result":"PASS"|"FAIL","score":number,"feedback":string,"suggested_answer":string,"next_question":""${speechField}}`;
} else {
  systemContent = `${sharedRules}

Current phase: ${ph} of ${maxQ}.
Question asked this phase:
${currentQuestionText || '(see prior Q&A)'}

Answer to grade:
${norm.answer}
${prevTimeLimit != null ? `Previous phase time_limit_seconds: ${prevTimeLimit}` : ''}

Tasks:
1. Score the answer 0-100.
2. feedback + suggested_answer.
3. next_question for phase ${nextPhaseNum} — follow ASSESSMENT QUESTION RULES above.
4. time_limit_seconds (90-600) + complexity_tier (A-D).

Output: {"score":number,"feedback":string,"suggested_answer":string,"next_question":string,"time_limit_seconds":number,"complexity_tier":"A"|"B"|"C"|"D"}`;
}

const body = {
  model: cfg.groq_model || 'llama-3.3-70b-versatile',
  messages: [
    { role: 'system', content: systemContent },
    { role: 'user', content: 'Evaluate and respond with JSON only.' },
  ],
  temperature: isFinal ? 0.25 : 0.55,
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
    },
  },
];

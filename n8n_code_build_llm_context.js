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

function inferYearsFromText(text) {
  const matches = [...String(text || '').matchAll(/(\d+)\+?\s*(?:years?|yrs?)(?:\s+of)?\s*(?:experience|exp)?/gi)];
  let max = 0;
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function detectSeniorityFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(intern|trainee|graduate|entry[\s-]?level|fresher|bootcamp)\b/.test(t)) return 'junior';
  if (/\b(junior|jr\.?)\b/.test(t)) return 'junior';
  if (/\b(associate)\b/.test(t)) return 'mid';
  if (/\b(senior|sr\.?|lead|principal|staff|architect|head|manager|director)\b/.test(t)) return 'senior';
  return 'mid';
}

function yearsToTier(years) {
  if (!Number.isFinite(years) || years <= 0) return null;
  if (years <= 2) return 'junior';
  if (years <= 5) return 'mid';
  return 'senior';
}

function tierRank(tier) {
  if (tier === 'junior') return 1;
  if (tier === 'senior') return 3;
  return 2;
}

function inferCandidateTier(cvText) {
  const cv = String(cvText || '');
  const years = inferYearsFromText(cv);
  const cvTitleTier = detectSeniorityFromTitle(cv);
  const yearTier = yearsToTier(years);
  let tier = cvTitleTier;
  if (yearTier && tierRank(yearTier) > tierRank(tier)) tier = yearTier;
  if (/\b(senior|lead|principal|architect|staff)\b/i.test(cv) && tierRank(tier) < 3) tier = 'senior';
  if (/\b(intern|trainee|fresher|bootcamp)\b/i.test(cv) && tierRank(tier) > 1) tier = 'junior';
  return tier;
}

function resolveTargetTier(jdTitle, jdReq, cvText) {
  const roleTier = detectSeniorityFromTitle(jdTitle);
  const jdYears = Math.max(inferYearsFromText(jdTitle), inferYearsFromText(jdReq));
  const jdTier = yearsToTier(jdYears);
  let targetTier = roleTier;
  if (jdTier && tierRank(jdTier) > tierRank(targetTier)) targetTier = jdTier;
  return {
    targetTier,
    roleTier,
    jdYears,
    candidateTier: inferCandidateTier(cvText),
  };
}

function tierLabel(tier) {
  if (tier === 'junior') return 'Junior / entry-level';
  if (tier === 'senior') return 'Senior / lead';
  return 'Mid-level';
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

function phaseBlueprint(phaseNum, targetTier, jdReq) {
  const stack = stackHints(jdReq);
  const lanes = {
    junior: {
      2: `Fundamentals — one clear comparison from ${stack} (definitions + when to use each).`,
      3: `Why it matters — explain one core concept from ${stack} in plain language.`,
      4: `Light scenario — straightforward symptom in ${stack}; name 2–3 likely causes and how you would check.`,
      5: `Simple judgment — pick between two reasonable options for ${stack} and justify briefly.`,
    },
    mid: {
      2: `Trade-offs — compare two approaches in ${stack}; when would you choose each?`,
      3: `Mechanism — explain how/why something works in ${stack}, not just what it is.`,
      4: `Troubleshooting — realistic symptom in ${stack}; diagnostic reasoning, no code.`,
      5: `Decision — conceptual scenario with constraints; reasoned choice tied to ${stack}.`,
    },
    senior: {
      2: `Advanced trade-offs — nuanced comparison in ${stack} including failure modes or operational impact.`,
      3: `Deep mechanism — inner behavior, pitfalls, or production consequences in ${stack}.`,
      4: `Production incident — ambiguous symptom (load, deploy, intermittent) in ${stack}; prioritized hypotheses.`,
      5: `Strategic judgment — multi-constraint decision for ${stack}; articulate risks of each path.`,
    },
  };
  const set = lanes[targetTier] || lanes.mid;
  return set[phaseNum] || `Follow-up conceptual probe on ${stack} at ${tierLabel(targetTier)} depth.`;
}

function tierCalibrationBlock(cal) {
  const { targetTier, roleTier, jdYears, candidateTier } = cal;
  const timing =
    targetTier === 'junior'
      ? 'Prefer complexity_tier A–B and 90–180s for most questions.'
      : targetTier === 'senior'
        ? 'Prefer complexity_tier C–D and 180–480s when depth warrants it.'
        : 'Prefer complexity_tier B–C and 120–300s for most questions.';
  return `ROLE CALIBRATION (critical — match the job being hired for):
- Target interview level: ${tierLabel(targetTier)} — grade answers against THIS bar
- Role title signals: ${tierLabel(roleTier)}${jdYears ? ` | JD experience hint: ~${jdYears} years` : ''}
- Candidate CV signals (topic selection only, never quote CV): ${tierLabel(candidateTier)}
- Ask questions for a ${tierLabel(targetTier)} hire — not easier because the CV looks junior
- ${timing}
- Pick topics in BOTH JD and CV; if the candidate scored 70+ on the current answer, make the next question slightly harder within the same tier`;
}

function tierExamplesBlock(targetTier, jdReq) {
  const isDotNet = /\.net|asp\.net|c#/i.test(String(jdReq || ''));
  if (targetTier === 'senior') {
    return isDotNet
      ? `GOOD senior examples:
- "After a deploy, some users get intermittent 401s while tokens look valid — what would you investigate first and why?"
- "When would you accept eventual consistency in a read-heavy API, and what user-visible risks must you handle?"
- "EF Core N+1 appeared only under peak traffic — how do you diagnose without defaulting to caching?"`
      : `GOOD senior examples:
- "Intermittent 5xx on one pod after deploy — how do you narrow root cause before rollback?"
- "When is JWT validation at the edge insufficient, and what additional controls would you expect?"`;
  }
  if (targetTier === 'junior') {
    return isDotNet
      ? `GOOD junior examples:
- "What is the difference between authentication and authorization?"
- "Why is dependency injection useful in ASP.NET Core?"
- "What does a 404 status code mean versus a 500?"`
      : `GOOD junior examples:
- "What is the difference between authentication and authorization?"
- "Why are REST APIs often stateless?"`;
  }
  return isDotNet
    ? `GOOD mid-level examples:
- "Cookie-based session auth vs JWT for an API — what are the main trade-offs?"
- "Why might you use no-tracking queries in EF Core, and what trade-off are you accepting?"
- "An endpoint returns 500 only under load — what causes would you consider first?"`
    : `GOOD mid-level examples:
- "Token-based auth vs server-side sessions — main trade-offs for a public API?"
- "An API is slow only at peak traffic — what would you check first?"`;
}

const cvText = String(session.cv_plaintext || '').slice(0, 8000);
const levelCal = resolveTargetTier(jdTitle, jdReq, cvText);
const targetTier = levelCal.targetTier;
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

${tierCalibrationBlock(levelCal)}

Phase focus for next_question (phase ${nextPhaseNum}):
- ${phaseBlueprint(nextPhaseNum, targetTier, jdReq)}

Question style (REQUIRED):
- Comparative: "What is the difference between X and Y?"
- Reasoning: "Why do teams use X instead of Y?" / "What problem does X solve?"
- Conceptual scenarios: symptom → explain likely causes (reasoning only)
- One clear question only — no multi-part lists
- Answers may exist online — test understanding and explanation quality, not memorized CV stories
- Difficulty must match ${tierLabel(targetTier)} expectations for ${jdTitle}

${tierExamplesBlock(targetTier, jdReq)}

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
- Grade against ${tierLabel(targetTier)} expectations for ${jdTitle}
- Do not repeat topics you already covered
- If the answer is strong (75+), the next question should probe deeper within the same tier
- If the answer is weak (<40), you may re-probe the same topic with a narrower angle — do not drop below role level
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

OUTPUT RULES (critical): Return ONE valid JSON object and nothing else — no markdown, no prose, no code fences. Keep feedback to 1-2 sentences and suggested_answer to 2-3 sentences so the JSON stays small and complete. Escape any quotes inside strings.

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

OUTPUT RULES (critical): Return ONE valid JSON object and nothing else — no markdown, no prose, no code fences. Keep feedback to 1-2 sentences and suggested_answer to 2-3 sentences so the JSON stays small and complete. Put score and feedback first. Escape any quotes inside strings.

Output: {"score":number,"feedback":string,"suggested_answer":string,"next_question":string,"time_limit_seconds":number,"complexity_tier":"A"|"B"|"C"|"D"}`;
}

const body = {
  model: cfg.groq_model || 'llama-3.3-70b-versatile',
  messages: [
    { role: 'system', content: systemContent },
    { role: 'user', content: 'Evaluate and respond with JSON only.' },
  ],
  temperature: isFinal ? 0.25 : 0.55,
  max_tokens: Number(cfg.assessment_max_tokens || 1400),
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
      assessment_level: targetTier,
    },
  },
];

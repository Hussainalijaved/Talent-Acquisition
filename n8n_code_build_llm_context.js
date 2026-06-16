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

function phaseBlueprint(phaseNum, tier) {
  const blueprints = {
    2: {
      junior: 'Hands-on implementation — a practical scenario using a core stack skill from the JD (build, validate, handle errors).',
      mid: 'Real-world implementation — extend or harden something similar to what this role ships (API, service, data flow, or UI layer).',
      senior: 'Production implementation — design and defend how you would build or refactor a non-trivial feature with quality and operability in mind.',
    },
    3: {
      junior: 'Debugging basics — trace a concrete bug or failure (logs, exceptions, wrong output) and explain your fix.',
      mid: 'Troubleshooting under load — diagnose slow, flaky, or intermittent production issues and prioritize fixes.',
      senior: 'Incident response — root-cause a complex outage or regression; discuss mitigation, rollback, and prevention.',
    },
    4: {
      junior: 'Structured thinking — break a small feature into components, data flow, and testing approach.',
      mid: 'Design trade-offs — compare two reasonable approaches for a feature this role owns (scalability, maintainability, cost).',
      senior: 'Architecture — multi-service or multi-tenant design, boundaries, auth, versioning, or cross-team contracts.',
    },
    5: {
      junior: 'Ownership and learning — how you verify your work, handle feedback, and grow into the role.',
      mid: 'Production readiness — deployment, monitoring, tech debt, and balancing speed vs quality on real delivery.',
      senior: 'Strategic depth — long-term maintainability, team standards, risk, and mentoring others on technical decisions.',
    },
  };
  const row = blueprints[phaseNum];
  if (!row) return 'Follow-up depth probe aligned to the role and prior answers.';
  return row[tier] || row.mid;
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
You are conducting a real company software assessment — questions must sound like a live interviewer, not an AI reading a CV.

Silent personalization (use CV + JD internally only):
- Inferred experience level: ${experienceTier}
- Pick topics/skills that appear in BOTH the JD and CV (or a critical JD gap worth probing)
- Raise or lower depth based on how they answered prior phases — do not repeat topics already asked

Phase focus for next_question:
- ${phaseBlueprint(nextPhaseNum, experienceTier)}

Question style:
- Scenario-based, practical wording: "Walk me through…", "How would you…", "Describe how you would…", "A production system is…"
- One clear question only — no multi-part laundry lists
- Match complexity_tier A-D to the inferred level and phase depth
- Do NOT ask generic textbook definitions ("What is OOP?", "Explain REST in general")

FORBIDDEN in next_question / first_speech_question text (never include):
- "on your CV", "your CV", "you listed", "you mentioned", "according to your resume"
- Company names, employer names, university names, or project titles copied from the CV
- "In your role at…", "At [Company]…", "On the [Project]…"
The candidate must not feel the question was generated from a document.

GOOD: "A production API is returning slow responses under load. How would you diagnose the issue and what would you change first?"
BAD: "On your CV you built REST APIs at Acme Corp — tell me about that."`;

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

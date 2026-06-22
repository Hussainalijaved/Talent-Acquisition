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

function detectRoleDomain(jdTitle, jdReq) {
  const title = String(jdTitle || '').toLowerCase();
  const jd = String(jdReq || '').toLowerCase();
  const titleFullStack = /\bfull[\s-]?stack\b/.test(title);
  const titleFrontend =
    /\b(frontend|front-end|front end|ui developer|ui engineer|ux engineer|react developer|angular developer|vue developer)\b/.test(
      title
    );
  const titleBackend =
    /\b(backend|back-end|back end|api developer|\.net developer|dotnet developer|node developer|java developer|python developer)\b/.test(
      title
    );
  if (titleFullStack) {
    return {
      domain: 'fullstack',
      guidance:
        'Balance frontend UI and backend/API concepts per JD emphasis — do not default to generic REST API architecture.',
    };
  }
  if (titleFrontend && !titleBackend) {
    return {
      domain: 'frontend',
      guidance:
        'Prioritize frontend core concepts (HTML/CSS, JS, React/Vue/Angular, state, responsive design, Vite, Tailwind/Bootstrap, performance, frontend auth). Do NOT ask backend-only API architecture unless the JD requires it.',
    };
  }
  if (titleBackend && !titleFrontend) {
    return {
      domain: 'backend',
      guidance:
        'Prioritize backend/API concepts from the JD stack and CV overlap (e.g. CQRS, DI, EF Core, JWT — when relevant to the JD).',
    };
  }
  if (/react|angular|vue|tailwind|vite|bootstrap|html|css|frontend/i.test(jd) && !/\.net|asp\.net|microservices|ef core/i.test(jd)) {
    return { domain: 'frontend', guidance: 'JD is frontend-heavy — prioritize UI and component concepts over generic API design.' };
  }
  if (/\.net|asp\.net|c#|ef core/i.test(jd)) {
    return { domain: 'backend', guidance: 'Prioritize .NET concepts named in the JD and evidenced on the CV.' };
  }
  return { domain: 'general', guidance: 'Derive topics from JD title and requirements — match the role being hired.' };
}

function extractSkillSignals(text) {
  const raw = String(text || '');
  const re =
    /\b(CQRS|MediatR|DDD|Clean Architecture|microservices?|ASP\.NET Core|\.NET|C#|EF Core|Entity Framework|LINQ|React|Redux|Context API|Angular|Vue|TypeScript|JavaScript|HTML5?|CSS3?|Tailwind|Bootstrap|Vite|Webpack|JWT|OAuth|Docker|Kubernetes|Azure|AWS|REST(?:ful)?(?: APIs?)?|GraphQL|Node\.?js|Python|Django|Flask|FastAPI|Middleware|Dependency Injection|DI|IQueryable|IEnumerable|Hooks?|useState|useEffect|Component Lifecycle|Responsive Design|State Management|CORS|SSR|SPA|Async\/await|XSS|HttpOnly|LocalStorage|API Gateway|SOLID|OOP|ORM|Idempotency|Serilog|BCrypt|SSO|n8n|CI\/CD)\b/gi;
  const seen = new Set();
  const out = [];
  for (const m of raw.matchAll(re)) {
    const norm = m[0].replace(/\s+/g, ' ').trim();
    const key = norm.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(norm);
    }
  }
  return out.slice(0, 20);
}

function jdCvTopicAnchors(jdTitle, jdReq, cvText) {
  const jdSkills = extractSkillSignals(`${jdTitle}\n${jdReq}`);
  const cvSkills = extractSkillSignals(cvText);
  const jdKeys = new Set(jdSkills.map((s) => s.toLowerCase()));
  const overlap = cvSkills.filter((s) => jdKeys.has(s.toLowerCase()));
  const jdOnly = jdSkills.filter((s) => !overlap.some((o) => o.toLowerCase() === s.toLowerCase()));
  const cvOnly = cvSkills.filter((s) => !jdKeys.has(s.toLowerCase())).slice(0, 8);
  return { overlap, jdOnly, cvOnly };
}

function tierCalibrationBlock(cal, jdTitle) {
  const { targetTier, roleTier, jdYears, candidateTier } = cal;
  const timing =
    targetTier === 'junior'
      ? 'Prefer complexity_tier A–B and 90–180s for most questions.'
      : targetTier === 'senior'
        ? 'Prefer complexity_tier C–D and 180–480s when depth warrants it.'
        : 'Prefer complexity_tier B–C and 120–300s for most questions.';
  return `ROLE CALIBRATION (critical — questions must match the job being hired for):
- Target interview level: ${tierLabel(targetTier)} — grade answers against THIS bar
- Role title signals: ${tierLabel(roleTier)}${jdYears ? ` | JD experience hint: ~${jdYears} years` : ''}
- Candidate CV signals (topic anchors only, never quote CV): ${tierLabel(candidateTier)}
- Ask questions for a ${tierLabel(targetTier)} ${jdTitle} — not easier because the CV looks junior
- ${timing}
- Never repeat a topic already asked; if the candidate scored 70+, probe deeper within the same tier`;
}

function topicSelectionRules(jdTitle, jdReq, cvText, targetTier) {
  const domain = detectRoleDomain(jdTitle, jdReq);
  const anchors = jdCvTopicAnchors(jdTitle, jdReq, cvText);
  const overlapLine = anchors.overlap.length ? anchors.overlap.join(', ') : '(derive from JD + CV text)';
  const jdLine = anchors.jdOnly.length ? anchors.jdOnly.join(', ') : '(read JD responsibilities)';
  const cvLine = anchors.cvOnly.length ? anchors.cvOnly.join(', ') : '(read CV skills)';

  return `TOPIC SELECTION (dynamic — derive each question; never use a generic fixed API list):

ROLE DOMAIN: ${domain.domain} — ${domain.guidance}

Step 1 — From the JD for "${jdTitle}", identify core skills, responsibilities, and stack technologies. Job title is the primary compass.

Step 2 — From the CV, identify topic anchors silently (e.g. CQRS on CV + .NET in JD → CQRS core-concept question; Redux on CV + Frontend JD → state management — NOT REST statelessness).

Step 3 — Skill hints (optional — infer more from full JD/CV):
- JD emphasis: ${jdLine}
- CV+JD overlap (prefer these): ${overlapLine}
- CV-only (if still relevant to ${jdTitle}): ${cvLine}

Step 4 — Each question must satisfy: (a) required by JD for ${jdTitle} at ${tierLabel(targetTier)} depth, (b) ideally validated by CV overlap, (c) not already asked, (d) conceptual not coding.

Step 5 — Frame with compare / why / difference / explain-how / trade-off patterns — vary across phases.`;
}

function questionStylePatterns(jdTitle, targetTier) {
  const depth =
    targetTier === 'junior'
      ? 'Accessible language; one clear concept.'
      : targetTier === 'senior'
        ? 'Nuanced trade-offs and production judgment.'
        : 'Reasoning beyond definitions — when/why, not just what.';
  return `QUESTION STYLE (${depth})
- One question only; sound like a hiring manager for ${jdTitle}
- Patterns (generate fresh wording — substitute X/Y from JD+CV):
  - "What is the difference between X and Y in [this role]?"
  - "Why is X used when building [JD stack]? What problem does it solve?"
  - "How does [CV skill] relate to [JD responsibility] conceptually?"`;
}

function phaseBlueprintDynamic(phaseNum, targetTier, jdTitle) {
  const lanes = {
    junior: {
      2: 'Core concept — JD+CV overlap comparison or definition.',
      3: 'Core concept — explain WHY or HOW one JD-relevant idea works.',
      4: 'Applied reasoning — light scenario in the JD stack.',
      5: 'Judgment — two JD-relevant options; justify choice.',
    },
    mid: {
      2: 'Compare two related JD concepts — when to use each.',
      3: 'Mechanism or trade-off for a JD/CV-overlap topic.',
      4: 'Applied reasoning — realistic symptom in the JD domain.',
      5: 'Multi-factor judgment with trade-offs.',
    },
    senior: {
      2: 'Advanced trade-offs on a JD-critical topic.',
      3: 'Deep mechanism — pitfalls or production consequences.',
      4: 'Production-style incident — prioritized hypotheses.',
      5: 'Strategic judgment — risks of each path.',
    },
  };
  const set = lanes[targetTier] || lanes.mid;
  return set[phaseNum] || `Core concept follow-up for ${jdTitle} at ${tierLabel(targetTier)} depth.`;
}

function forbiddenQuestionRules(jdTitle) {
  return `STRICTLY FORBIDDEN:
- Coding, algorithms, system design exercises, step-by-step implementation recipes
- Off-role topics for ${jdTitle} (e.g. REST statelessness for pure Frontend UI role)
- CV quoting: company names, "on your CV", project titles
- Generic trivia unrelated to THIS JD and CV overlap`;
}

function buildAssessmentQuestionRules({ jdTitle, jdReq, cvText, targetTier, levelCal, nextPhaseNum, maxQ }) {
  return `ASSESSMENT QUESTION RULES (next_question):
Written technical assessment — conceptual only.

${tierCalibrationBlock(levelCal, jdTitle)}

${topicSelectionRules(jdTitle, jdReq, cvText, targetTier)}

WRITTEN MIX (${maxQ} phases): At least 3 core-concept phases (compare/why/how) before heavier scenarios in 4–5.
Every question must pass: "Would a hiring manager for ${jdTitle} ask this?"

Phase focus (phase ${nextPhaseNum}): ${phaseBlueprintDynamic(nextPhaseNum, targetTier, jdTitle)}

${questionStylePatterns(jdTitle, targetTier)}

${forbiddenQuestionRules(jdTitle)}`;
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

const questionRules = buildAssessmentQuestionRules({
  jdTitle,
  jdReq,
  cvText,
  targetTier,
  levelCal,
  nextPhaseNum,
  maxQ,
});

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

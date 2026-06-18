// n8n: CV Screening — Phase 1 prompt + Groq request body
// Paste into: Gemini - CV screening agent (request body)
// Workflow: Talent Acquisition — CV Screening  OR  CV Screening (Threaded Mail)

const row = $input.first().json;
const jdTitle = row.config?.requisition_title;
const jdMust = row.config?.requisition_requirements;
if (!jdTitle || !jdMust) {
  throw new Error('Screening blocked: JD must come from recruiter form (CODE - Frontend intake).');
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

function resolveTargetTier(title, jdReq, cvText) {
  const roleTier = detectSeniorityFromTitle(title);
  const jdYears = Math.max(inferYearsFromText(title), inferYearsFromText(jdReq));
  const jdTier = yearsToTier(jdYears);
  let targetTier = roleTier;
  if (jdTier && tierRank(jdTier) > tierRank(targetTier)) targetTier = jdTier;
  return { targetTier, roleTier, jdYears, candidateTier: inferCandidateTier(cvText) };
}

function tierLabel(tier) {
  if (tier === 'junior') return 'Junior / entry-level';
  if (tier === 'senior') return 'Senior / lead';
  return 'Mid-level';
}

function stackHints(jdReq) {
  const jd = String(jdReq || '').toLowerCase();
  if (/\.net|asp\.net|c#|ef core|entity framework|linq/i.test(jd)) {
    return 'ASP.NET Core, REST APIs, JWT/OAuth, EF Core, LINQ, middleware, dependency injection';
  }
  if (/node|javascript|typescript|react/i.test(jd)) {
    return 'Node/JS APIs, REST, JWT, async I/O, HTTP semantics';
  }
  if (/python|django|flask|fastapi/i.test(jd)) {
    return 'Python web APIs, REST, auth, ORM basics, HTTP';
  }
  return 'REST APIs, HTTP, authentication, databases, backend fundamentals';
}

const stack = stackHints(jdMust);
const cvText = String(row.cv_plaintext || '');
const levelCal = resolveTargetTier(jdTitle, jdMust, cvText);
const targetTier = levelCal.targetTier;

const tierDepth =
  targetTier === 'senior'
    ? 'Ask a challenging conceptual or trade-off question with production nuance — not trivia, not system design.'
    : targetTier === 'junior'
      ? 'Ask a clear fundamentals question — definitions, simple comparisons, or why a core idea matters.'
      : 'Ask a trade-off or reasoning question — compare approaches or explain how/why something works.';

const tierTiming =
  targetTier === 'senior'
    ? 'phase_1_complexity_tier: usually C or D; phase_1_time_limit_seconds: 180–420'
    : targetTier === 'junior'
      ? 'phase_1_complexity_tier: usually A or B; phase_1_time_limit_seconds: 90–180'
      : 'phase_1_complexity_tier: usually B or C; phase_1_time_limit_seconds: 120–300';

const systemText = [
  'You are a senior technical interviewer for a written assessment.',
  'Read the job specification and candidate CV in the user message.',
  '',
  `ROLE LEVEL (critical): This interview is for a ${tierLabel(targetTier)} position (${jdTitle}).`,
  `Phase 1 difficulty must match ${tierLabel(targetTier)} expectations — not the candidate's background alone.`,
  `- Role signals: ${tierLabel(levelCal.roleTier)}${levelCal.jdYears ? ` (~${levelCal.jdYears} years in JD)` : ''}`,
  `- CV signals (topic selection only): ${tierLabel(levelCal.candidateTier)}`,
  tierDepth,
  '',
  'PHASE 1 QUESTION — must be ONE conceptual/logic question grounded in the role stack:',
  `- Role stack focus: ${stack}`,
  '- Ask comparative, "why", or "what is the difference" questions that test understanding.',
  '- Pick a topic that matches BOTH the JD requirements and skills evidenced on the CV (silent — never quote CV).',
  '- Answers may exist online — test reasoning and clarity, not obscure trivia.',
  tierTiming,
  '',
  'STRICTLY FORBIDDEN in phase_1_question:',
  '- Coding: write code, implement, algorithms, syntax, debug snippets',
  '- Design exercises: design a system/architecture, microservices layout, scalability design',
  '- Step-by-step implementation recipes ("how to build/deploy/configure X in 10 steps")',
  '- CV quoting: "on your CV", company names, university, project titles',
  '',
  'Output JSON only:',
  '- score (0-100 role-fit vs job spec)',
  '- recommendation: SHORTLIST | REJECT | REVIEW',
  '- assessment_status: IN_PROGRESS',
  '- summary: brief screening note',
  '- phase_1_question: one interview question at the correct role level (empty string if REJECT)',
  '- phase_1_time_limit_seconds: sensible seconds for that question (90-600)',
  '- phase_1_complexity_tier: A | B | C | D',
  '- assessment_level: "junior" | "mid" | "senior"',
].join('\n');

const phases = row.config?.max_questions ?? 5;
const userText = [
  `Job specification title: ${jdTitle}`,
  `Target assessment level: ${targetTier}`,
  `Requirements: ${jdMust}`,
  row.requisition_id ? `Submission ref: ${row.requisition_id}` : '',
  `Sequential assessment: ${phases} written phases total; you are issuing Phase 1 only.`,
  '',
  'Candidate CV:',
  cvText,
].join('\n');

const body = {
  model: row.config?.groq_model || 'llama-3.3-70b-versatile',
  messages: [
    { role: 'system', content: systemText },
    { role: 'user', content: userText },
  ],
  temperature: 0.35,
  response_format: { type: 'json_object' },
};

return [{ json: { ...row, groq_cv_screening_request: body, assessment_level: targetTier } }];

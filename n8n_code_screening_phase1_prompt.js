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

function detectRoleDomain(jdTitle, jdReq) {
  const title = String(jdTitle || '').toLowerCase();
  const jd = String(jdReq || '').toLowerCase();
  const titleFrontend =
    /\b(frontend|front-end|front end|ui developer|react developer|angular developer|vue developer)\b/.test(title);
  const titleBackend =
    /\b(backend|back-end|api developer|\.net developer|dotnet developer|node developer)\b/.test(title);
  if (/\bfull[\s-]?stack\b/.test(title)) {
    return { domain: 'fullstack', guidance: 'Balance frontend and backend concepts per JD emphasis.' };
  }
  if (titleFrontend && !titleBackend) {
    return {
      domain: 'frontend',
      guidance:
        'Prioritize React/HTML/CSS/state/Vite/Tailwind/responsive UI/frontend performance. Do NOT ask REST API statelessness or backend middleware for a frontend role.',
    };
  }
  if (titleBackend && !titleFrontend) {
    return {
      domain: 'backend',
      guidance: 'Prioritize JD backend stack and CV-overlap patterns (e.g. CQRS, DI, EF Core, JWT when relevant).',
    };
  }
  if (/react|tailwind|vite|bootstrap|frontend/i.test(jd) && !/\.net|ef core|microservices/i.test(jd)) {
    return { domain: 'frontend', guidance: 'JD is frontend-heavy.' };
  }
  return { domain: 'general', guidance: 'Derive topics from JD title and requirements.' };
}

function extractSkillSignals(text) {
  const re =
    /\b(CQRS|MediatR|DDD|Clean Architecture|microservices?|ASP\.NET Core|\.NET|C#|EF Core|React|Redux|Angular|Vue|TypeScript|JavaScript|HTML|CSS|Tailwind|Bootstrap|Vite|JWT|OAuth|Docker|Azure|REST(?:ful)?|GraphQL|Node\.?js|Python|Middleware|Dependency Injection|DI|State Management|Component Lifecycle|Responsive Design|Hooks?|useState|CORS|SPA|Async\/await|n8n|CI\/CD|LINQ|IQueryable|API Gateway|Serilog|BCrypt|SSO)\b/gi;
  const seen = new Set();
  const out = [];
  for (const m of String(text || '').matchAll(re)) {
    const norm = m[0].trim();
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

function topicSelectionRules(jdTitle, jdReq, cvText, targetTier) {
  const domain = detectRoleDomain(jdTitle, jdReq);
  const anchors = jdCvTopicAnchors(jdTitle, jdReq, cvText);
  return `TOPIC SELECTION (dynamic — derive the question; never pick from a generic API list):

ROLE DOMAIN: ${domain.domain} — ${domain.guidance}

1. Read the JD for "${jdTitle}" — identify core skills, responsibilities, and stack. Job title is the compass.
2. Read the CV — use skills/patterns as TOPIC ANCHORS only (e.g. CV has CQRS + JD is .NET → ask what CQRS solves or how it differs from layered architecture; CV has React + JD is Frontend → state/components — NOT unrelated REST statelessness).
3. Skill hints: JD emphasis [${anchors.jdOnly.slice(0, 8).join(', ') || 'read JD'}] | CV+JD overlap [${anchors.overlap.slice(0, 8).join(', ') || 'derive overlap'}] | CV-only if relevant [${anchors.cvOnly.slice(0, 6).join(', ') || 'read CV'}]
4. Pick ONE concept at ${tierLabel(targetTier)} depth that fits the JD AND ideally CV overlap.
5. Frame as compare / why / difference / explain-how — one clear question only.`;
}

function buildScreeningPhase1Rules(jdTitle, jdReq, cvText, targetTier, levelCal) {
  const domain = detectRoleDomain(jdTitle, jdReq);
  const tierDepth =
    targetTier === 'senior'
      ? 'Challenging conceptual or trade-off — production nuance, not system design.'
      : targetTier === 'junior'
        ? 'Clear fundamentals — comparison, definition, or why a core JD idea matters.'
        : 'Trade-off or reasoning — compare approaches for this role.';

  const tierTiming =
    targetTier === 'senior'
      ? 'phase_1_complexity_tier: usually C or D; phase_1_time_limit_seconds: 180–420'
      : targetTier === 'junior'
        ? 'phase_1_complexity_tier: usually A or B; phase_1_time_limit_seconds: 90–180'
        : 'phase_1_complexity_tier: usually B or C; phase_1_time_limit_seconds: 120–300';

  return [
    'You are a senior technical interviewer for a written assessment.',
    'Read the job specification and candidate CV in the user message.',
    '',
    `ROLE LEVEL: ${tierLabel(targetTier)} position (${jdTitle}).`,
    `- Role signals: ${tierLabel(levelCal.roleTier)}${levelCal.jdYears ? ` (~${levelCal.jdYears} years in JD)` : ''}`,
    `- CV signals (anchors only): ${tierLabel(levelCal.candidateTier)}`,
    `- Domain: ${domain.domain} — ${domain.guidance}`,
    tierDepth,
    '',
    topicSelectionRules(jdTitle, jdReq, cvText, targetTier),
    '',
    'PHASE 1 — output exactly ONE core concept question derived from JD+CV (never hardcoded generic API trivia).',
    tierTiming,
    '',
    'FORBIDDEN: coding, system design, implementation recipes, CV quoting, off-role topics for this job title.',
    '',
    'Output JSON only:',
    '- score (0-100 role-fit vs job spec)',
    '- recommendation: SHORTLIST | REJECT | REVIEW',
    '- assessment_status: IN_PROGRESS',
    '- summary: brief screening note',
    '- phase_1_question: one question (empty if REJECT)',
    '- phase_1_time_limit_seconds: 90-600',
    '- phase_1_complexity_tier: A | B | C | D',
    '- assessment_level: "junior" | "mid" | "senior"',
  ].join('\n');
}

const cvText = String(row.cv_plaintext || '');
const levelCal = resolveTargetTier(jdTitle, jdMust, cvText);
const targetTier = levelCal.targetTier;
const systemText = buildScreeningPhase1Rules(jdTitle, jdMust, cvText, targetTier, levelCal);

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

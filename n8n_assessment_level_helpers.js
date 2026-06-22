// Shared assessment level helpers — keep in sync across:
// n8n_code_build_llm_context.js, n8n_code_screening_phase1_prompt.js,
// n8n_code_parse_assessment_result.js, n8n_code_parse_technical_result.js, api/manual-shortlist.js

function detectSeniorityFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(intern|trainee|graduate|entry[\s-]?level|fresher|bootcamp)\b/.test(t)) return 'junior';
  if (/\b(junior|jr\.?)\b/.test(t)) return 'junior';
  if (/\b(associate)\b/.test(t)) return 'mid';
  if (/\b(senior|sr\.?|lead|principal|staff|architect|head|manager|director)\b/.test(t)) return 'senior';
  return 'mid';
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
  const candidateTier = inferCandidateTier(cvText);
  return { targetTier, roleTier, jdYears, candidateTier };
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
        'Balance frontend UI concepts and backend/API concepts according to what the JD emphasizes most. Do not default to generic REST API architecture unless the JD requires it.',
    };
  }
  if (titleFrontend && !titleBackend) {
    return {
      domain: 'frontend',
      guidance:
        'Prioritize frontend core concepts: HTML/CSS, JavaScript, React/Vue/Angular, component model, state management, responsive design, performance (load/render), build tools (Vite/Webpack), CSS frameworks (Tailwind/Bootstrap), browser compatibility, and frontend security (tokens, XSS). Do NOT ask backend-only topics (REST statelessness, API middleware pipelines, EF Core, CQRS) unless the JD explicitly requires backend/API ownership.',
    };
  }
  if (titleBackend && !titleFrontend) {
    return {
      domain: 'backend',
      guidance:
        'Prioritize backend/API core concepts from the JD stack: services, data access, auth, HTTP semantics, patterns named in the JD (e.g. CQRS, DI, middleware), and integration — framed for the specific technologies in the JD.',
    };
  }
  if (/\.net|asp\.net|c#|ef core|entity framework/i.test(jd)) {
    return {
      domain: 'backend',
      guidance: 'Prioritize .NET / ASP.NET Core concepts named in the JD and evidenced on the CV.',
    };
  }
  if (/react|angular|vue|tailwind|vite|bootstrap|html|css|frontend/i.test(jd) && !/\.net|asp\.net|microservices|ef core/i.test(jd)) {
    return {
      domain: 'frontend',
      guidance: 'JD reads as frontend-heavy — prioritize UI, components, state, styling, and frontend performance over generic API design.',
    };
  }
  if (/node|express|fastify|nest/i.test(jd)) {
    return {
      domain: 'backend',
      guidance: 'Prioritize Node/API concepts from the JD and CV overlap.',
    };
  }
  if (/python|django|flask|fastapi/i.test(jd)) {
    return {
      domain: 'backend',
      guidance: 'Prioritize Python web/API concepts from the JD and CV overlap.',
    };
  }
  return {
    domain: 'general',
    guidance: 'Derive topics from the JD title, responsibilities, and requirements — match the role being hired, not a generic interview template.',
  };
}

function extractSkillSignals(text) {
  const raw = String(text || '');
  const re =
    /\b(CQRS|MediatR|DDD|Clean Architecture|microservices?|ASP\.NET Core|\.NET|C#|EF Core|Entity Framework|LINQ|React|Redux|Context API|Angular|Vue|TypeScript|JavaScript|HTML5?|CSS3?|Tailwind|Bootstrap|Vite|Webpack|Sass|JWT|OAuth|Refresh Tokens?|RBAC|Docker|Kubernetes|Azure|AWS|Redis|Kafka|REST(?:ful)?(?: APIs?)?|GraphQL|Node\.?js|Express|Fastify|Python|Django|Flask|FastAPI|SQL Server|PostgreSQL|MySQL|MongoDB|Firebase|Git|CI\/CD|GitHub Actions|n8n|Middleware|Dependency Injection|DI|IQueryable|IEnumerable|WebSocket|CORS|SSR|SSG|SPA|Hooks?|useState|useEffect|Component Lifecycle|Responsive Design|Cross-browser|State Management|Figma|Swagger|xUnit|Unit Testing|Serilog|BCrypt|SSO|BFF|API Gateway|Clean Code|SOLID|OOP|LINQ|ORM|Migration|No-tracking|Change Tracking|Pagination|Idempotency|Async\/await|Event Loop|Web Security|XSS|CSRF|HttpOnly|LocalStorage|SessionStorage)\b/gi;
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
  return { overlap, jdOnly, cvOnly, jdSkills, cvSkills };
}

function tierCalibrationBlock(cal, jdTitle) {
  const { targetTier, roleTier, jdYears, candidateTier } = cal;
  const timing =
    targetTier === 'junior'
      ? 'Prefer complexity_tier A–B and 90–180s for most questions.'
      : targetTier === 'senior'
        ? 'Prefer complexity_tier C–D and 180–480s when the question warrants depth.'
        : 'Prefer complexity_tier B–C and 120–300s for most questions.';

  return `ROLE CALIBRATION (critical — questions must match the job being hired for):
- Target interview level: ${tierLabel(targetTier)} (grade answers against THIS bar)
- Role title signals: ${tierLabel(roleTier)}${jdYears ? ` | JD experience hint: ~${jdYears} years` : ''}
- Candidate CV signals (topic anchors only, never quote CV): ${tierLabel(candidateTier)}
- Always ask questions appropriate for a ${tierLabel(targetTier)} ${jdTitle} — not easier because the CV looks junior, not harder trivia unrelated to the role
- ${timing}
- Increase difficulty across phases when the candidate scores well (70+); never repeat a topic already asked`;
}

function topicSelectionRules(jdTitle, jdReq, cvText, targetTier) {
  const domain = detectRoleDomain(jdTitle, jdReq);
  const anchors = jdCvTopicAnchors(jdTitle, jdReq, cvText);
  const overlapLine = anchors.overlap.length
    ? anchors.overlap.join(', ')
    : '(derive overlap by reading JD + CV — no obvious keyword overlap detected)';
  const jdLine = anchors.jdOnly.length ? anchors.jdOnly.join(', ') : '(read JD responsibilities and requirements)';
  const cvLine = anchors.cvOnly.length
    ? anchors.cvOnly.join(', ')
    : '(read CV skills and experience sections)';

  return `TOPIC SELECTION (dynamic — you MUST derive each question; never pick from a generic fixed list):

ROLE DOMAIN: ${domain.domain} — ${domain.guidance}

Step 1 — Read the JD for "${jdTitle}" and identify 5–8 core skills, responsibilities, and technologies that define THIS role. The job title is the primary compass (Frontend Developer → UI/React/CSS/state; Backend .NET → services/APIs/patterns in JD).

Step 2 — Read the CV silently. Treat listed skills and patterns as TOPIC ANCHORS (e.g. if CV mentions CQRS, you may ask what problem CQRS solves or how it differs from a traditional layered approach — but ONLY if CQRS or similar patterns are relevant to the JD or the role's backend scope). Never quote company names, project titles, or "on your CV".

Step 3 — Skill signals (hints only — you may use other concepts you infer from JD/CV text):
- JD-required / emphasized: ${jdLine}
- CV-evidenced (overlap with JD preferred): ${overlapLine}
- CV-only (use only if still relevant to ${jdTitle}): ${cvLine}

Step 4 — For each new question, choose ONE concept that satisfies ALL:
  a) Required or strongly implied by the JD for ${jdTitle} at ${tierLabel(targetTier)} depth
  b) Best validated by CV overlap when possible — if CV shows CQRS and JD is .NET backend, a CQRS core-concept question is ideal; if JD is Frontend React and CV shows Redux, ask about state management — NOT unrelated API architecture
  c) NOT already asked in a prior phase
  d) Appropriate for written conceptual assessment (understanding, not coding)

Step 5 — Frame using ONE of these patterns (vary across phases):
  - Compare: "What is the difference between X and Y, and when would you choose each in [this role]?"
  - Why: "Why do teams use X when building [JD stack]? What problem does it solve?"
  - Mechanism: "Explain how X works conceptually in [JD context]."
  - Trade-off (mid/senior): "What are the trade-offs between X and Y for [JD scenario]?"
  - Light scenario (later phases): "If [symptom] when working on [JD stack], what are 2–3 likely causes and how would you narrow them?"`;
}

function questionStylePatterns(jdTitle, targetTier) {
  const depth =
    targetTier === 'junior'
      ? 'Keep language accessible; one clear concept; avoid production war stories.'
      : targetTier === 'senior'
        ? 'Expect nuance, trade-offs, failure modes, and production judgment.'
        : 'Expect reasoning beyond definitions — when/why, not just what.';

  return `QUESTION STYLE (patterns only — generate fresh wording every time):
- ${depth}
- One question only — no multi-part lists
- Sound like a real hiring manager for ${jdTitle}
- Test explanation quality and reasoning; answers may exist online
- Prefer "difference between", "why use", "what problem does X solve", "when would you choose" over yes/no

Pattern examples (DO NOT copy verbatim — substitute X/Y from JD+CV):
  - "What is the difference between [concept A from JD] and [concept B from JD], and when would you pick each?"
  - "Why is [JD technology/pattern] used in [role context]? What would break without it?"
  - "How does [CV-evidenced skill] relate to [JD responsibility] — explain at a conceptual level."
  - "What are the trade-offs between [approach X] and [approach Y] for a ${jdTitle}?"`;
}

function phaseBlueprintDynamic(phaseNum, targetTier, jdTitle) {
  const lanes = {
    junior: {
      2: 'Core concept — comparison or definition from JD+CV overlap at fundamentals depth.',
      3: 'Core concept — explain WHY or HOW one JD-relevant idea works; plain language, no code.',
      4: 'Applied reasoning — light scenario using the JD stack; 2–3 causes/checks, no code.',
      5: 'Judgment — choose between two reasonable JD-relevant options and justify briefly.',
    },
    mid: {
      2: 'Core concept — compare two related JD concepts; when to use each in this role.',
      3: 'Core concept — mechanism or trade-off for a JD/CV-overlap topic.',
      4: 'Applied reasoning — realistic symptom in the JD stack; diagnostic thinking.',
      5: 'Judgment — multi-factor decision using JD fundamentals; articulate trade-offs.',
    },
    senior: {
      2: 'Advanced trade-offs on a JD-critical topic; include failure modes or ops impact where relevant.',
      3: 'Deep mechanism — inner behavior, pitfalls, or production consequences for a JD pattern.',
      4: 'Applied reasoning — production-style incident in the JD domain; prioritized hypotheses.',
      5: 'Strategic judgment — multi-constraint decision; risks of each path.',
    },
  };
  const set = lanes[targetTier] || lanes.mid;
  return (
    set[phaseNum] ||
    `Core concept follow-up grounded in ${jdTitle} JD + CV overlap at ${tierLabel(targetTier)} depth.`
  );
}

function forbiddenQuestionRules(jdTitle) {
  return `STRICTLY FORBIDDEN — never ask:
- Coding: write code, implement, algorithms, syntax, debug this snippet
- Design exercises: design a system/architecture, microservices layout, scalability design
- Implementation recipes: step-by-step how to build or configure something in code
- Off-role topics: concepts clearly outside ${jdTitle} (e.g. REST API statelessness for a pure Frontend UI role; React hooks for a pure DBA role)
- Generic trivia with NO JD/CV grounding
- CV quoting: "on your CV", company names, university, project titles, "At [Company]…"
- Copy-pasting the same question across candidates — each question must fit THIS JD and THIS CV overlap`;
}

function buildAssessmentQuestionRules({
  jdTitle,
  jdReq,
  cvText,
  targetTier,
  levelCal,
  nextPhaseNum,
  maxQ,
}) {
  return `ASSESSMENT QUESTION RULES (next_question):
Written technical assessment — conceptual and logic-based only.

${tierCalibrationBlock(levelCal, jdTitle)}

${topicSelectionRules(jdTitle, jdReq, cvText, targetTier)}

WRITTEN MIX (all ${maxQ} phases):
- At least 3 phases must be pure CORE CONCEPT questions (comparisons, why/how) — not only troubleshooting.
- Phase 1 (from screening) should already anchor on JD+CV; phases 2–3 continue fundamentals before heavier scenarios in 4–5.
- Every question must be justifiable from the JD for "${jdTitle}" — ask yourself: "Would a hiring manager for THIS role ask this?"

Phase focus for next_question (phase ${nextPhaseNum}):
- ${phaseBlueprintDynamic(nextPhaseNum, targetTier, jdTitle)}

${questionStylePatterns(jdTitle, targetTier)}

${forbiddenQuestionRules(jdTitle)}`;
}

function buildScreeningPhase1Rules(jdTitle, jdReq, cvText, targetTier, levelCal) {
  const domain = detectRoleDomain(jdTitle, jdReq);
  const tierDepth =
    targetTier === 'senior'
      ? 'Ask a challenging conceptual or trade-off question with production nuance — not trivia, not system design.'
      : targetTier === 'junior'
        ? 'Ask a clear fundamentals question — a comparison, definition, or why a core JD idea matters.'
        : 'Ask a trade-off or reasoning question — compare approaches or explain how/why something works in this role.';

  return [
    'You are a senior technical interviewer for a written assessment.',
    'Read the job specification and candidate CV in the user message.',
    '',
    `ROLE LEVEL (critical): This interview is for a ${tierLabel(targetTier)} position (${jdTitle}).`,
    `Phase 1 difficulty must match ${tierLabel(targetTier)} expectations — not the candidate's background alone.`,
    `- Role signals: ${tierLabel(levelCal.roleTier)}${levelCal.jdYears ? ` (~${levelCal.jdYears} years in JD)` : ''}`,
    `- CV signals (topic anchors only): ${tierLabel(levelCal.candidateTier)}`,
    `- Role domain: ${domain.domain} — ${domain.guidance}`,
    tierDepth,
    '',
    topicSelectionRules(jdTitle, jdReq, cvText, targetTier),
    '',
    'PHASE 1 OUTPUT — exactly ONE core concept question:',
    '- Derive the topic from JD+CV overlap using the rules above (e.g. CV shows CQRS + JD is .NET backend → CQRS purpose or vs layered architecture; CV shows Redux + JD is Frontend → state management comparison).',
    '- Use compare / why / difference / explain-how framing — not trivia.',
    '- Never quote the CV; never ask off-role generic API questions for a frontend JD.',
    '',
    forbiddenQuestionRules(jdTitle),
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
}

function buildDynamicFallbackQuestion(nextPhase, history, jdTitle, jdReq, cvText, targetTier) {
  const asked = (history || [])
    .map((h) => String(h.question_text || h.question || '').toLowerCase())
    .filter(Boolean);
  const domain = detectRoleDomain(jdTitle, jdReq);
  const anchors = jdCvTopicAnchors(jdTitle, jdReq, cvText);
  const candidates = [...anchors.overlap, ...anchors.jdOnly, ...anchors.cvOnly].filter(Boolean);
  const unused = candidates.filter((s) => !asked.some((a) => a.includes(s.toLowerCase().slice(0, 8))));
  const skill = unused[0] || candidates[0] || 'a core skill from the job description';
  const role = String(jdTitle || 'this role').trim();
  const templates =
    nextPhase <= 2
      ? [
          `What is the difference between using ${skill} and not using it when working as a ${role}?`,
          `Why is ${skill} important for a ${role}? What problem does it solve in this stack?`,
          `Explain the purpose of ${skill} in the context of a ${role} — at a conceptual level.`,
        ]
      : nextPhase <= 4
        ? [
            `When building solutions as a ${role}, how would ${skill} help you handle a common challenge in the ${domain.domain} stack?`,
            `What trade-offs should a ${role} consider when working with ${skill}?`,
          ]
        : [
            `For a ${role}, compare two reasonable approaches involving ${skill} — when would you choose each?`,
          ];
  for (const q of templates) {
    const key = q.slice(0, 20).toLowerCase();
    if (!asked.some((a) => a.includes(key.slice(0, 12)))) return q;
  }
  return templates[0];
}

function pickFallbackQuestion(nextPhase, history, targetTier, jdTitle, jdReq, cvText) {
  return buildDynamicFallbackQuestion(nextPhase, history, jdTitle, jdReq, cvText, targetTier);
}

// Legacy aliases — avoid breaking callers that still reference old names
function stackHints(jdTitle, jdReq) {
  return detectRoleDomain(jdTitle, jdReq).guidance;
}

function coreConceptHints(jdTitle, jdReq, cvText, targetTier) {
  const anchors = jdCvTopicAnchors(jdTitle, jdReq, cvText);
  return `JD emphasis: ${anchors.jdOnly.slice(0, 6).join(', ') || 'read JD'} | CV+JD overlap: ${anchors.overlap.slice(0, 6).join(', ') || 'derive from texts'} | Level: ${tierLabel(targetTier)}`;
}

function phaseBlueprint(phaseNum, targetTier, jdTitle, jdReq, cvText) {
  return phaseBlueprintDynamic(phaseNum, targetTier, jdTitle);
}

function tierExamplesBlock(jdTitle, targetTier) {
  return questionStylePatterns(jdTitle, targetTier);
}

function buildTierFallbackPools() {
  return null;
}

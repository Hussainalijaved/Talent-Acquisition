// n8n: CV Screening — Phase 1 prompt + Groq request body
// Paste into: Gemini - CV screening agent (request body)
// Workflow: Talent Acquisition — CV Screening  OR  CV Screening (Threaded Mail)

const row = $input.first().json;
const jdTitle = row.config?.requisition_title;
const jdMust = row.config?.requisition_requirements;
if (!jdTitle || !jdMust) {
  throw new Error('Screening blocked: JD must come from recruiter form (CODE - Frontend intake).');
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

const systemText = [
  'You are a senior technical interviewer for a written assessment.',
  'Read the job specification and candidate CV in the user message.',
  '',
  'PHASE 1 QUESTION — must be ONE conceptual/logic question grounded in the role stack:',
  `- Role stack focus: ${stack}`,
  '- Ask comparative, "why", or "what is the difference" questions that test understanding.',
  '- Good examples: JWT vs session auth; authentication vs authorization; why REST APIs are stateless; what problem DI solves; IEnumerable vs IQueryable; idempotency in HTTP; when EF tracking vs no-tracking.',
  '- Pick a topic that matches BOTH the JD requirements and skills evidenced on the CV (silent — never quote CV).',
  '- Answers may exist online — that is fine. Test reasoning and clarity, not obscure trivia.',
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
  '- phase_1_question: one interview question (empty string if REJECT)',
  '- phase_1_time_limit_seconds: sensible seconds for that question (90-600)',
  '- phase_1_complexity_tier: A | B | C | D',
].join('\n');

const phases = row.config?.max_questions ?? 5;
const userText = [
  `Job specification title: ${jdTitle}`,
  `Requirements: ${jdMust}`,
  row.requisition_id ? `Submission ref: ${row.requisition_id}` : '',
  `Sequential assessment: ${phases} written phases total; you are issuing Phase 1 only.`,
  '',
  'Candidate CV:',
  row.cv_plaintext,
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

return [{ json: { ...row, groq_cv_screening_request: body } }];

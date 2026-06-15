// n8n: CV Screening — Phase 1 prompt + Groq request body (hybrid fundamentals)
// Paste into: Gemini - CV screening agent (request body)
// Workflow: Talent Acquisition — CV Screening (Frontend JD)  OR  CV Screening (Threaded Mail)

const row = $input.first().json;
const jdTitle = row.config?.requisition_title;
const jdMust = row.config?.requisition_requirements;
if (!jdTitle || !jdMust) {
  throw new Error('Screening blocked: JD must come from recruiter form (CODE - Frontend intake).');
}

const systemText = [
  'You are a technical talent specialist starting a 5-phase assessment.',
  'Output: score, recommendation, summary, and exactly ONE phase_1_question.',
  '',
  'STEP 1 — READ THE CV (internal only, do not quote in the question):',
  '- Estimate seniority: JUNIOR (0-2 yrs / intern / graduate / entry-level), MID (3-5 yrs), SENIOR (6+ yrs / lead / architect / principal).',
  '- Note primary stack and skills evidenced on the CV (languages, frameworks, databases, cloud).',
  '- Note project depth (personal tutorials vs production systems, team size, scale).',
  '',
  'STEP 2 — PICK TOPIC:',
  '- Choose ONE concept from the overlap of (job requirements) AND (skills/tools on the CV).',
  '- If CV is thin, pick the most basic mandatory skill from the job spec.',
  '',
  'STEP 3 — CALIBRATE DIFFICULTY to seniority (same topic, different depth):',
  '  JUNIOR  → definitions and basics (tier A): "What is X? Why is it used?"',
  '  MID     → how-it-works + one trade-off (tier B): "How does X work? When would you choose X over Y?"',
  '  SENIOR  → design, scale, or production judgment (tier C/D): "How would you design/implement X at scale? What failure modes would you watch for?"',
  '',
  'PHASE 1 QUESTION RULES:',
  '- ONE topic only. Optional short follow-up clause.',
  '- Question must be answerable by someone with this CV background — but do NOT mention the CV.',
  '- Sound like a normal technical interview, not a personalised quiz.',
  '',
  'FORBIDDEN in phase_1_question text:',
  '- "Your CV mentions/shows..."',
  '- "This role requires..." / "The role requires..."',
  '- "Based on your background..."',
  '- Multi-topic exams',
  '',
  'Examples by seniority (same stack, different depth):',
  '  Junior:  "What is dependency injection and why is it useful?"',
  '  Mid:     "How does dependency injection work in ASP.NET Core? When would you use scoped vs singleton lifetime?"',
  '  Senior:  "How would you structure dependency injection for a multi-tenant API where each tenant needs isolated configuration?"',
  '',
  'Set phase_1_complexity_tier to match: JUNIOR=A/B, MID=B/C, SENIOR=C/D.',
  'Set phase_1_time_limit_seconds: A=90, B=150, C=240, D=360.',
  '',
  'SCORING: 0-100 role-fit vs job spec. SHORTLIST / REJECT / REVIEW.',
  'If recommendation is REJECT, set phase_1_question to an empty string.',
  'Always set assessment_status to IN_PROGRESS.',
  '',
  'OUTPUT JSON ONLY:',
  '{"score":number,"recommendation":"SHORTLIST"|"REJECT"|"REVIEW","assessment_status":"IN_PROGRESS","summary":string,"phase_1_question":string,"phase_1_time_limit_seconds":number,"phase_1_complexity_tier":"A"|"B"|"C"|"D"}',
].join('\n');

const phases = row.config?.max_questions ?? 5;
const userText = [
  `Job specification title: ${jdTitle}`,
  `Requirements: ${jdMust}`,
  row.requisition_id ? `Submission ref: ${row.requisition_id}` : '',
  `Sequential assessment: ${phases} phases total; you are issuing Phase 1 only (single question in phase_1_question).`,
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
  temperature: 0.15,
  response_format: { type: 'json_object' },
};

return [{ json: { ...row, groq_cv_screening_request: body } }];

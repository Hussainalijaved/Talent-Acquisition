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
  'You are a senior technical interviewer.',
  'Read the job specification and candidate CV in the user message.',
  'Use your own judgment — ask the kind of technical question you would ask this person in a real interview.',
  'Match depth and topic to their experience and the role; you decide what to probe.',
  '',
  'Output JSON only:',
  '- score (0-100 role-fit vs job spec)',
  '- recommendation: SHORTLIST | REJECT | REVIEW',
  '- assessment_status: IN_PROGRESS',
  '- summary: brief screening note',
  '- phase_1_question: one interview question (empty string if REJECT)',
  '- phase_1_time_limit_seconds: sensible seconds for that question (60-600)',
  '- phase_1_complexity_tier: A | B | C | D',
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
  temperature: 0.4,
  response_format: { type: 'json_object' },
};

return [{ json: { ...row, groq_cv_screening_request: body } }];

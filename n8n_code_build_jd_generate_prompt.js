// n8n: CODE - Build JD generate prompt (Groq)
// After: TRG - Webhook JD generate

function pick(body, ...keys) {
  for (const k of keys) {
    const v = body?.[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

function bulletLines(raw) {
  return String(raw || '')
    .split(/\n/)
    .map((l) => l.replace(/^[\s\-•*]+/, '').trim())
    .filter(Boolean);
}

const raw = $input.first().json;
let body = raw.body || raw;
if (typeof body === 'string') {
  try {
    body = JSON.parse(body);
  } catch (e) {
    body = raw;
  }
}

const title = pick(body, 'title', 'job_title', 'requisition_title') || 'Open Position';
const department = pick(body, 'department', 'dept') || 'Engineering';
const location = pick(body, 'location') || 'Remote';
const employment_type = pick(body, 'employment_type', 'employmentType', 'job_type') || 'Full-time';
const criteria = bulletLines(pick(body, 'criteria', 'must_have', 'requirements'));
const nice = bulletLines(pick(body, 'nice', 'nice_to_have', 'niceToHave'));

// Code nodes cannot read $env — model default matches CV screening; override via request body groq_model.
const model = pick(body, 'groq_model') || 'llama-3.3-70b-versatile';

const systemPrompt = [
  'You are an expert technical recruiter and copywriter who writes job descriptions for LinkedIn and careers pages.',
  'Write polished, professional, inclusive job postings that attract strong candidates.',
  'Tone: confident, clear, modern — like top tech companies on LinkedIn (not generic HR fluff).',
  'Use UK/US professional English. No emojis. No markdown headings with # symbols.',
  'Structure the JD with these section labels on their own lines (plain text):',
  'About the Role',
  'What You\'ll Do',
  'What We\'re Looking For',
  'Nice to Have',
  'Qualifications',
  'What We Offer',
  'How to Apply',
  'Include an equal opportunity employer line at the end.',
  'Expand recruiter bullet points into full, actionable responsibility and requirement lines.',
  'Return JSON only: {"jd_text":"<full job description as plain text with newlines>"}',
].join(' ');

const userPrompt = [
  `Write a complete job description for this role.`,
  ``,
  `Job title: ${title}`,
  `Department: ${department}`,
  `Location: ${location}`,
  `Employment type: ${employment_type}`,
  ``,
  criteria.length
    ? `Must-have skills / requirements (expand into professional bullets):\n${criteria.map((c) => `- ${c}`).join('\n')}`
    : 'Must-have: infer realistic requirements from the job title (e.g. Junior .NET Developer → C#, ASP.NET Core, SQL, Git).',
  ``,
  nice.length
    ? `Nice to have:\n${nice.map((c) => `- ${c}`).join('\n')}`
    : 'Nice to have: add 3–4 realistic optional skills for this role.',
  ``,
  `First line of jd_text must be the job title. Second line: ${department} | ${employment_type} | ${location}`,
  `How to Apply section must mention applying via the company careers portal and a structured technical assessment for shortlisted candidates.`,
].join('\n');

const groq_jd_request = {
  model,
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ],
  temperature: 0.45,
  response_format: { type: 'json_object' },
};

return [
  {
    json: {
      title,
      department,
      location,
      employment_type,
      criteria,
      nice,
      groq_jd_request,
    },
  },
];

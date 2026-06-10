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

function detectSeniority(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(intern|trainee|graduate|entry[\s-]?level)\b/.test(t)) return 'intern';
  if (/\b(junior|jr\.?)\b/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|principal|staff|architect|head)\b/.test(t)) return 'senior';
  return 'mid';
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
const seniority = detectSeniority(title);

// Code nodes cannot read $env — model default matches CV screening; override via request body groq_model.
const model = pick(body, 'groq_model') || 'llama-3.3-70b-versatile';

const systemPrompt = [
  'You are a senior technical recruiter writing enterprise-grade job descriptions for engineering roles.',
  'Write like a professional corporate JD posted on LinkedIn or a careers page — detailed, specific, and credible.',
  'Tone: formal, confident, enterprise-ready. Not marketing fluff, not casual, no emojis.',
  'Use UK/US professional English. Plain text only — no markdown (# headings), no HTML.',
  '',
  'STRICT OUTPUT STRUCTURE (use these exact section labels on their own line):',
  'Job Title: <title>',
  '',
  'Job Description:',
  '<Two substantive paragraphs. Paragraph 1: who we seek and the business/product context. Paragraph 2: technical scope — architecture, integrations, platforms, and complexity (e.g. multi-tenant, offline-first, enterprise integrations).>',
  '',
  'Responsibilities:',
  '<10–14 bullet lines. Each starts with a strong action verb (Design, Develop, Implement, Integrate, Build, Optimize, Collaborate, Troubleshoot, etc.). Expand recruiter criteria into real engineering duties. Mention architecture patterns, APIs, auth, data, performance, cross-platform work where relevant.>',
  '',
  'Requirements:',
  '<8–12 bullet lines. Degree, years of experience (match seniority), core languages/frameworks, architecture patterns, API integration, state management, storage, Git, soft skills. Turn every must-have criterion into a polished requirement line.>',
  '',
  'Preferred Qualifications:',
  '<5–8 bullet lines from nice-to-have input. Enterprise extras, domain tools, CI/CD, Agile, design patterns, related platforms.>',
  '',
  '<One closing paragraph inviting qualified candidates to apply — passionate, professional, no equal-opportunity boilerplate unless natural.>',
  '',
  'QUALITY RULES:',
  '- Weave ALL provided must-have and nice-to-have skills into the right sections — never ignore recruiter input.',
  '- Infer realistic enterprise context from the job title (Flutter → mobile architecture; .NET → web APIs; etc.).',
  '- Senior roles: leadership, architecture ownership, mentoring; include realistic experience years (e.g. 3+ in stack, 5+ overall for senior).',
  '- Junior roles: mentorship, learning, foundational delivery; lower experience thresholds.',
  '- Bullets are one line each, no sub-bullets, no numbered lists.',
  '- Do NOT add sections like About the Role, What We Offer, or How to Apply.',
  'Return JSON only: {"jd_text":"<complete JD as plain text with newlines>"}',
].join('\n');

const userPrompt = [
  `Write a complete enterprise job description matching the structure in your instructions.`,
  ``,
  `Job title: ${title}`,
  `Seniority level: ${seniority}`,
  `Department: ${department}`,
  `Location: ${location}`,
  `Employment type: ${employment_type}`,
  ``,
  criteria.length
    ? `Must-have criteria from recruiter (expand every item into Responsibilities and/or Requirements):\n${criteria.map((c) => `- ${c}`).join('\n')}`
    : `Must-have: infer realistic technical requirements from the job title "${title}" and seniority "${seniority}".`,
  ``,
  nice.length
    ? `Preferred / nice-to-have (expand into Preferred Qualifications):\n${nice.map((c) => `- ${c}`).join('\n')}`
    : `Preferred: add 5–7 realistic optional qualifications for a ${seniority} ${title} in an enterprise environment.`,
  ``,
  `Style reference — match this depth and format (do not copy verbatim unless inputs match):`,
  `---`,
  `Job Title: Sr. Flutter Developer`,
  ``,
  `Job Description: We are seeking an experienced Flutter Developer to join our development team. The ideal candidate will be responsible for building a scalable, high-performance, enterprise mobile application integrated with SAP BTP.`,
  ``,
  `This role involves working on a multi-tenant, offline-first, and configuration-driven mobile platform, requiring strong expertise in mobile architecture, API integration, and secure authentication.`,
  ``,
  `Responsibilities:`,
  `Design and develop high-performance Flutter applications that meet business and user requirements.`,
  `Implement Clean Architecture (MVVM) for scalable and maintainable code.`,
  `Integrate with REST APIs and handle complex data flows.`,
  `...`,
  ``,
  `Requirements:`,
  `Bachelor's degree in Computer Science or related field.`,
  `3+ years of Flutter development experience and 5+ years of overall software development experience.`,
  `Strong knowledge of Dart, OOP, and clean scalable code design.`,
  `...`,
  ``,
  `Preferred Qualifications:`,
  `Experience with SAP BTP / CAP / OData integrations.`,
  `...`,
  `---`,
  `First line of jd_text must be exactly: Job Title: ${title}`,
  `Make the JD specific to the provided title and criteria — not a generic template.`,
].join('\n');

const groq_jd_request = {
  model,
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ],
  temperature: 0.4,
  response_format: { type: 'json_object' },
};

return [
  {
    json: {
      title,
      department,
      location,
      employment_type,
      seniority,
      criteria,
      nice,
      groq_jd_request,
    },
  },
];

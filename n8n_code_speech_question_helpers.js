// Shared helpers for personalized speech questions (paste into parse Technical/Speech nodes)

function extractJdThemes(text) {
  const lines = String(text)
    .split(/\r?\n|(?<=[.;])\s+/)
    .flatMap((chunk) => chunk.split(/\s*[•\-*]\s+/))
    .map((s) => s.replace(/^[\s\d.)(]+/, '').trim())
    .filter((s) => s.length >= 12);
  return lines.length ? [...new Set(lines)].slice(0, 10) : [String(text).slice(0, 400)];
}

function extractCvAnchors(text) {
  const cv = String(text || '');
  const projects =
    cv.match(/(?:project|built|developed|engineered|implemented|led)[^.]{10,120}/gi) || [];
  const skills =
    cv.match(
      /\b(React|Angular|Vue|Node\.?js|Python|Django|Flask|SQL|PostgreSQL|MySQL|MongoDB|\.NET|ASP\.NET|C#|Java|Spring|AWS|Azure|GCP|Docker|Kubernetes|Redis|Kafka|REST|GraphQL|TypeScript|JavaScript|EF\s*Core|LINQ|JWT|OAuth|microservices?|APIM|CI\/CD|GitHub Actions)\b/gi
    ) || [];
  return [
    ...new Set([
      ...projects.slice(0, 5).map((p) => p.trim().slice(0, 80)),
      ...skills.slice(0, 6),
    ]),
  ].filter(Boolean);
}

function buildPersonalizedSpeechQuestion(cfg, session, speechIndex, history, maxQ) {
  const role = String(cfg.requisition_title || 'this role').trim();
  const org = String(cfg.organization_name || 'the company').trim();
  const jdReq = String(cfg.requisition_requirements || '').trim();
  const cv = String(session.cv_plaintext || '');
  const idx = Math.max(0, Math.min(2, Number(speechIndex || 1) - 1));

  const jdThemes = extractJdThemes(jdReq);
  const cvAnchors = extractCvAnchors(cv);
  const jdTheme = jdThemes[idx % jdThemes.length] || jdReq.slice(0, 180);
  const cvAnchor = cvAnchors[idx % cvAnchors.length] || 'your listed project experience';

  const speechHistory = (history || []).filter((h) => Number(h.phase) > Number(maxQ || 5));
  const asked = speechHistory
    .map((h) => String(h.question_text || '').toLowerCase())
    .filter(Boolean);
  const pickFresh = (theme, anchor, templates) => {
    for (let i = 0; i < templates.length; i++) {
      const q = templates[i](theme, anchor);
      if (!asked.some((a) => a.includes(theme.slice(0, 24).toLowerCase()))) return q;
    }
    return templates[idx % templates.length](theme, anchor);
  };

  const templates = [
    (jd, cvA) =>
      `For the ${role} role at ${org}, JD emphasizes: "${jd}". Using your experience with ${cvA}, describe a time you explained a complex technical topic to a non-technical stakeholder. How did you ensure they understood, and what was the outcome?`,
    (jd, cvA) =>
      `This position requires "${jd}". Drawing on ${cvA} from your CV, tell me about a situation involving pressure, a tight deadline, or conflict. How did you communicate with your team and stay composed?`,
    (jd, cvA) =>
      `JD focus: "${jd}". Given your background in ${cvA}, what specifically interests you about the ${role} role at ${org}, and how would you apply that experience in your first 90 days?`,
  ];

  return pickFresh(jdTheme, cvAnchor, templates);
}

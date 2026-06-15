// Shared helpers for personalized speech questions (paste into parse Technical/Speech nodes)

function buildPersonalizedSpeechQuestion(cfg, session, speechIndex, history, maxQ) {
  const idx = Math.max(0, Math.min(2, Number(speechIndex || 1) - 1));

  const speechHistory = (history || []).filter((h) => Number(h.phase) > Number(maxQ || 5));
  const asked = speechHistory
    .map((h) => String(h.question_text || '').toLowerCase())
    .filter(Boolean);

  const templates = [
    'Tell me about a time you explained a complex technical idea to a non-technical person. How did you make sure they understood, and what was the outcome?',
    'Describe a situation where you faced a tight deadline or disagreement with a teammate. How did you communicate and stay constructive?',
    'Share an example of when you took ownership of a problem without being asked. What did you do and what was the result?',
  ];

  for (let i = 0; i < templates.length; i++) {
    const q = templates[(idx + i) % templates.length];
    const key = q.slice(0, 35).toLowerCase();
    if (!asked.some((a) => a.includes(key.slice(0, 20)))) return q;
  }
  return templates[idx];
}

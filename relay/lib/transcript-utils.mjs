const INTERNAL_MODEL_PATTERNS = [
  /^\*\*/i,
  /\*\*[^*]+\*\*/,
  /^i(?:'ve| have) observed/i,
  /^i am (currently )?pausing/i,
  /^i'm currently/i,
  /^guiding language/i,
  /^re-engaging/i,
  /^awaiting clarification/i,
  /^language adjustment/i,
  /^internal/i,
];

export function sanitizeTranscript(text, role = 'model') {
  let t = String(text || '').trim();
  if (!t) return '';

  t = t.replace(/\*\*[^*]+\*\*/g, ' ').replace(/\*/g, '');
  t = t.replace(/\s+/g, ' ').trim();

  if (role === 'model') {
    if (INTERNAL_MODEL_PATTERNS.some((re) => re.test(t))) return '';
    if (t.length < 3) return '';
  }

  if (role === 'user') {
    if (/^(okay|ok|on|yes|no|hmm|uh|um)\.?$/i.test(t)) return '';
  }

  return t;
}

export function isSubstantiveAnswer(text) {
  const t = sanitizeTranscript(text, 'user');
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 4 || t.length >= 20;
}

export function mergeQuestionChunks(chunks) {
  const parts = (chunks || []).map((c) => sanitizeTranscript(c, 'model')).filter(Boolean);
  if (!parts.length) return '';
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

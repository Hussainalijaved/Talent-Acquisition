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

export function isEnglishTranscript(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Reject common non-Latin scripts (Arabic, Urdu, Hindi, Bengali, CJK, etc.)
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(t)) {
    return false;
  }
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters === 0) return latin > 0;
  return latin / letters >= 0.6;
}

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
    // Only accept English/Latin-script candidate speech in captions + saved answers.
    if (!isEnglishTranscript(t)) return '';
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

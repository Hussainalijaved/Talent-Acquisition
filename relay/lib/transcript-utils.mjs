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

export function extractEnglishAnswer(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  // Drop non-Latin script spans but keep the English the candidate did say.
  let t = raw
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 3 ? t : '';
}

/** Best-effort English answer for saving — never false-flag mixed English answers. */
export function cleanUserAnswerText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const sanitized = sanitizeTranscript(raw, 'user');
  if (sanitized) return sanitized;

  const extracted = extractEnglishAnswer(raw);
  if (extracted) return extracted;

  // Short filler only — not a real answer.
  if (raw.length < 12 || raw.split(/\s+/).filter(Boolean).length < 3) return '';

  if (!isEnglishTranscript(raw)) {
    return '[Non-English response — please answer in English]';
  }
  return raw;
}

/** Text safe to show in live captions while the candidate is speaking. */
export function displayUserTranscript(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const sanitized = sanitizeTranscript(raw, 'user');
  if (sanitized) return sanitized;
  const extracted = extractEnglishAnswer(raw);
  if (extracted) return extracted;
  // Show partial raw text while still speaking (don't blank the caption).
  if (raw.length >= 2 && isEnglishTranscript(raw)) return raw;
  return '';
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

/** True when the model spoke a closing/thank-you instead of an interview question. */
export function isClosingMessage(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  const patterns = [
    /conclud(e|es|ed|ing).*interview/,
    /completes? the voice interview/,
    /that concludes/,
    /interview is (now )?complete/,
    /we will be in touch/,
    /we'll be in touch/,
    /no more questions/,
    /thank you for your time/,
    /thanks for (your )?time/,
    /this concludes/,
    /end of (the )?(voice )?interview/,
    /wrapping up/,
  ];
  return patterns.some((re) => re.test(t));
}

const FALLBACK_QUESTIONS = [
  'Describe a situation where you had to explain a complex technical topic to a non-technical stakeholder. How did you ensure they understood?',
  'Tell me about a time you faced pressure, a tight deadline, or conflict at work. How did you communicate and stay composed?',
  'Why are you interested in this role, and what would you focus on in your first 90 days?',
  'Describe a time you had to collaborate with someone who disagreed with your approach. How did you handle it?',
  'Tell me about a mistake or setback you learned from. What did you change afterward?',
];

export function fallbackInterviewQuestion(number, maxTurns) {
  const idx = Math.max(0, Math.min(FALLBACK_QUESTIONS.length - 1, Number(number || 1) - 1));
  return FALLBACK_QUESTIONS[idx];
}

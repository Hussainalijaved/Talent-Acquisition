const REPEAT_PATTERNS = [
  /\b(repeat|again|pardon)\b.*\b(question|that|it)\b/i,
  /\b(can you|could you|please)\b.*\b(repeat|say again|rephrase|clarify)\b/i,
  /\b(didn't|did not|don't|do not)\b.*\b(understand|hear|catch)\b/i,
  /\bwhat was the question\b/i,
  /\b(samajh|samjh|sunao|dobara|dubara|phir se|repeat karo|repeat kar|question repeat)\b/i,
  /^(repeat|again|pardon|sorry)[\s!?]*$/i,
];

/** Candidate asked to hear the same speech question again — not an answer attempt. */
export function isRepeatRequest(transcript) {
  const t = String(transcript || '').trim();
  if (!t) return false;
  if (REPEAT_PATTERNS.some((re) => re.test(t))) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 10 && /\b(repeat|again|pardon|understand|samajh|sunao|dubara)\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Short partial transcript that may still be forming a repeat request. */
export function mightBeRepeatRequest(transcript) {
  if (isRepeatRequest(transcript)) return true;
  const t = String(transcript || '').trim();
  if (!t || t.length > 48) return false;
  return /\b(repeat|again|pardon|understand|samajh|sunao|dubara|clarify|what was)\b/i.test(t);
}

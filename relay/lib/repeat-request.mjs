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

// Explicit "move on / skip this question" intent. Requires a clear ADVANCE signal
// (next / move on / skip), NOT just uncertainty — so "I don't know because…" stays
// a real (low-scoring) answer rather than being skipped.
const SKIP_PATTERNS = [
  /\b(next|skip)\b.*\b(question|one|please)\b/i,
  /\b(move|go)\s*(on|ahead|forward)\b/i,
  /\b(move|go)\s*(on|ahead)?\s*to\s*(the\s*)?next\b/i,
  /\b(skip|pass)\s*(this|it|that|the question)\b/i,
  /\blet'?s\s*(just\s*)?(move on|skip|go to the next)\b/i,
  /\bi\s*(can'?t|cannot|don'?t want to|would rather not)\s*answer\b.*\b(next|skip|move on)\b/i,
  /\b(skip kar|skip kr|agla sawal|agla question|next p[ae] j[ae]?o|aage barh|chhod (do|den)|chor do)\b/i,
  /^(skip|next|pass)[\s!.?]*$/i,
];

/** Candidate explicitly asked to give up on this question and move to the next. */
export function isSkipRequest(transcript) {
  const t = String(transcript || '').trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  // Keep it bounded: a genuine skip request is short. A long answer that merely
  // mentions "next" should be scored, not skipped.
  if (words.length > 14) return false;
  return SKIP_PATTERNS.some((re) => re.test(t));
}

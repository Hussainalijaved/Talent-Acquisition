import { isEnglishTranscript } from './transcript-utils.mjs';

const REPEAT_PATTERNS = [
  /\b(repeat|again|pardon)\b.*\b(question|that|it)\b/i,
  /\b(can you|could you|please)\b.*\b(repeat|say again|rephrase|clarify)\b/i,
  /\b(didn't|did not|don't|do not)\b.*\b(understand|hear|catch)\b/i,
  /\bwhat was the question\b/i,
  /\b(samajh|samjh|sunao|dobara|dubara|phir se|repeat karo|repeat kar|question repeat)\b/i,
  /^(repeat|again|pardon|sorry)[\s!?]*$/i,
];

/** Candidate asked to hear the same question again — not an answer attempt. */
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

/**
 * Classify what to do when a candidate turn ends.
 * @returns {'answer'|'repeat_request'|'non_english'|'no_speech'}
 */
export function classifyAnswerIntent(transcript, { hasVoice = false } = {}) {
  const t = String(transcript || '').trim();

  if (isRepeatRequest(t)) return 'repeat_request';

  if (!hasVoice) return 'no_speech';

  // Any spoken attempt counts as an answer — including "I don't know".
  if (t && !isEnglishTranscript(t)) return 'non_english';

  return 'answer';
}

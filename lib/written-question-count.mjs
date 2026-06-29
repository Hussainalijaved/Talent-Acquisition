/**
 * Written assessment question count — admin bounds + AI/heuristic per candidate.
 */

export const DEFAULT_WRITTEN_Q_MIN = 4;
export const DEFAULT_WRITTEN_Q_MAX = 10;
export const ABSOLUTE_WRITTEN_Q_MIN = 1;
export const ABSOLUTE_WRITTEN_Q_MAX = 20;

export function normalizeWrittenQuestionBounds(rawMin, rawMax) {
  let min = Number(rawMin);
  let max = Number(rawMax);
  if (!Number.isFinite(min)) min = DEFAULT_WRITTEN_Q_MIN;
  if (!Number.isFinite(max)) max = DEFAULT_WRITTEN_Q_MAX;
  min = Math.min(ABSOLUTE_WRITTEN_Q_MAX, Math.max(ABSOLUTE_WRITTEN_Q_MIN, Math.round(min)));
  max = Math.min(ABSOLUTE_WRITTEN_Q_MAX, Math.max(ABSOLUTE_WRITTEN_Q_MIN, Math.round(max)));
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

export function questionBoundsFromConfig(cfg = {}) {
  return normalizeWrittenQuestionBounds(
    cfg.written_questions_min ?? cfg.min_questions,
    cfg.written_questions_max ?? cfg.max_questions_bound ?? cfg.max_questions
  );
}

export function clampWrittenQuestionCount(n, min, max) {
  const bounds = normalizeWrittenQuestionBounds(min, max);
  const v = Number(n);
  if (!Number.isFinite(v)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(v)));
}

export function tierDefaultQuestionCount(tier, min, max) {
  const t = String(tier || 'mid').toLowerCase();
  const map = { junior: 4, intern: 4, mid: 6, senior: 8 };
  return clampWrittenQuestionCount(map[t] ?? map.mid, min, max);
}

export function resolveWrittenQuestionCount(aiValue, tier, min, max) {
  const bounds = normalizeWrittenQuestionBounds(min, max);
  const raw = aiValue?.written_question_count ?? aiValue?.recommended_question_count ?? aiValue;
  if (Number.isFinite(Number(raw)) && Number(raw) > 0) {
    return clampWrittenQuestionCount(Number(raw), bounds.min, bounds.max);
  }
  const level =
    typeof aiValue === 'object' && aiValue
      ? aiValue.assessment_level || tier
      : tier;
  return tierDefaultQuestionCount(level, bounds.min, bounds.max);
}

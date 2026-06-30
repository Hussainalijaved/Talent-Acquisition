// n8n: CODE - Parse CV screening outcome
// Paste into CV Screening workflow — replaces hardcoded 62/78/28 with job config.

function cvThresholds(cfg) {
  const raw = Number(cfg?.cv_shortlist_threshold ?? 62);
  const shortlistMin = Number.isFinite(raw)
    ? Math.min(100, Math.max(0, Math.round(raw)))
    : 62;
  return {
    shortlistMin,
    autoShortlist: Math.min(100, shortlistMin + 16),
    autoReject: Math.max(0, shortlistMin - 34),
  };
}

function normalizeWrittenQuestionBounds(rawMin, rawMax) {
  let min = Number(rawMin);
  let max = Number(rawMax);
  if (!Number.isFinite(min)) min = 4;
  if (!Number.isFinite(max)) max = 10;
  min = Math.min(20, Math.max(1, Math.round(min)));
  max = Math.min(20, Math.max(1, Math.round(max)));
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

function questionBoundsFromConfig(cfg) {
  return normalizeWrittenQuestionBounds(cfg?.written_questions_min, cfg?.written_questions_max);
}

function clampWrittenQuestionCount(n, min, max) {
  const bounds = normalizeWrittenQuestionBounds(min, max);
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(v)));
}

function tierDefaultQuestionCount(tier, min, max) {
  const t = String(tier || 'mid').toLowerCase();
  const map = { junior: 4, intern: 4, mid: 6, senior: 8 };
  return clampWrittenQuestionCount(map[t] ?? map.mid, min, max);
}

function resolveWrittenQuestionCount(screening, tier, bounds) {
  const raw = screening?.written_question_count;
  if (Number.isFinite(Number(raw)) && Number(raw) > 0) {
    return clampWrittenQuestionCount(Number(raw), bounds.min, bounds.max);
  }
  const level = screening?.assessment_level || tier || 'mid';
  return tierDefaultQuestionCount(level, bounds.min, bounds.max);
}

function pickBaseJson() {
  const names = ['CODE - CV plain text', 'CODE - CV plain text1'];
  for (const name of names) {
    try {
      const raw = $(name).first().json;
      if (raw && typeof raw === 'object') return raw;
    } catch (_) {}
  }
  throw new Error(
    'Parse CV screening: CODE - CV plain text node not found (with or without "1" suffix).'
  );
}

const api = $input.first().json;
const base = pickBaseJson();
const text = api?.choices?.[0]?.message?.content;
const httpBad = !(api?.choices && api.choices[0]);

if (!text || httpBad) {
  const hint = api?.error?.message || api?.message || (httpBad ? 'GEMINI_HTTP_OR_SCHEMA' : 'GEMINI_EMPTY');
  return [{
    json: {
      ...base,
      screening: { error: hint, transport: httpBad },
      decision: 'REVIEW',
      score: null,
      phase_1_question: '',
      assessment_status: 'IN_PROGRESS',
      session_phase: 1,
      screening_transport_failed: true,
    },
  }];
}

let s;
try {
  s = JSON.parse(text);
} catch (e) {
  return [{
    json: {
      ...base,
      screening: { error: 'GEMINI_PARSE', raw: String(text || '').slice(0, 2000) },
      decision: 'REVIEW',
      score: 50,
      phase_1_question: '',
      assessment_status: 'IN_PROGRESS',
      session_phase: 1,
      screening_transport_failed: false,
    },
  }];
}

const { shortlistMin, autoShortlist, autoReject } = cvThresholds(base.config || {});

let score = Math.max(0, Math.min(100, Math.round(Number(s.score) || 0)));
let rec = String(s.recommendation || 'REVIEW').toUpperCase();
if (!['SHORTLIST', 'REJECT', 'REVIEW'].includes(rec)) rec = 'REVIEW';

let decision = rec;
if (score >= autoShortlist && decision === 'REVIEW') decision = 'SHORTLIST';
else if (score <= autoReject && decision === 'REVIEW') decision = 'REJECT';
else if (decision === 'SHORTLIST' && score < shortlistMin) decision = 'REVIEW';
else if (decision === 'REJECT' && score > shortlistMin) decision = 'REVIEW';

const phase_1_question = typeof s.phase_1_question === 'string' ? s.phase_1_question.trim() : '';
const assessment_status = 'IN_PROGRESS';
const qBounds = questionBoundsFromConfig(base.config || {});
const assessmentLevel = s.assessment_level || base.assessment_level || 'mid';
const written_question_count = resolveWrittenQuestionCount(s, assessmentLevel, qBounds);
const mergedConfig = {
  ...(base.config || {}),
  max_questions: written_question_count,
  written_question_count,
  written_questions_min: qBounds.min,
  written_questions_max: qBounds.max,
};

const profilePhotoUrl = String(base.profile_photo_url || '').trim();
const candidateName = String(base.candidate_name || '').trim();

return [{
  json: {
    ...base,
    config: mergedConfig,
    max_questions: written_question_count,
    written_question_count,
    profile_photo_url: profilePhotoUrl || null,
    candidate_name: candidateName || null,
    // IMPORTANT: spread parsed AI JSON `s` — NEVER use `...$` (n8n internal object).
    screening: {
      ...s,
      written_question_count,
      cv_thresholds: { shortlistMin, autoShortlist, autoReject },
      ...(profilePhotoUrl ? { profile_photo_url: profilePhotoUrl } : {}),
      ...(candidateName ? { candidate_name: candidateName } : {}),
    },
    score,
    decision,
    recommendation: rec,
    phase_1_question,
    assessment_status,
    session_phase: 1,
    screening_transport_failed: false,
  },
}];

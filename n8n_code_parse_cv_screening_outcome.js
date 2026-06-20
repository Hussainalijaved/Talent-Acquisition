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

const api = $input.first().json;
const base = $('CODE - CV plain text').first().json;
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

return [{
  json: {
    ...base,
    screening: {
      ...s,
      cv_thresholds: { shortlistMin, autoShortlist, autoReject },
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

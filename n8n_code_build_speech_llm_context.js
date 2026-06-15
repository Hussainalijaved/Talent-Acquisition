// n8n: CODE - Build Speech LLM context (communication phases)
// Paste into: CODE - Build Speech LLM context (speech branch, before Basic LLM Chain Speech)

function isWeakTranscript(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^\[(no speech detected|timeout)/i.test(t)) return true;
  return t.split(/\s+/).filter(Boolean).length < 4;
}

function safeEnvVar(name) {
  try {
    return String($env[name] || '').trim();
  } catch (_) {
    return '';
  }
}

function resolveGroqKey(cfg) {
  return (
    safeEnvVar('GROQ_API_KEY') ||
    String(cfg?.groq_api_key || cfg?.GROQ_API_KEY || '').trim()
  );
}

async function transcribeWithGroqWhisper(audioUrl, apiKey) {
  const url = String(audioUrl || '').trim();
  const key = String(apiKey || '').trim();
  if (!url || !key || !/^https?:\/\//i.test(url)) return '';

  const audioRes = await fetch(url);
  if (!audioRes.ok) return '';

  const buffer = await audioRes.arrayBuffer();
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/webm' }), 'answer.webm');
  form.append('model', 'whisper-large-v3');
  form.append('language', 'en');
  form.append('response_format', 'json');

  const whisperRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  if (!whisperRes.ok) return '';
  const data = await whisperRes.json();
  return String(data?.text || '').trim();
}

const norm = $('CODE - Normalize Data').first().json;
const raw = $input.first().json;
const session = Array.isArray(raw) ? raw[0] : raw;
if (!session?.id) {
  throw new Error('No assessment session row for id=' + norm.session_id);
}

let history = session.interview_history;
if (typeof history === 'string') {
  try {
    history = JSON.parse(history);
  } catch (e) {
    history = [];
  }
}
if (!Array.isArray(history)) history = [];

let sessionConfig = session.config;
if (typeof sessionConfig === 'string') {
  try {
    sessionConfig = JSON.parse(sessionConfig);
  } catch (e) {
    sessionConfig = {};
  }
}
if (!sessionConfig || typeof sessionConfig !== 'object') sessionConfig = {};

const cfg = {
  ...norm.config,
  ...sessionConfig,
  requisition_title:
    sessionConfig.requisition_title || norm.config?.requisition_title || '',
  requisition_requirements:
    sessionConfig.requisition_requirements || norm.config?.requisition_requirements || '',
  groq_model:
    sessionConfig.groq_model || norm.config?.groq_model || 'llama-3.3-70b-versatile',
  max_questions: Number(sessionConfig.max_questions || norm.config?.max_questions || 5),
  speech_phases: Number(sessionConfig.speech_phases || norm.config?.speech_phases || 3),
  pass_score_threshold: Number(
    sessionConfig.pass_score_threshold ?? norm.config?.pass_score_threshold ?? 60
  ),
  timer_min_seconds: Number(sessionConfig.timer_min_seconds ?? norm.config?.timer_min_seconds ?? 60),
  timer_max_seconds: Number(sessionConfig.timer_max_seconds ?? norm.config?.timer_max_seconds ?? 600),
};

const maxQ = Number(cfg.max_questions || 5);
const speechPhases = Number(cfg.speech_phases || 3);
const ph = Number(norm.current_phase || maxQ + 1);
const speechIndex = ph - maxQ;
const isFinal = speechIndex >= speechPhases;

const jdTitle = String(cfg.requisition_title || '').trim();
const jdReq = String(cfg.requisition_requirements || '').trim();
const cvText = String(session.cv_plaintext || '').slice(0, 4000);

const currentRow = history.find((h) => Number(h.phase) === ph);
const currentQuestionText = String(
  currentRow?.question_text || currentRow?.question || ''
).trim();

const speechHistory = history
  .filter((h) => Number(h.phase) > maxQ)
  .map(
    (h) =>
      `Speech ${Number(h.phase) - maxQ} Q: ${h.question_text || ''} | A: ${h.answer_text ?? 'pending'} | Score: ${h.score ?? 'N/A'}`
  )
  .join('\n');

let answerText = String(norm.answer || '').trim();
let sttSource = 'browser';
const audioUrl = String(norm.audio_url || '').trim();
const groqKey = resolveGroqKey(cfg);

if (isWeakTranscript(answerText) && audioUrl && groqKey) {
  const whisperText = await transcribeWithGroqWhisper(audioUrl, groqKey);
  if (whisperText && !isWeakTranscript(whisperText)) {
    answerText = whisperText;
    sttSource = 'whisper';
  }
}

const metrics = norm.speech_metrics || {};
const metricsText = [
  metrics.duration_seconds != null ? `duration_seconds: ${metrics.duration_seconds}` : '',
  metrics.words_per_minute != null ? `words_per_minute: ${metrics.words_per_minute}` : '',
  metrics.filler_word_count != null ? `filler_word_count: ${metrics.filler_word_count}` : '',
  metrics.long_pause_count != null ? `long_pause_count: ${metrics.long_pause_count}` : '',
  sttSource ? `stt_source: ${sttSource}` : '',
]
  .filter(Boolean)
  .join(', ');

const systemContent = `You are a behavioral interviewer evaluating spoken communication for ${cfg.organization_name || 'the company'}.

Role: ${jdTitle} — communication round, phase ${speechIndex} of ${speechPhases}.

Read the JD, CV, prior speech answers, the question asked, and the candidate transcript below. Score and respond using your own professional judgment.

Score 0-100 for this answer (you may also return clarity, confidence, professionalism, relevance sub-scores if helpful).
Empty or very short answers: low score.

JD:
${jdReq.slice(0, 1500)}

CV:
${cvText || '(none)'}

Prior speech Q&A:
${speechHistory || '(none yet)'}

Question this phase:
${currentQuestionText || '(see history)'}

Candidate answer (transcript):
${answerText}

Audio metrics: ${metricsText || 'not provided'}

${!isFinal ? 'Also write next_question: the next behavioral question you would ask this candidate.' : 'Final speech phase — no next_question.'}

OUTPUT — JSON ONLY:
${!isFinal
  ? '{"score":number,"clarity":number,"confidence":number,"professionalism":number,"relevance":number,"feedback":string,"next_question":string,"time_limit_seconds":number,"complexity_tier":"A"|"B"|"C"|"D"}'
  : '{"status":"finished","score":number,"clarity":number,"confidence":number,"professionalism":number,"relevance":number,"feedback":string,"next_question":""}'}`;

const body = {
  model: cfg.groq_model || 'llama-3.3-70b-versatile',
  messages: [
    { role: 'system', content: systemContent },
    { role: 'user', content: 'Evaluate the spoken answer. Respond with JSON only.' },
  ],
  temperature: 0.45,
  response_format: { type: 'json_object' },
};

const resolvedNorm = {
  ...norm,
  answer: answerText,
  stt_source: sttSource,
  config: cfg,
};

return [
  {
    json: {
      groq_assessment_request: body,
      prompt: systemContent,
      session,
      norm: resolvedNorm,
      isFinal,
      speech_index: speechIndex,
      speech_phases: speechPhases,
      max_questions: maxQ,
      current_question_text: currentQuestionText,
      transcribed_answer: answerText,
      stt_source: sttSource,
    },
  },
];

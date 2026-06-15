// n8n: CODE - Build Speech LLM context (communication phases)
// Paste into: CODE - Build Speech LLM context (speech branch)
//
// Flow:
// 1. Resolve transcript (frontend Whisper / Groq backup)
// 2. Build scoring rubric prompt
// 3. Try multimodal audio scoring via speech_score_url (Vercel /api/score-speech)
// 4. If audio scoring succeeds → skip_llm_chain=true (bypass Basic LLM Chain)
// 5. Else → skip_llm_chain=false (existing Vertex text-only chain — unchanged fallback)

function isWeakTranscript(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^\[(no speech detected|timeout|audio recorded)/i.test(t)) return true;
  return t.split(/\s+/).filter(Boolean).length < 4;
}

function safeEnvVar(name) {
  try {
    return String($env[name] || '').trim();
  } catch (_) {
    return '';
  }
}

function pickCfgValue(...keys) {
  try {
    const cfg = $('CFG - Assessment Config').first().json || {};
    for (const key of keys) {
      const v = String(cfg[key] || '').trim();
      if (v) return v;
    }
  } catch (_) {}
  return '';
}

function resolveGroqKey(cfg) {
  return (
    pickCfgValue('groq_api_key') ||
    String(cfg?.groq_api_key || '').trim() ||
    safeEnvVar('GROQ_API_KEY')
  );
}

function resolveSpeechScoreUrl(cfg) {
  const direct =
    pickCfgValue('speech_score_url') ||
    String(cfg?.speech_score_url || '').trim() ||
    safeEnvVar('SPEECH_SCORE_URL');
  if (direct) return direct;
  const portal = String(cfg?.portal_base_url || pickCfgValue('portal_base_url') || '').replace(/\/+$/, '');
  return portal ? `${portal}/api/score-speech` : '';
}

function resolveGeminiKey(cfg) {
  return (
    pickCfgValue('gemini_api_key') ||
    String(cfg?.gemini_api_key || '').trim() ||
    safeEnvVar('GEMINI_API_KEY')
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

async function scoreViaSpeechApi(scoreUrl, prompt, audioUrl) {
  const url = String(scoreUrl || '').trim();
  const audio = String(audioUrl || '').trim();
  if (!url || !audio || !/^https?:\/\//i.test(url)) return null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, audio_url: audio }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok || !data?.text) return null;
    return {
      text: String(data.text).trim(),
      scoring_source: String(data.scoring_source || 'audio+transcript'),
    };
  } catch (_) {
    return null;
  }
}

async function scoreViaGeminiDirect(apiKey, prompt, audioUrl) {
  const key = String(apiKey || '').trim();
  const audio = String(audioUrl || '').trim();
  if (!key || !audio || !/^https?:\/\//i.test(audio)) return null;

  try {
    const audioRes = await fetch(audio);
    if (!audioRes.ok) return null;
    const buffer = await audioRes.arrayBuffer();
    if (!buffer || buffer.byteLength < 1200) return null;

    const mimeType = String(audioRes.headers.get('content-type') || 'audio/webm').split(';')[0].trim()
      || 'audio/webm';
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const audioBase64 = btoa(binary);

    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`;

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType.includes('audio') ? mimeType : 'audio/webm', data: audioBase64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });

    if (!geminiRes.ok) return null;
    const data = await geminiRes.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map((p) => p?.text || '').join('').trim();
    if (!rawText) return null;
    return { text: rawText, scoring_source: 'audio+transcript' };
  } catch (_) {
    return null;
  }
}

function buildSpeechLanes() {
  return [
    'Communication — explain a technical concept to a non-technical audience (clarity, patience, structure)',
    'Confidence & composure — pressure, deadline, conflict, or failure (tone, ownership, calm delivery)',
    'Professionalism & role fit — motivation for this role, collaboration, first 90 days (maturity, engagement)',
  ];
}

function buildFallbackQuestion(role, speechIndex) {
  const lanes = [
    `Describe a situation where you had to explain a complex technical topic to a non-technical stakeholder. How did you ensure they understood?`,
    `Tell me about a time you faced pressure, a tight deadline, or conflict at work. How did you communicate and stay composed?`,
    `Why are you interested in the ${role} role, and what would you focus on in your first 90 days?`,
  ];
  const idx = Math.max(0, Math.min(lanes.length - 1, Number(speechIndex || 1) - 1));
  return lanes[idx];
}

function buildScoringPrompt(cfg, ctx) {
  const {
    jdTitle,
    jdReq,
    cvText,
    speechHistory,
    currentQuestionText,
    answerText,
    metricsText,
    speechIndex,
    speechPhases,
    isFinal,
    nextLane,
  } = ctx;

  return `You are an expert behavioral interviewer evaluating SPOKEN communication for ${cfg.organization_name || 'the company'}.

ROLE: ${jdTitle}
COMMUNICATION round — speech phase ${speechIndex} of ${speechPhases} (after technical assessment).

IMPORTANT: You are given the candidate's AUDIO recording AND transcript. Listen to the audio for delivery:
- tone, pace, pauses, hesitation, energy, confidence, professionalism
Use the transcript for content accuracy and structure.

══════════════════════ SCORING DIMENSIONS (0–100 each) ══════════════════════
1. clarity — logical structure, easy to follow, complete thoughts
2. confidence — steady pace, minimal hesitation, assured delivery (from AUDIO + transcript)
3. professionalism — appropriate language, respectful tone, workplace-ready
4. relevance — directly answers the question (STAR format when behavioral)

Phase score = weighted average:
  clarity 30%, confidence 25%, professionalism 20%, relevance 25%

Delivery calibration (use audio + metrics):
- Listen for long awkward pauses, mumbling, monotone, or rushed speech → lower confidence/clarity
- High fillers with thin content → cap confidence ≤ 55
- Very slow pace (<90 WPM) with little substance → cap clarity ≤ 50
- Empty or < 20 words → all scores ≤ 15

JD context:
${jdReq.slice(0, 1500)}

CV excerpt (ground examples — do not invent employers/projects):
${cvText || '(none)'}

Prior speech Q&A:
${speechHistory || '(none yet)'}

Question this phase:
${currentQuestionText || '(see history)'}

Candidate transcript (STT):
${answerText}

Delivery metrics from recording: ${metricsText || 'not provided'}

${!isFinal ? `Next speech phase ${speechIndex + 1} focus: ${nextLane}` : 'FINAL speech phase — no next_question.'}

In feedback, cite BOTH content and delivery (e.g. "clear STAR structure" + "steady confident tone").
If audio is silent/unintelligible, say so and score ≤ 15.

OUTPUT — JSON ONLY:
${!isFinal
    ? '{"score":number,"clarity":number,"confidence":number,"professionalism":number,"relevance":number,"feedback":string,"next_question":string,"time_limit_seconds":number,"complexity_tier":"A"|"B"|"C"|"D"}'
    : '{"status":"finished","score":number,"clarity":number,"confidence":number,"professionalism":number,"relevance":number,"feedback":string,"next_question":""}'}`;
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
  requisition_title: sessionConfig.requisition_title || norm.config?.requisition_title || '',
  requisition_requirements: sessionConfig.requisition_requirements || norm.config?.requisition_requirements || '',
  portal_base_url: sessionConfig.portal_base_url || norm.config?.portal_base_url || pickCfgValue('portal_base_url') || '',
  groq_model: sessionConfig.groq_model || norm.config?.groq_model || 'llama-3.3-70b-versatile',
  max_questions: Number(sessionConfig.max_questions || norm.config?.max_questions || 5),
  speech_phases: Number(sessionConfig.speech_phases || norm.config?.speech_phases || 3),
  pass_score_threshold: Number(sessionConfig.pass_score_threshold ?? norm.config?.pass_score_threshold ?? 60),
  timer_min_seconds: Number(sessionConfig.timer_min_seconds ?? norm.config?.timer_min_seconds ?? 60),
  timer_max_seconds: Number(sessionConfig.timer_max_seconds ?? norm.config?.timer_max_seconds ?? 600),
  technical_weight: Number(sessionConfig.technical_weight ?? norm.config?.technical_weight ?? 0.7),
  speech_weight: Number(sessionConfig.speech_weight ?? norm.config?.speech_weight ?? 0.3),
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
const currentQuestionText = String(currentRow?.question_text || currentRow?.question || '').trim();

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
const browserWeak = isWeakTranscript(answerText);

if (audioUrl && groqKey && (browserWeak || !answerText)) {
  const whisperText = await transcribeWithGroqWhisper(audioUrl, groqKey);
  if (whisperText && !isWeakTranscript(whisperText)) {
    answerText = whisperText;
    sttSource = 'whisper';
  } else if (whisperText) {
    answerText = whisperText;
    sttSource = 'whisper_partial';
  }
} else if (audioUrl && browserWeak && !groqKey) {
  sttSource = 'browser_no_whisper_key';
}

const metrics = norm.speech_metrics || {};
const metricsText = [
  metrics.duration_seconds != null ? `duration_seconds: ${metrics.duration_seconds}` : '',
  metrics.words_per_minute != null ? `words_per_minute: ${metrics.words_per_minute}` : '',
  metrics.filler_word_count != null ? `filler_word_count: ${metrics.filler_word_count}` : '',
  metrics.long_pause_count != null ? `long_pause_count: ${metrics.long_pause_count}` : '',
  metrics.time_to_first_word_ms != null ? `time_to_first_word_ms: ${metrics.time_to_first_word_ms}` : '',
  metrics.avg_pause_ms != null ? `avg_pause_ms: ${metrics.avg_pause_ms}` : '',
  sttSource ? `stt_source: ${sttSource}` : '',
]
  .filter(Boolean)
  .join(', ');

const speechLanes = buildSpeechLanes();
const nextLane = !isFinal ? speechLanes[Math.min(speechIndex, speechLanes.length - 1)] : '';

const systemContent = buildScoringPrompt(cfg, {
  jdTitle,
  jdReq,
  cvText,
  speechHistory,
  currentQuestionText,
  answerText,
  metricsText,
  speechIndex,
  speechPhases,
  isFinal,
  nextLane,
});

let skipLlmChain = false;
let precomputedText = '';
let scoringSource = 'text-only';

if (audioUrl) {
  const scoreUrl = resolveSpeechScoreUrl(cfg);
  const geminiKey = resolveGeminiKey(cfg);

  let audioScore = null;
  if (scoreUrl) {
    audioScore = await scoreViaSpeechApi(scoreUrl, systemContent, audioUrl);
  }
  if (!audioScore && geminiKey) {
    audioScore = await scoreViaGeminiDirect(geminiKey, systemContent, audioUrl);
  }

  if (audioScore?.text) {
    skipLlmChain = true;
    precomputedText = audioScore.text;
    scoringSource = audioScore.scoring_source || 'audio+transcript';
  }
}

const resolvedNorm = {
  ...norm,
  answer: answerText,
  stt_source: sttSource,
  config: cfg,
};

return [
  {
    json: {
      groq_assessment_request: {
        model: cfg.groq_model || 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: 'Evaluate the spoken answer. Respond with JSON only.' },
        ],
        temperature: 0.25,
        response_format: { type: 'json_object' },
      },
      prompt: systemContent,
      text: precomputedText,
      skip_llm_chain: skipLlmChain,
      scoring_source: scoringSource,
      session,
      norm: resolvedNorm,
      isFinal,
      speech_index: speechIndex,
      speech_phases: speechPhases,
      max_questions: maxQ,
      current_question_text: currentQuestionText,
      transcribed_answer: answerText,
      stt_source: sttSource,
      fallback_next_question: !isFinal ? buildFallbackQuestion(jdTitle || 'this role', speechIndex + 1) : '',
    },
  },
];

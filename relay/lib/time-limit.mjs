const TIMER_MODEL = process.env.GEMINI_TIMER_MODEL || process.env.GEMINI_SCORE_MODEL || 'gemini-2.5-flash';

const SPEECH_TIMER_MIN_DEFAULT = 30;
const SPEECH_TIMER_MAX_DEFAULT = 120;

/** Voice interview per-question bounds (30s–2min). Written assessment uses separate n8n timer config. */
export function speechTimerBounds(config = {}) {
  const minRaw = Number(config?.speech_timer_min_seconds);
  const maxRaw = Number(config?.speech_timer_max_seconds);
  let min =
    Number.isFinite(minRaw) && minRaw > 0 ? minRaw : SPEECH_TIMER_MIN_DEFAULT;
  let max =
    Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : SPEECH_TIMER_MAX_DEFAULT;
  if (max < min) {
    min = SPEECH_TIMER_MIN_DEFAULT;
    max = SPEECH_TIMER_MAX_DEFAULT;
  }
  return { min, max };
}

export function timerBounds(config = {}) {
  return speechTimerBounds(config);
}

export function clampSeconds(sec, config = {}) {
  const { min, max } = timerBounds(config);
  return Math.min(max, Math.max(min, Math.round(sec)));
}

export function tierTimeRange(tier) {
  switch (String(tier || '').toUpperCase()) {
    case 'A':
      return [30, 45];
    case 'B':
      return [45, 75];
    case 'C':
      return [75, 105];
    case 'D':
      return [105, 120];
    default:
      return null;
  }
}

export function inferTierFromQuestion(questionText) {
  const q = String(questionText || '');
  const words = q.trim().split(/\s+/).filter(Boolean).length;
  const subParts =
    (q.match(/\?/g) || []).length +
    (q.match(/\b(and|also|furthermore|additionally|then|as well as)\b/gi) || []).length;
  const heavy =
    /\b(architecture|design|schema|scalable|scalability|concurrency|distributed|trade-?off|optimi[sz]e|throughput|migration|pipeline|multi-?tenant|security|performance|caching|indexing)\b/i.test(
      q
    );

  if (words <= 20 && subParts <= 1 && !heavy) return 'A';
  if (words >= 45 || (heavy && subParts >= 2)) return 'D';
  if (words >= 30 || heavy) return 'C';
  return 'B';
}

/** Tier band + question length + optional LLM value → seconds within speech bounds. */
export function deriveTimeLimitSeconds(rawLlmTime, tier, questionText, config = {}) {
  const bounds = timerBounds(config);
  const usableTier = tierTimeRange(tier) ? tier : inferTierFromQuestion(questionText);
  let [lo, hi] = tierTimeRange(usableTier) || [45, 75];
  lo = Math.max(bounds.min, lo);
  hi = Math.min(bounds.max, hi);
  if (hi < lo) hi = lo;

  const words = String(questionText || '').trim().split(/\s+/).filter(Boolean).length;
  const span = Math.max(1, 50 - 12);
  const t = Math.max(0, Math.min(1, (words - 12) / span));
  let computed = lo + t * (hi - lo);

  const llm = Number(rawLlmTime);
  if (Number.isFinite(llm) && llm >= bounds.min && llm <= bounds.max) {
    const blended = llm >= lo && llm <= hi ? (llm + computed) / 2 : llm;
    computed = blended;
  }

  let sec = Math.round(computed / 5) * 5;
  sec = Math.max(lo, Math.min(hi, sec));
  return { seconds: clampSeconds(sec, config), tier: usableTier };
}

export function buildTimerConfig(context = {}) {
  const cfg = { ...(context.config || {}), ...context };
  const bounds = speechTimerBounds(cfg);
  return {
    ...bounds,
    timer_min_seconds: bounds.min,
    timer_max_seconds: bounds.max,
    speech_timer_min_seconds: bounds.min,
    speech_timer_max_seconds: bounds.max,
    speech_answer_seconds: cfg.speech_answer_seconds,
  };
}

export function fallbackTimeLimit(questionText, context = {}) {
  const cfg = buildTimerConfig(context);
  const fallbackSec = Number(cfg.speech_answer_seconds);
  if (Number.isFinite(fallbackSec) && fallbackSec > 0) {
    return {
      seconds: clampSeconds(fallbackSec, cfg),
      tier: inferTierFromQuestion(questionText),
    };
  }
  return deriveTimeLimitSeconds(null, null, questionText, cfg);
}

function safeParseJson(rawText) {
  let text = String(rawText || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch (_) {
      return {};
    }
  }
}

/** Lightweight Gemini call — assigns complexity_tier + time_limit_seconds for a voice question. */
export async function aiDeriveQuestionTimeLimit({
  apiKey,
  questionText,
  config = {},
  role = 'the role',
  previousLimit = null,
  timeoutMs = 8000,
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY missing for timer');
  const q = String(questionText || '').trim();
  if (!q) return fallbackTimeLimit(q, config);

  const bounds = speechTimerBounds(buildTimerConfig(config));
  const prevHint = previousLimit?.seconds
    ? `Previous question used ${previousLimit.seconds}s (tier ${previousLimit.tier || 'B'}). If this question is simpler, use less time; if harder or longer, use more. Do not repeat the same seconds unless complexity is identical.`
    : '';

  const prompt = `You assign answer time limits for live voice interview questions (${role}).

Return JSON only:
{
  "complexity_tier": "A" | "B" | "C" | "D",
  "time_limit_seconds": <integer ${bounds.min}-${bounds.max}>
}

Tier guide (voice answers are brief — max ${bounds.max}s total):
- A: quick/simple (30-45s)
- B: moderate behavioural (45-75s)
- C: scenario or multi-part (75-105s)
- D: deep/complex (105-120s)

Pick a specific second value inside the tier band based on question length and difficulty.

${prevHint}

Question:
${q.slice(0, 2000)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TIMER_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const fetchPromise = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    }),
  });

  const res = await Promise.race([
    fetchPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timer_ai_timeout')), timeoutMs)),
  ]);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`timer_ai_failed ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const parsed = safeParseJson(rawText);
  return deriveTimeLimitSeconds(
    parsed.time_limit_seconds,
    parsed.complexity_tier,
    q,
    buildTimerConfig(config)
  );
}

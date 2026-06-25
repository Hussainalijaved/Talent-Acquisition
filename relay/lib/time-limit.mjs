const TIMER_MODEL = process.env.GEMINI_TIMER_MODEL || process.env.GEMINI_SCORE_MODEL || 'gemini-2.5-flash';

export function timerBounds(config = {}) {
  const min = Number(config?.timer_min_seconds);
  const max = Number(config?.timer_max_seconds);
  return {
    min: Number.isFinite(min) && min > 0 ? min : 60,
    max: Number.isFinite(max) && max > 0 ? max : 600,
  };
}

export function clampSeconds(sec, config = {}) {
  const { min, max } = timerBounds(config);
  return Math.min(max, Math.max(min, Math.round(sec)));
}

export function tierTimeRange(tier) {
  switch (String(tier || '').toUpperCase()) {
    case 'A':
      return [60, 120];
    case 'B':
      return [150, 240];
    case 'C':
      return [270, 390];
    case 'D':
      return [420, 600];
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

  if (words <= 28 && subParts <= 1 && !heavy) return 'A';
  if (words >= 80 || (heavy && subParts >= 3)) return 'D';
  if (words >= 50 || heavy) return 'C';
  return 'B';
}

/** Same algorithm as n8n_code_parse_assessment_result.js — tier band + length + optional LLM blend. */
export function deriveTimeLimitSeconds(rawLlmTime, tier, questionText, config = {}) {
  const usableTier = tierTimeRange(tier) ? tier : inferTierFromQuestion(questionText);
  const [lo, hi] = tierTimeRange(usableTier) || [150, 240];

  const words = String(questionText || '').trim().split(/\s+/).filter(Boolean).length;
  const span = Math.max(1, 90 - 20);
  const t = Math.max(0, Math.min(1, (words - 20) / span));
  let computed = lo + t * (hi - lo);

  const llm = Number(rawLlmTime);
  if (Number.isFinite(llm) && llm >= lo && llm <= hi) {
    computed = (llm + computed) / 2;
  }

  let sec = Math.round(computed / 15) * 15;
  sec = Math.max(lo, Math.min(hi, sec));
  return { seconds: clampSeconds(sec, config), tier: usableTier };
}

export function buildTimerConfig(context = {}) {
  const cfg = { ...(context.config || {}), ...context };
  return {
    timer_min_seconds: cfg.timer_min_seconds,
    timer_max_seconds: cfg.timer_max_seconds,
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

  const prevHint = previousLimit?.seconds
    ? `Previous question used ${previousLimit.seconds}s (tier ${previousLimit.tier || 'B'}). If this question is simpler, use less time; if harder or longer, use more. Do not repeat the same seconds unless complexity is identical.`
    : '';

  const prompt = `You assign answer time limits for live voice interview questions (${role}).

Return JSON only:
{
  "complexity_tier": "A" | "B" | "C" | "D",
  "time_limit_seconds": <integer 60-600>
}

Tier guide:
- A: short/simple (60-120s)
- B: moderate behavioural (150-240s)
- C: multi-part or scenario (270-390s)
- D: deep/architecture (420-600s)

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

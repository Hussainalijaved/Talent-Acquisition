const SCORE_MODEL = process.env.GEMINI_SCORE_MODEL || 'gemini-2.0-flash';

// Tolerant JSON parse: strip fences, extract the first balanced object, repair
// trailing commas. Returns {} on total failure so scoring never throws away a turn.
function safeParseJson(rawText) {
  let text = String(rawText || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  if (!text) return {};
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch (_) {
      try {
        return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
      } catch (_) {
        return null;
      }
    }
  };
  let parsed = tryParse(text);
  if (parsed) return parsed;
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          parsed = tryParse(text.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }
  return {};
}

export async function scoreSingleTurn({ apiKey, context, turn }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY missing for scoring');
  const role = String(context.requisition_title || 'the role');
  const prompt = `Score this live voice interview answer for ${role}. Return JSON only:
{"phase":number,"score":number,"clarity":number,"confidence":number,"professionalism":number,"relevance":number,"feedback":string}

Phase ${turn.phase}
Q: ${turn.question_text}
A: ${turn.answer_text}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${SCORE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`gemini_single_score_failed ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const parsed = safeParseJson(rawText);

  return {
    ...turn,
    score: Math.round(Number(parsed.score ?? 0)),
    clarity: Math.round(Number(parsed.clarity ?? parsed.score ?? 0)),
    confidence: Math.round(Number(parsed.confidence ?? parsed.score ?? 0)),
    professionalism: Math.round(Number(parsed.professionalism ?? parsed.score ?? 0)),
    relevance: Math.round(Number(parsed.relevance ?? parsed.score ?? 0)),
    feedback: String(parsed.feedback || '').trim(),
    soft_skills: {
      clarity: Math.round(Number(parsed.clarity ?? parsed.score ?? 0)),
      confidence: Math.round(Number(parsed.confidence ?? parsed.score ?? 0)),
      professionalism: Math.round(Number(parsed.professionalism ?? parsed.score ?? 0)),
      relevance: Math.round(Number(parsed.relevance ?? parsed.score ?? 0)),
    },
    scoring_source: 'gemini_live_relay',
    stt_source: 'gemini_live',
  };
}

export async function postPartialTurnWebhook(context, payload) {
  const url = String(context.live_complete_webhook || process.env.LIVE_COMPLETE_WEBHOOK || '').trim();
  if (!url) {
    // Loud failure: a missing webhook URL is the #1 reason voice turns silently
    // never reach the database. Surface it instead of skipping quietly.
    throw new Error(
      'live_complete_webhook missing — set live_complete_webhook (or n8n_public_url) in CFG - Live Speech Config so voice turns can be saved.'
    );
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
    },
    body: JSON.stringify({ ...payload, partial: true }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`partial_webhook_failed ${res.status}: ${text.slice(0, 300)}`);
  }
  return { ok: true, status: res.status, body: json };
}

export async function scoreLiveTurns({ apiKey, context, turns }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY missing for scoring');
  if (!turns.length) {
    return { turns: [], combined_speech_score: 0, final_feedback: 'No speech turns captured.' };
  }

  const role = String(context.requisition_title || 'the role');
  const prompt = `You are scoring a live voice interview for ${role}.
Score each Q&A turn 0-100 on clarity, confidence, professionalism, relevance.
Return JSON only:
{
  "turns": [
    {
      "phase": number,
      "score": number,
      "clarity": number,
      "confidence": number,
      "professionalism": number,
      "relevance": number,
      "feedback": string
    }
  ],
  "combined_speech_score": number,
  "final_feedback": string
}

Turns:
${turns
  .map(
    (t, i) =>
      `Turn ${i + 1} (phase ${t.phase})
Q: ${t.question_text}
A: ${t.answer_text}`
  )
  .join('\n\n')}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${SCORE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`gemini_score_failed ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const parsed = safeParseJson(rawText);

  const scoredByPhase = new Map((parsed.turns || []).map((t) => [Number(t.phase), t]));
  const merged = turns.map((t) => {
    const s = scoredByPhase.get(Number(t.phase)) || {};
    return {
      ...t,
      score: Math.round(Number(s.score ?? 0)),
      clarity: Math.round(Number(s.clarity ?? s.score ?? 0)),
      confidence: Math.round(Number(s.confidence ?? s.score ?? 0)),
      professionalism: Math.round(Number(s.professionalism ?? s.score ?? 0)),
      relevance: Math.round(Number(s.relevance ?? s.score ?? 0)),
      feedback: String(s.feedback || '').trim(),
      soft_skills: {
        clarity: Math.round(Number(s.clarity ?? s.score ?? 0)),
        confidence: Math.round(Number(s.confidence ?? s.score ?? 0)),
        professionalism: Math.round(Number(s.professionalism ?? s.score ?? 0)),
        relevance: Math.round(Number(s.relevance ?? s.score ?? 0)),
      },
      scoring_source: 'gemini_live_relay',
      stt_source: 'gemini_live',
    };
  });

  const scores = merged.map((t) => Number(t.score)).filter((n) => Number.isFinite(n));
  const combined =
    parsed.combined_speech_score != null && Number.isFinite(Number(parsed.combined_speech_score))
      ? Math.round(Number(parsed.combined_speech_score))
      : scores.length
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;

  return {
    turns: merged,
    combined_speech_score: combined,
    final_feedback: String(parsed.final_feedback || '').trim(),
  };
}

export async function postCompleteWebhook(context, payload) {
  const url = String(context.live_complete_webhook || process.env.LIVE_COMPLETE_WEBHOOK || '').trim();
  if (!url) {
    return { ok: false, skipped: true, reason: 'live_complete_webhook missing' };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`complete_webhook_failed ${res.status}: ${text.slice(0, 300)}`);
  }
  return { ok: true, status: res.status, body: json };
}

const SCORE_MODEL = process.env.GEMINI_SCORE_MODEL || 'gemini-2.0-flash';

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
  const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);

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

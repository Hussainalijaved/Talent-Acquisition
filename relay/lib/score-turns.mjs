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

// ─────────────────────────────────────────────────────────────────────────────
// Direct Supabase save — primary persistence path, no n8n dependency.
// Fetches the current session, merges voice turns into interview_history, then
// PATCHes the row with final scores and status=completed.
// ─────────────────────────────────────────────────────────────────────────────
export async function directSaveToSupabase(context, scoredTurns, {
  combinedSpeechScore = 0,
  finalFeedback = '',
  durationSeconds = 0,
} = {}) {
  const supabaseUrl = String(
    context.config?.supabase_url || context.supabase_url || ''
  ).replace(/\/+$/, '');
  const supabaseKey = String(
    context.config?.supabase_key || context.supabase_key || ''
  );
  const sessionId  = String(context.session_id || '');
  const maxQ       = Number(context.max_questions || 5);
  const speechPhases = Number(context.speech_phases || 5);
  const table      = String(context.config?.table_assessment_sessions || 'assessment_sessions');

  if (!supabaseUrl || !/^https?:\/\//i.test(supabaseUrl)) {
    throw new Error(
      'directSaveToSupabase: supabase_url missing or invalid in context.config. ' +
      'Set supabase_url in CFG - Live Speech Config (start).'
    );
  }
  if (!supabaseKey) {
    throw new Error('directSaveToSupabase: supabase_key missing in context.config.');
  }
  if (!sessionId) {
    throw new Error('directSaveToSupabase: session_id missing in context.');
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  // 1. Fetch current session to get existing interview_history + technical_score.
  const fetchUrl = `${supabaseUrl}/rest/v1/${table}?id=eq.${encodeURIComponent(sessionId)}&select=id,interview_history,technical_score,config`;
  const fetchRes = await fetch(fetchUrl, { headers });
  if (!fetchRes.ok) {
    const errText = await fetchRes.text();
    throw new Error(`directSave: fetch session failed ${fetchRes.status}: ${errText.slice(0, 200)}`);
  }
  const rows = await fetchRes.json();
  const session = Array.isArray(rows) ? rows[0] : rows;
  if (!session?.id) throw new Error(`directSave: session not found for id=${sessionId}`);

  let history = session.interview_history;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch (_) { history = []; }
  }
  if (!Array.isArray(history)) history = [];

  const iso = new Date().toISOString();

  // 2. Merge scored voice turns into history.
  for (const turn of scoredTurns) {
    const ph = Number(turn.phase);
    if (!Number.isFinite(ph) || ph <= maxQ) continue;
    const patch = {
      phase: ph,
      mode: 'live_speech',
      voice_question_number: Number(turn.voice_question_number || ph - maxQ) || null,
      question_text:  String(turn.question_text  || '').trim(),
      answer_text:    String(turn.answer_text    || '').trim(),
      received_at:    turn.received_at || iso,
      sent_at:        turn.sent_at     || iso,
      feedback:       turn.feedback    || null,
      score: Math.max(0, Math.min(100, Math.round(Number(turn.score ?? 0)))),
      soft_skills: turn.soft_skills || {
        clarity:         Math.round(Number(turn.clarity         ?? turn.score ?? 0)),
        confidence:      Math.round(Number(turn.confidence      ?? turn.score ?? 0)),
        professionalism: Math.round(Number(turn.professionalism ?? turn.score ?? 0)),
        relevance:       Math.round(Number(turn.relevance       ?? turn.score ?? 0)),
      },
      stt_source:     'gemini_live',
      scoring_source: 'gemini_live_relay',
    };
    const idx = history.findIndex((x) => Number(x.phase) === ph);
    if (idx >= 0) history[idx] = { ...history[idx], ...patch };
    else history.push(patch);
  }

  // 3. Compute final scores.
  const techAvg = Number(session.technical_score) || 0;
  const speechScores = scoredTurns
    .map((t) => Number(t.score))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const speechAvg = speechScores.length
    ? Math.round(speechScores.reduce((a, b) => a + b, 0) / speechScores.length)
    : (combinedSpeechScore || 0);

  const techWeight    = Number(context.config?.technical_weight    ?? 0.7);
  const speechWeight  = Number(context.config?.speech_weight       ?? 0.3);
  const passThreshold = Number(context.config?.pass_score_threshold ?? 60);
  const combined = techAvg > 0
    ? Math.round(techAvg * techWeight + speechAvg * speechWeight)
    : speechAvg;
  const result = combined >= passThreshold ? 'PASS' : 'FAIL';

  const feedbackLine = [
    finalFeedback,
    `Technical: ${techAvg}/100 | Voice: ${speechAvg}/100 | Combined: ${combined}/100 (pass ${passThreshold}).`,
  ].filter(Boolean).join(' ');

  // 4. PATCH session row.
  const body = {
    interview_history:            history,
    updated_at:                   iso,
    assessment_stage:             'completed',
    current_phase:                maxQ + speechPhases,
    status:                       'completed',
    technical_score:              techAvg,
    speech_score:                 speechAvg,
    score:                        combined,
    result,
    live_speech_duration_seconds: durationSeconds || null,
  };

  const patchUrl = `${supabaseUrl}/rest/v1/${table}?id=eq.${encodeURIComponent(sessionId)}`;
  const patchRes = await fetch(patchUrl, {
    method:  'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body:    JSON.stringify(body),
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text();
    throw new Error(`directSave: PATCH failed ${patchRes.status}: ${errText.slice(0, 300)}`);
  }

  console.log(`[relay] directSave OK — session ${sessionId} | combined=${combined} | result=${result}`);
  return { ok: true, combined, result, speechAvg, techAvg, feedback: feedbackLine };
}

export async function postCompleteWebhook(context, payload) {
  const url = String(context.live_complete_webhook || process.env.LIVE_COMPLETE_WEBHOOK || '').trim();
  if (!url) {
    // This is always a misconfiguration — fail loudly so relay logs show it.
    throw new Error(
      'live_complete_webhook missing — set live_complete_webhook (or n8n_public_url) in CFG - Live Speech Config so the interview result can be saved. ' +
      'URL format: https://your-n8n-instance.com/webhook/talent/live-speech-complete'
    );
  }

  console.log(`[relay] POST complete webhook → ${url} (${payload.turns?.length ?? 0} turns)`);
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
    console.error(`[relay] complete webhook HTTP ${res.status}: ${text.slice(0, 400)}`);
    throw new Error(`complete_webhook_failed ${res.status}: ${text.slice(0, 300)}`);
  }
  console.log(`[relay] complete webhook saved — HTTP ${res.status}`);
  return { ok: true, status: res.status, body: json };
}

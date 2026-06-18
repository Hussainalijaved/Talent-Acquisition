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
    const s = scoredByPhase.get(Number(t.phase));
    // No score for this turn in the model output → return null so the merge keeps
    // whatever score was already saved per-question (never overwrite with 0).
    if (!s || s.score == null || !Number.isFinite(Number(s.score))) {
      return { ...t, score: null };
    }
    return {
      ...t,
      score: Math.round(Number(s.score)),
      clarity: Math.round(Number(s.clarity ?? s.score)),
      confidence: Math.round(Number(s.confidence ?? s.score)),
      professionalism: Math.round(Number(s.professionalism ?? s.score)),
      relevance: Math.round(Number(s.relevance ?? s.score)),
      feedback: String(s.feedback || '').trim(),
      soft_skills: {
        clarity: Math.round(Number(s.clarity ?? s.score)),
        confidence: Math.round(Number(s.confidence ?? s.score)),
        professionalism: Math.round(Number(s.professionalism ?? s.score)),
        relevance: Math.round(Number(s.relevance ?? s.score)),
      },
      scoring_source: 'gemini_live_relay',
      stt_source: 'gemini_live',
    };
  });

  const scores = merged
    .filter((t) => t.score != null && Number.isFinite(Number(t.score)))
    .map((t) => Number(t.score));
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
// ─────────────────────────────────────────────────────────────────────────────

function getSupabaseConfig(context) {
  const supabaseUrl = String(
    context.config?.supabase_url || context.supabase_url || ''
  ).replace(/\/+$/, '');
  const supabaseKey = String(
    context.config?.supabase_key || context.supabase_key || ''
  );
  const sessionId = String(context.session_id || '');
  const maxQ = Number(context.max_questions || 5);
  const speechPhases = Number(context.speech_phases || 5);
  const table = String(context.config?.table_assessment_sessions || 'assessment_sessions');

  if (!supabaseUrl || !/^https?:\/\//i.test(supabaseUrl)) {
    throw new Error(
      'supabase_url missing or invalid in context.config — set supabase_url in CFG - Live Speech Config (start).'
    );
  }
  if (!supabaseKey) throw new Error('supabase_key missing in context.config.');
  if (!sessionId) throw new Error('session_id missing in context.');

  return {
    supabaseUrl,
    supabaseKey,
    sessionId,
    maxQ,
    speechPhases,
    table,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    },
  };
}

async function fetchSessionRow(cfg) {
  const fetchUrl =
    `${cfg.supabaseUrl}/rest/v1/${cfg.table}?id=eq.${encodeURIComponent(cfg.sessionId)}` +
    '&select=id,interview_history,technical_score,config';
  const fetchRes = await fetch(fetchUrl, { headers: cfg.headers });
  if (!fetchRes.ok) {
    const errText = await fetchRes.text();
    throw new Error(`directSave: fetch session failed ${fetchRes.status}: ${errText.slice(0, 200)}`);
  }
  const rows = await fetchRes.json();
  const session = Array.isArray(rows) ? rows[0] : rows;
  if (!session?.id) throw new Error(`directSave: session not found for id=${cfg.sessionId}`);
  return session;
}

function parseHistory(raw) {
  let history = raw;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch (_) { history = []; }
  }
  return Array.isArray(history) ? history : [];
}

function mergeTurnsIntoHistory(history, turns, maxQ, iso = new Date().toISOString()) {
  const merged = [...history];
  for (const turn of turns) {
    const ph = Number(turn.phase);
    if (!Number.isFinite(ph) || ph <= maxQ) continue;

    const idx = merged.findIndex((x) => Number(x.phase) === ph);
    const existing = idx >= 0 ? merged[idx] : {};

    // Only treat the incoming score as valid when it is a real finite number.
    // A null/undefined score means "not scored this pass" — in that case we MUST
    // preserve any score already saved for this turn (e.g. from the per-question
    // incremental save), never overwrite it with 0.
    const hasNewScore = turn.score != null && Number.isFinite(Number(turn.score));
    const score = hasNewScore
      ? Math.max(0, Math.min(100, Math.round(Number(turn.score))))
      : (existing.score ?? null);

    const softSkills = turn.soft_skills
      || (hasNewScore
        ? {
            clarity: Math.round(Number(turn.clarity ?? turn.score ?? 0)),
            confidence: Math.round(Number(turn.confidence ?? turn.score ?? 0)),
            professionalism: Math.round(Number(turn.professionalism ?? turn.score ?? 0)),
            relevance: Math.round(Number(turn.relevance ?? turn.score ?? 0)),
          }
        : (existing.soft_skills ?? null));

    const patch = {
      phase: ph,
      mode: 'live_speech',
      voice_question_number:
        Number(turn.voice_question_number || ph - maxQ) || existing.voice_question_number || null,
      question_text: String(turn.question_text || existing.question_text || '').trim(),
      answer_text: String(turn.answer_text || existing.answer_text || '').trim(),
      received_at: turn.received_at || existing.received_at || iso,
      sent_at: turn.sent_at || existing.sent_at || iso,
      feedback: turn.feedback || existing.feedback || null,
      score,
      soft_skills: softSkills,
      stt_source: 'gemini_live',
      scoring_source: 'gemini_live_relay',
    };
    if (idx >= 0) merged[idx] = { ...existing, ...patch };
    else merged.push(patch);
  }
  return merged;
}

async function patchSessionRow(cfg, body) {
  const patchUrl = `${cfg.supabaseUrl}/rest/v1/${cfg.table}?id=eq.${encodeURIComponent(cfg.sessionId)}`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { ...cfg.headers, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!patchRes.ok) {
    const errText = await patchRes.text();
    throw new Error(`directSave: PATCH failed ${patchRes.status}: ${errText.slice(0, 300)}`);
  }
}

// Incremental save after each voice Q&A — survives crashes mid-interview.
export async function directSavePartialTurn(context, turn) {
  const cfg = getSupabaseConfig(context);
  const session = await fetchSessionRow(cfg);
  const iso = new Date().toISOString();
  const history = mergeTurnsIntoHistory(parseHistory(session.interview_history), [turn], cfg.maxQ, iso);
  const phase = Number(turn.phase || cfg.maxQ + 1);

  await patchSessionRow(cfg, {
    interview_history: history,
    updated_at: iso,
    assessment_stage: 'live_speech',
    current_phase: phase,
    status: 'assessment',
  });

  console.log(`[relay] partial save OK — session ${cfg.sessionId} phase ${phase}`);
  return { ok: true, phase, partial: true };
}

export async function directSaveToSupabase(context, scoredTurns, {
  combinedSpeechScore = 0,
  finalFeedback = '',
  durationSeconds = 0,
} = {}) {
  const cfg = getSupabaseConfig(context);
  const session = await fetchSessionRow(cfg);
  const iso = new Date().toISOString();
  const history = mergeTurnsIntoHistory(parseHistory(session.interview_history), scoredTurns, cfg.maxQ, iso);

  // Compute final scores. Read speech scores from the MERGED history (which already
  // contains every per-question incremental save), so a timed-out final re-score
  // can never wipe scores that were saved during the interview.
  const techAvg = Number(session.technical_score) || 0;
  const speechScores = history
    .filter((h) => Number(h.phase) > cfg.maxQ && h.score != null && Number.isFinite(Number(h.score)))
    .map((h) => Number(h.score));
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

  await patchSessionRow(cfg, {
    interview_history:            history,
    updated_at:                   iso,
    assessment_stage:             'completed',
    current_phase:                cfg.maxQ + cfg.speechPhases,
    status:                       'completed',
    technical_score:              techAvg,
    speech_score:                 speechAvg,
    score:                        combined,
    result,
    live_speech_duration_seconds: durationSeconds || null,
  });

  console.log(`[relay] directSave OK — session ${cfg.sessionId} | combined=${combined} | result=${result}`);
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

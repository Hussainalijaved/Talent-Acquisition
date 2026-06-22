import { cleanUserAnswerText } from './transcript-utils.mjs';

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
  const isNoResponse = !turn.answer_text ||
    /^\[(no spoken|non-english|no speech|noise)/i.test(turn.answer_text) ||
    (!cleanUserAnswerText(turn.answer_text) && String(turn.answer_text || '').trim().length < 12);

  // Short-circuit unscorable answers — avoids API call and score=0 parse bug.
  if (isNoResponse) {
    const zero = {
      communication_clarity: 0,
      fluency: 0,
      confidence: 0,
      professionalism: 0,
      english_proficiency: 0,
      answer_relevance: 0,
      clarity: 0,
      relevance: 0,
    };
    const feedback = /non-english/i.test(turn.answer_text)
      ? 'Please answer in English. Non-English responses cannot be evaluated for communication skills.'
      : /^\[noise\]/i.test(turn.answer_text)
        ? 'No clear speech detected — background noise or unintelligible audio.'
        : 'No spoken response was captured for this question.';
    return {
      ...turn,
      score: 0,
      clarity: 0,
      confidence: 0,
      professionalism: 0,
      relevance: 0,
      feedback,
      soft_skills: zero,
      scoring_source: 'gemini_live_relay',
      stt_source: 'gemini_live',
    };
  }

  const prompt = `You are evaluating a live voice interview answer for a ${role} position.
This is a COMMUNICATION SKILLS round — score the candidate on HOW they speak, not just WHAT they say.

Return JSON only (no markdown, no explanation):
{
  "phase": ${turn.phase},
  "score": <overall 0-100>,
  "communication_clarity": <0-100, clear articulation, logical flow, easy to follow>,
  "fluency": <0-100, smooth delivery, natural pace, minimal filler words>,
  "confidence": <0-100, assertive tone, no excessive hedging, speaks with conviction>,
  "professionalism": <0-100, appropriate tone, formal register, respectful>,
  "english_proficiency": <0-100, grammar, vocabulary, pronunciation quality>,
  "answer_relevance": <0-100, did they actually answer what was asked>,
  "feedback": "<2-3 sentences: what was strong, what to improve in communication style>"
}

Question: ${turn.question_text}
Candidate's transcribed answer: ${turn.answer_text}`;

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

  const parsedScore = parsed.score != null ? Number(parsed.score) : null;
  const parsedClarity = parsed.communication_clarity != null
    ? Number(parsed.communication_clarity) : null;

  // Heuristic fallback: never return null — base on transcript length + English-ness.
  // This guarantees a saved score even when Gemini returns malformed JSON.
  const buildHeuristicScore = () => {
    const a = String(turn.answer_text || '').trim();
    const words = a.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    let base = 30;
    if (wordCount >= 8) base = 45;
    if (wordCount >= 20) base = 55;
    if (wordCount >= 40) base = 60;
    return {
      score: base,
      soft: {
        communication_clarity: base,
        fluency: base,
        confidence: base - 5,
        professionalism: base,
        english_proficiency: base,
        answer_relevance: Math.max(0, base - 10),
        clarity: base,
        relevance: Math.max(0, base - 10),
      },
      feedback:
        'Automatic fallback score — the scoring model returned an unparseable response. ' +
        'Heuristic based on transcript length; consider re-scoring offline if needed.',
    };
  };

  if (!Number.isFinite(parsedScore) && !Number.isFinite(parsedClarity)) {
    console.warn(
      `[relay] scoreSingleTurn parse empty for phase ${turn.phase}; using heuristic. Raw: ${rawText.slice(0, 200)}`
    );
    const h = buildHeuristicScore();
    return {
      ...turn,
      score: h.score,
      clarity: h.soft.communication_clarity,
      confidence: h.soft.confidence,
      professionalism: h.soft.professionalism,
      relevance: h.soft.answer_relevance,
      feedback: h.feedback,
      soft_skills: h.soft,
      scoring_source: 'gemini_live_relay_heuristic',
      stt_source: 'gemini_live',
    };
  }

  const overall = Math.round(Number(parsed.score ?? parsed.communication_clarity ?? 0));
  const soft = {
    communication_clarity: Math.round(Number(parsed.communication_clarity ?? parsed.score ?? 0)),
    fluency:               Math.round(Number(parsed.fluency               ?? parsed.score ?? 0)),
    confidence:            Math.round(Number(parsed.confidence            ?? parsed.score ?? 0)),
    professionalism:       Math.round(Number(parsed.professionalism       ?? parsed.score ?? 0)),
    english_proficiency:   Math.round(Number(parsed.english_proficiency   ?? parsed.score ?? 0)),
    answer_relevance:      Math.round(Number(parsed.answer_relevance      ?? parsed.score ?? 0)),
    // Legacy keys for admin dashboard
    clarity:               Math.round(Number(parsed.communication_clarity ?? parsed.clarity ?? parsed.score ?? 0)),
    relevance:             Math.round(Number(parsed.answer_relevance      ?? parsed.relevance ?? parsed.score ?? 0)),
  };

  return {
    ...turn,
    score: overall,
    clarity:        soft.communication_clarity,
    confidence:     soft.confidence,
    professionalism: soft.professionalism,
    relevance:      soft.answer_relevance,
    feedback:       String(parsed.feedback || '').trim(),
    soft_skills:    soft,
    scoring_source: 'gemini_live_relay',
    stt_source:     'gemini_live',
  };
}

/** Always returns a scored turn — never throws, never leaves score null. */
export async function scoreTurnGuaranteed({ apiKey, context, turn, timeoutMs = 30000 }) {
  try {
    const scored = await Promise.race([
      scoreSingleTurn({ apiKey, context, turn }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('single_score_timeout')), timeoutMs)
      ),
    ]);
    if (scored.score != null && Number.isFinite(Number(scored.score))) return scored;
  } catch (err) {
    console.warn(`[relay] scoreTurnGuaranteed API failed phase ${turn.phase}:`, err.message);
  }

  const a = String(turn.answer_text || '').trim();
  const isUnscorable = !a ||
    /^\[(no spoken|non-english|no speech|noise)/i.test(a) ||
    (!cleanUserAnswerText(a) && a.length < 12);

  if (isUnscorable) {
    const zero = {
      communication_clarity: 0, fluency: 0, confidence: 0,
      professionalism: 0, english_proficiency: 0, answer_relevance: 0,
      clarity: 0, relevance: 0,
    };
    return {
      ...turn,
      score: 0,
      clarity: 0, confidence: 0, professionalism: 0, relevance: 0,
      soft_skills: zero,
      feedback: /non-english/i.test(a)
        ? 'Please answer in English. Non-English responses cannot be evaluated.'
        : 'No spoken response captured for this question.',
      scoring_source: 'gemini_live_relay',
      stt_source: 'gemini_live',
    };
  }

  const wordCount = a.split(/\s+/).filter(Boolean).length;
  const base = wordCount >= 40 ? 60 : wordCount >= 20 ? 55 : wordCount >= 8 ? 45 : 30;
  const soft = {
    communication_clarity: base, fluency: base, confidence: Math.max(0, base - 5),
    professionalism: base, english_proficiency: base,
    answer_relevance: Math.max(0, base - 10),
    clarity: base, relevance: Math.max(0, base - 10),
  };
  return {
    ...turn,
    score: base,
    clarity: soft.clarity, confidence: soft.confidence,
    professionalism: soft.professionalism, relevance: soft.relevance,
    soft_skills: soft,
    feedback: 'Automatic fallback score — scoring service was slow or unavailable.',
    scoring_source: 'gemini_live_relay_heuristic',
    stt_source: 'gemini_live',
  };
}

/** Score turns one-by-one (reliable — bulk scoring often times out on 5 turns). */
export async function scoreTurnsSequential({ apiKey, context, turns, timeoutMs = 30000 }) {
  const results = [];
  for (const turn of turns) {
    const scored = await scoreTurnGuaranteed({ apiKey, context, turn, timeoutMs });
    results.push(scored);
    console.log(`[relay] scored phase ${turn.phase}: ${scored.score}`);
  }
  return results;
}

/** Pull already-saved per-turn scores from DB so final save never loses them. */
export async function enrichTurnsFromDb(context, turns) {
  try {
    const cfg = getSupabaseConfig(context);
    const session = await fetchSessionRow(cfg);
    const byPhase = new Map(
      parseHistory(session.interview_history).map((h) => [Number(h.phase), h])
    );
    return turns.map((t) => {
      if (t.score != null && Number.isFinite(Number(t.score))) return t;
      const db = byPhase.get(Number(t.phase));
      if (db?.score != null && Number.isFinite(Number(db.score))) {
        return {
          ...t,
          score: Number(db.score),
          feedback: db.feedback || t.feedback,
          soft_skills: db.soft_skills || t.soft_skills,
        };
      }
      return t;
    });
  } catch (err) {
    console.warn('[relay] enrichTurnsFromDb failed:', err.message);
    return turns;
  }
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
  const prompt = `You are evaluating a full live voice interview for a ${role} position.
This is a COMMUNICATION SKILLS round. Score each answer on HOW the candidate communicates.

Return JSON only:
{
  "turns": [
    {
      "phase": <number>,
      "score": <overall 0-100>,
      "communication_clarity": <0-100>,
      "fluency": <0-100>,
      "confidence": <0-100>,
      "professionalism": <0-100>,
      "english_proficiency": <0-100>,
      "answer_relevance": <0-100>,
      "feedback": "<2-3 sentences on communication strengths and areas to improve>"
    }
  ],
  "combined_speech_score": <0-100 weighted average>,
  "final_feedback": "<overall summary of the candidate's communication profile>"
}

Scoring dimensions:
- communication_clarity: clear articulation, logical structure, easy to follow
- fluency: smooth delivery, natural pace, no excessive filler words
- confidence: assertive tone, speaks with conviction, no excessive hedging
- professionalism: appropriate register, respectful, interview-ready demeanor
- english_proficiency: grammar, vocabulary range, pronunciation quality
- answer_relevance: did they actually address what was asked (bonus dimension)

For turns with [No spoken response] or [Non-English response]: score 0 across all dimensions.

Turns:
${turns.map((t, i) => `Turn ${i + 1} (phase ${t.phase})
Q: ${t.question_text}
A: ${t.answer_text}`).join('\n\n')}`;

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
    if (!s || s.score == null || !Number.isFinite(Number(s.score))) {
      // No score from model → preserve whatever was already saved (never overwrite with null)
      return { ...t, score: t.score ?? null };
    }
    const soft = {
      communication_clarity: Math.round(Number(s.communication_clarity ?? s.score)),
      fluency:               Math.round(Number(s.fluency               ?? s.score)),
      confidence:            Math.round(Number(s.confidence            ?? s.score)),
      professionalism:       Math.round(Number(s.professionalism       ?? s.score)),
      english_proficiency:   Math.round(Number(s.english_proficiency   ?? s.score)),
      answer_relevance:      Math.round(Number(s.answer_relevance      ?? s.score)),
    };
    return {
      ...t,
      score:          Math.round(Number(s.score)),
      clarity:        soft.communication_clarity,
      confidence:     soft.confidence,
      professionalism: soft.professionalism,
      relevance:      soft.answer_relevance,
      feedback:       String(s.feedback || '').trim(),
      soft_skills:    soft,
      scoring_source: 'gemini_live_relay',
      stt_source:     'gemini_live',
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
    context.config?.supabase_url ||
    context.supabase_url ||
    process.env.SUPABASE_URL ||
    ''
  ).replace(/\/+$/, '');
  const supabaseKey = String(
    context.config?.supabase_key ||
    context.supabase_key ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ''
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
            communication_clarity: Math.round(Number(turn.communication_clarity ?? turn.clarity ?? turn.score ?? 0)),
            fluency:               Math.round(Number(turn.fluency               ?? turn.score ?? 0)),
            confidence:            Math.round(Number(turn.confidence            ?? turn.score ?? 0)),
            professionalism:       Math.round(Number(turn.professionalism       ?? turn.score ?? 0)),
            english_proficiency:   Math.round(Number(turn.english_proficiency   ?? turn.score ?? 0)),
            answer_relevance:      Math.round(Number(turn.answer_relevance      ?? turn.relevance ?? turn.score ?? 0)),
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
    if (turn.time_limit_seconds != null && Number.isFinite(Number(turn.time_limit_seconds))) {
      patch.time_limit_seconds = Math.round(Number(turn.time_limit_seconds));
    } else if (existing.time_limit_seconds != null) {
      patch.time_limit_seconds = existing.time_limit_seconds;
    }
    if (turn.complexity_tier || existing.complexity_tier) {
      patch.complexity_tier = turn.complexity_tier || existing.complexity_tier;
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Vercel API save — calls /api/live-speech-save on the Vercel frontend.
// This is always publicly accessible (no ngrok/n8n required).
// ─────────────────────────────────────────────────────────────────────────────
function getVercelSaveUrl(context) {
  // Prefer explicit override, then derive from portal_base_url.
  const explicit = String(
    context.live_save_url || process.env.LIVE_SAVE_URL || ''
  ).trim();
  if (explicit) return explicit;

  const base = String(context.portal_base_url || process.env.PORTAL_BASE_URL || '').replace(/\/+$/, '').trim();
  if (base) return `${base}/api/live-speech-save`;
  return null;
}

export async function vercelSaveTurn(context, turn) {
  const url = getVercelSaveUrl(context);
  if (!url) throw new Error('vercelSaveTurn: live_save_url / portal_base_url not set in context');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      partial: true,
      session_id: String(context.session_id || ''),
      max_questions: Number(context.max_questions || 5),
      turns: [turn],
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  if (!res.ok) throw new Error(`vercelSaveTurn ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

export async function vercelSaveFinal(context, scoredTurns, {
  combinedSpeechScore = 0,
  finalFeedback = '',
  durationSeconds = 0,
  tabSwitches = 0,
} = {}) {
  const url = getVercelSaveUrl(context);
  if (!url) throw new Error('vercelSaveFinal: live_save_url / portal_base_url not set in context');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      partial: false,
      session_id: String(context.session_id || ''),
      max_questions: Number(context.max_questions || 5),
      turns: scoredTurns,
      combined_speech_score: combinedSpeechScore,
      final_feedback: finalFeedback,
      duration_seconds: durationSeconds,
      tab_switches: tabSwitches,
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  if (!res.ok) throw new Error(`vercelSaveFinal ${res.status}: ${text.slice(0, 200)}`);
  console.log(`[relay] Vercel final save OK — session ${context.session_id}`, json);
  return json;
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

  const patch = {
    interview_history:            history,
    updated_at:                   iso,
    assessment_stage:             'completed',
    current_phase:                cfg.maxQ + cfg.speechPhases,
    status:                       'completed',
    technical_score:              techAvg,
    speech_score:                 speechAvg,
    score:                        combined,
    result,
  };
  if (result === 'PASS') {
    patch.scheduling_status = 'pending';
    patch.scheduling_updated_at = iso;
  }

  await patchSessionRow(cfg, patch);

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

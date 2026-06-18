// n8n: CODE - Parse Result (assessment scoring)
// Paste into: CODE - Parse Result (after Groq/Gemini/Basic LLM Chain)
// Replaces: CODE - Update interview_history if that is your node name

function timerBounds(config) {
  const min = Number(config?.timer_min_seconds);
  const max = Number(config?.timer_max_seconds);
  return {
    min: Number.isFinite(min) && min > 0 ? min : 60,
    max: Number.isFinite(max) && max > 0 ? max : 600,
  };
}

function clampSeconds(sec, config) {
  const { min, max } = timerBounds(config);
  return Math.min(max, Math.max(min, Math.round(sec)));
}

// Seconds band per complexity tier
function tierTimeRange(tier) {
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

// Infer a tier when the model omits or returns a junk tier
function inferTierFromQuestion(questionText) {
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

// Deterministic per-question time: tier sets the band, question length positions
// within it, the model's value (if sane) is blended in. Different questions →
// different times, longer/harder questions → more seconds.
function deriveTimeLimitSeconds(rawLlmTime, tier, questionText, config, phase) {
  const usableTier =
    tierTimeRange(tier) ? tier : inferTierFromQuestion(questionText);
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

function buildDeadline(isoStart, seconds) {
  const start = isoStart ? new Date(isoStart) : new Date();
  return new Date(start.getTime() + seconds * 1000).toISOString();
}

function extractLlmText(api) {
  if (!api || typeof api !== 'object') return '';
  if (typeof api.text === 'string' && api.text.trim()) return api.text.trim();
  if (typeof api.output === 'string' && api.output.trim()) return api.output.trim();
  if (typeof api.response === 'string' && api.response.trim()) return api.response.trim();
  const c0 = api.choices?.[0];
  if (c0?.message?.content) return String(c0.message.content).trim();
  if (typeof c0?.text === 'string') return c0.text.trim();
  const parts = api.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts[0]?.text) return String(parts[0].text).trim();
  return '';
}

function salvageNextQuestionFromText(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return '';

  const patterns = [
    /"next_question"\s*:\s*"((?:\\.|[^"\\])*)"/i,
    /"nextQuestion"\s*:\s*"((?:\\.|[^"\\])*)"/i,
    /next_question\s*[:=]\s*"((?:\\.|[^"\\])*)"/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    }
  }
  return '';
}

function salvageStringField(text, keys) {
  const t = String(text || '');
  for (const key of keys) {
    const re = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"', 'i');
    const m = t.match(re);
    if (m && m[1] != null) {
      return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    }
  }
  return null;
}

function salvageNumberField(text, keys) {
  const t = String(text || '');
  for (const key of keys) {
    const re = new RegExp('"' + key + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)', 'i');
    const m = t.match(re);
    if (m && m[1] != null) return Number(m[1]);
  }
  return null;
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json|javascript|js)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

// Extract the first balanced {...}; if truncated, returns from first "{" to end.
function extractJsonObjectText(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start);
}

// Repair truncated JSON: cut to the last complete top-level property and close structures.
function repairTruncatedJson(jsonish) {
  const s = String(jsonish || '');
  if (!s) return '';
  let inStr = false;
  let esc = false;
  let depth = 0;
  let lastComplete = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 1) lastComplete = i;
  }
  if (lastComplete < 0) return '';
  let head = s.slice(0, lastComplete);
  const stack = [];
  let is2 = false;
  let e2 = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (e2) { e2 = false; continue; }
    if (ch === '\\') { e2 = true; continue; }
    if (ch === '"') { is2 = !is2; continue; }
    if (is2) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (is2) head += '"';
  while (stack.length) head += stack.pop();
  return head;
}

function tryParseJson(text) {
  const base = String(text || '').trim();
  if (!base) return null;
  const variants = [base, base.replace(/,\s*([}\]])/g, '$1')];
  for (const v of variants) {
    try { return JSON.parse(v); } catch (_) {}
  }
  const repaired = repairTruncatedJson(base);
  if (repaired) {
    try { return JSON.parse(repaired); } catch (_) {}
    try { return JSON.parse(repaired.replace(/,\s*([}\]])/g, '$1')); } catch (_) {}
  }
  return null;
}

function ensureNextQuestion(obj, rawText) {
  const out = obj && typeof obj === 'object' ? { ...obj } : {};
  const nextQ = String(out.next_question || out.nextQuestion || out.question || '').trim();
  if (!nextQ && rawText) {
    const salv = salvageNextQuestionFromText(rawText);
    if (salv) { out.next_question = salv; out.nextQuestion = salv; }
  }
  return out;
}

function parseLlmContent(api) {
  // 1) Upstream already provided a structured object.
  if (
    api && typeof api === 'object' &&
    (api.score != null ||
      api.feedback ||
      api.next_question ||
      api.nextQuestion ||
      api.result ||
      api.status === 'finished' ||
      api.suggested_answer)
  ) {
    return ensureNextQuestion(api, extractLlmText(api));
  }

  const rawText = extractLlmText(api);
  if (!rawText) {
    return {
      status: 'in_progress',
      score: null,
      feedback:
        'Empty model output — your answer was saved but could not be scored automatically. Please resubmit.',
      next_question: '',
      nextQuestion: '',
      _scoring_failed: true,
    };
  }

  const cleaned = stripCodeFences(rawText);

  // 2) Robust JSON recovery: direct → loose → extracted object → repaired.
  let parsed = tryParseJson(cleaned);
  if (!parsed) {
    const objText = extractJsonObjectText(cleaned);
    if (objText) parsed = tryParseJson(objText);
  }
  if (parsed && typeof parsed === 'object') {
    return ensureNextQuestion(parsed, rawText);
  }

  // 3) Field-level salvage — recover score/feedback even from truncated JSON.
  const score = salvageNumberField(rawText, ['score']);
  const feedback = salvageStringField(rawText, ['feedback']);
  const suggested = salvageStringField(rawText, ['suggested_answer', 'suggestedAnswer']);
  const nextQ = salvageNextQuestionFromText(rawText);
  const firstSpeech = salvageStringField(rawText, ['first_speech_question', 'firstSpeechQuestion']);
  const result = salvageStringField(rawText, ['result']);
  const tier = salvageStringField(rawText, ['complexity_tier', 'complexityTier']);
  const timeLimit = salvageNumberField(rawText, ['time_limit_seconds']);

  const recoveredScore = score != null;
  const recoveredAnything = recoveredScore || !!feedback || !!nextQ || !!suggested || !!result;

  return {
    status: result ? 'finished' : 'in_progress',
    score: recoveredScore ? score : null,
    feedback:
      feedback ||
      (recoveredAnything
        ? 'Partial evaluation recovered from model output.'
        : 'Answer saved but automatic scoring failed (model returned unreadable output). This phase was left unscored for review.'),
    suggested_answer: suggested || '',
    next_question: nextQ || '',
    nextQuestion: nextQ || '',
    first_speech_question: firstSpeech || '',
    result: result || '',
    complexity_tier: tier || null,
    time_limit_seconds: timeLimit != null ? timeLimit : null,
    _scoring_failed: !recoveredScore,
    _partial_recovery: recoveredAnything && !recoveredScore,
  };
}

function extractJdThemes(text) {
  const lines = String(text)
    .split(/\r?\n|(?<=[.;])\s+/)
    .flatMap((chunk) => chunk.split(/\s*[•\-*]\s+/))
    .map((s) => s.replace(/^[\s\d.)(]+/, '').trim())
    .filter((s) => s.length >= 12);
  return lines.length ? [...new Set(lines)].slice(0, 10) : [String(text).slice(0, 400)];
}

function extractCvAnchors(text) {
  const cv = String(text || '');
  const projects =
    cv.match(/(?:project|built|developed|engineered|implemented|led)[^.]{10,120}/gi) || [];
  const skills =
    cv.match(
      /\b(React|Angular|Vue|Node\.?js|Python|Django|Flask|SQL|PostgreSQL|MySQL|MongoDB|\.NET|ASP\.NET|C#|Java|Spring|AWS|Azure|GCP|Docker|Kubernetes|Redis|Kafka|REST|GraphQL|TypeScript|JavaScript|EF\s*Core|LINQ|JWT|OAuth|microservices?|APIM|CI\/CD|GitHub Actions)\b/gi
    ) || [];
  return [
    ...new Set([
      ...projects.slice(0, 5).map((p) => p.trim().slice(0, 80)),
      ...skills.slice(0, 6),
    ]),
  ].filter(Boolean);
}

function inferYearsFromText(text) {
  const matches = [...String(text || '').matchAll(/(\d+)\+?\s*(?:years?|yrs?)(?:\s+of)?\s*(?:experience|exp)?/gi)];
  let max = 0;
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function detectSeniorityFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(intern|trainee|graduate|entry[\s-]?level|fresher|bootcamp)\b/.test(t)) return 'junior';
  if (/\b(junior|jr\.?)\b/.test(t)) return 'junior';
  if (/\b(associate)\b/.test(t)) return 'mid';
  if (/\b(senior|sr\.?|lead|principal|staff|architect|head|manager|director)\b/.test(t)) return 'senior';
  return 'mid';
}

function yearsToTier(years) {
  if (!Number.isFinite(years) || years <= 0) return null;
  if (years <= 2) return 'junior';
  if (years <= 5) return 'mid';
  return 'senior';
}

function tierRank(tier) {
  if (tier === 'junior') return 1;
  if (tier === 'senior') return 3;
  return 2;
}

function inferCandidateTier(cvText) {
  const cv = String(cvText || '');
  const years = inferYearsFromText(cv);
  const cvTitleTier = detectSeniorityFromTitle(cv);
  const yearTier = yearsToTier(years);
  let tier = cvTitleTier;
  if (yearTier && tierRank(yearTier) > tierRank(tier)) tier = yearTier;
  if (/\b(senior|lead|principal|architect|staff)\b/i.test(cv) && tierRank(tier) < 3) tier = 'senior';
  if (/\b(intern|trainee|fresher|bootcamp)\b/i.test(cv) && tierRank(tier) > 1) tier = 'junior';
  return tier;
}

function resolveTargetTier(jdTitle, jdReq, cvText) {
  const roleTier = detectSeniorityFromTitle(jdTitle);
  const jdYears = Math.max(inferYearsFromText(jdTitle), inferYearsFromText(jdReq));
  const jdTier = yearsToTier(jdYears);
  let targetTier = roleTier;
  if (jdTier && tierRank(jdTier) > tierRank(targetTier)) targetTier = jdTier;
  return { targetTier, roleTier, jdYears, candidateTier: inferCandidateTier(cvText) };
}

function buildTierFallbackPools(targetTier, jdReq) {
  const isDotNet = /\.net|asp\.net|c#|ef core|entity framework/i.test(String(jdReq || '').toLowerCase());
  const pools = {
    junior: {
      dotnet: {
        fundamentals: [
          'What is the difference between authentication and authorization?',
          'What is dependency injection and why is it useful in ASP.NET Core?',
          'What is the purpose of middleware in the ASP.NET Core request pipeline?',
        ],
        applied: [
          'A single API route returns 404 while others work — what are the first things you would check?',
          'What is the difference between a 400 and a 500 HTTP response?',
          'Why are REST APIs typically stateless?',
        ],
      },
      generic: {
        fundamentals: [
          'What is the difference between authentication and authorization?',
          'Why are REST APIs typically stateless?',
          'What is the difference between a GET and a POST request?',
        ],
        applied: [
          'A client receives 401 on one endpoint only — what might cause that?',
          'What is the difference between a 400 and a 500 response?',
          'What does idempotency mean for HTTP requests?',
        ],
      },
    },
    mid: {
      dotnet: {
        fundamentals: [
          'What is the difference between IEnumerable and IQueryable in LINQ? When would you use each?',
          'Cookie-based session auth vs JWT for an API — what are the main trade-offs?',
          'Why might you choose no-tracking queries in EF Core, and what trade-off are you accepting?',
        ],
        applied: [
          'An API endpoint returns 500 errors only under load — what are the most likely causes and how would you narrow them down?',
          'What does idempotency mean for HTTP APIs, and why does it matter for retries?',
          'What is the difference between optimistic and pessimistic concurrency, and when would you use each?',
        ],
      },
      generic: {
        fundamentals: [
          'Token-based auth vs server-side sessions — what are the main trade-offs for a public API?',
          'What is the difference between PUT and PATCH, and when would you use each?',
          'Why are REST APIs typically stateless, and what problems does that solve?',
        ],
        applied: [
          'An API is slow only under peak traffic — what categories of causes would you consider first?',
          'Caching improved latency but users see stale data — what could have gone wrong?',
          'What is the difference between a 401 and a 403 response, and when should each be returned?',
        ],
      },
    },
    senior: {
      dotnet: {
        fundamentals: [
          'When would you choose distributed caching vs in-process caching in ASP.NET Core, and what consistency risks appear?',
          'How do refresh tokens, short-lived access tokens, and revocation interact in a production API?',
          'What are the main trade-offs between EF Core compiled queries, split queries, and raw SQL for hot paths?',
        ],
        applied: [
          'After a deployment, some authenticated users intermittently receive 401s — what hypotheses do you prioritize and why?',
          'A read-heavy API shows rising p95 latency and database CPU — how do you decide between caching, read replicas, and query changes?',
          'Duplicate charge attempts hit your payment endpoint during retries — how should idempotency and API design work together?',
        ],
      },
      generic: {
        fundamentals: [
          'When is JWT validation at the gateway insufficient, and what defense-in-depth would you expect behind it?',
          'What are the trade-offs between synchronous REST and event-driven updates for cross-service workflows?',
          'How do you reason about cache invalidation vs TTL when correctness matters more than freshness?',
        ],
        applied: [
          'Intermittent 5xx errors appear on one instance after a rollout — how do you isolate the fault before rollback?',
          'Traffic spikes cause cascading timeouts across services — what patterns break the cascade?',
          'Clients retry POST requests and create duplicates — what API and client behaviors should exist?',
        ],
      },
    },
  };
  const tier = pools[targetTier] ? targetTier : 'mid';
  const stack = isDotNet ? 'dotnet' : 'generic';
  return pools[tier][stack];
}

function buildFallbackNextQuestion(ph, history, cfg, session) {
  const nextPhase = ph + 1;
  const jdTitle = String(cfg.requisition_title || '').trim();
  const jdReq = String(cfg.requisition_requirements || '').trim();
  const cvText = String(session?.cv_plaintext || '').trim();
  const { targetTier } = resolveTargetTier(jdTitle, jdReq, cvText);
  const pool = buildTierFallbackPools(targetTier, jdReq);
  const asked = (history || [])
    .map((h) => String(h.question_text || h.question || '').toLowerCase())
    .filter(Boolean);
  const fundamentals = pool.fundamentals || [];
  const applied = pool.applied || [];
  const lane =
    nextPhase <= 2 ? fundamentals : nextPhase <= 4 ? applied : [applied[applied.length - 1] || fundamentals[0]];
  for (const q of lane) {
    const key = q.slice(0, 24).toLowerCase();
    if (!asked.some((a) => a.includes(key.slice(0, 16)))) return q;
  }
  return lane[(nextPhase - 1) % lane.length] || lane[0] || fundamentals[0];
}

function buildFallbackSpeechQuestion(cfg, speechIndex) {
  const role = String(cfg?.requisition_title || 'this role').trim();
  const lanes = [
    `Describe a situation where you had to explain a complex technical topic to a non-technical stakeholder. How did you ensure they understood?`,
    `Tell me about a time you faced pressure, a tight deadline, or conflict at work. How did you communicate and stay composed?`,
    `Why are you interested in the ${role} role, and what would you focus on in your first 90 days?`,
    `Describe a time you had to collaborate with another team or stakeholder who disagreed with your approach. How did you handle it?`,
    `Tell me about a mistake or setback you learned from. What did you change in how you communicate or work afterward?`,
  ];
  const idx = Math.max(0, Math.min(lanes.length - 1, Number(speechIndex || 1) - 1));
  return lanes[idx];
}

function buildFirstSpeechQuestion(cfg, session, speechIndex, history, maxQ) {
  return buildFallbackSpeechQuestion(cfg, speechIndex);
}

function isIntegrityTermination(answerText) {
  return /^\[system\s+termination/i.test(String(answerText || '').trim());
}

function isScorablePhaseRow(row) {
  if (!row || row.answer_text == null || row.score == null) return false;
  if (row.integrity_terminated || isIntegrityTermination(row.answer_text)) return false;
  const n = Number(row.score);
  return Number.isFinite(n);
}

function buildPhaseSummary(rows) {
  return rows
    .filter((row) => row.answer_text != null)
    .map((row) => {
      if (row.integrity_terminated || isIntegrityTermination(row.answer_text)) {
        return `P${row.phase}:integrity-fail`;
      }
      if (row.score != null) return `P${row.phase}:${row.score}`;
      return null;
    })
    .filter(Boolean)
    .join(', ');
}

function questionRelevanceCap(answerText, questionText) {
  const question = String(questionText || '').trim();
  if (!question || question.length < 20) return null;

  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4);
  const stop = new Set([
    'would', 'could', 'should', 'their', 'there', 'which', 'about', 'describe',
    'explain', 'candidate', 'please', 'specific', 'technical', 'question',
    'implement', 'approach', 'system', 'using',
  ]);
  const keys = [...new Set(tokens.filter((w) => !stop.has(w)))].slice(0, 18);
  if (keys.length < 3) return null;

  const lower = String(answerText || '').toLowerCase();
  const hits = keys.filter((k) => lower.includes(k)).length;
  const ratio = hits / keys.length;

  if (ratio < 0.06) return 12;
  if (ratio < 0.12) return 22;
  if (ratio < 0.2) return 32;
  return null;
}

/** Clamp LLM scores — off-topic and garbage answers must not get free points */
function normalizePhaseScore(answerText, llmScore, questionText) {
  const answer = String(answerText || '').trim();
  let score = Number(llmScore);
  if (!Number.isFinite(score)) score = 0;

  if (!answer) return 0;
  if (isIntegrityTermination(answer)) return null;
  if (/^\[timeout/i.test(answer)) return 0;

  const relevanceCap = questionRelevanceCap(answer, questionText);
  if (relevanceCap != null) score = Math.min(score, relevanceCap);

  const lower = answer.toLowerCase().replace(/\s+/g, ' ').trim();
  const compact = answer.replace(/\s+/g, '');
  const len = compact.length;

  // Keyboard mash: mmmm, qqqqq, ooooo (same char repeated)
  if (len >= 4) {
    const chars = compact.toLowerCase().split('');
    const freq = {};
    for (const c of chars) freq[c] = (freq[c] || 0) + 1;
    const top = Math.max(...Object.values(freq));
    if (Object.keys(freq).length === 1 || top / chars.length >= 0.8) return 0;
  }

  // Trivial non-answers
  if (/^(ok|okay|yes|no|n\/a|na|idk|dunno|sure|fine|\.+|-+)$/i.test(lower)) {
    return Math.min(score, 3);
  }
  if (/^(ok\s+ok|yes\s+yes|no\s+no)$/i.test(lower)) {
    return Math.min(score, 3);
  }

  const techMarkers =
    /\b(api|sql|database|entity|framework|asp\.net|\.net|core|jwt|controller|service|schema|ef\s*core|linq|rest|dto|validation|fluentvalidation|dependency|injection|tenant|auth|middleware|repository|campaign|promotion|bcrypt|rbac|sso|endpoint|migration|index|query|table|class|interface|async|await)\b/i;

  const wordCount = lower.split(/\s+/).filter(Boolean).length;

  // One-liner generic with no technical terms (e.g. phase 1 "yes, system handles products...")
  if (wordCount <= 25 && !techMarkers.test(answer)) {
    return Math.min(score, 15);
  }

  // Very short, no technical signal
  if (len < 30 && !techMarkers.test(answer)) {
    return Math.min(score, 8);
  }

  // Short answer without technical depth — cap generous LLM scores
  if (len < 120 && !techMarkers.test(answer)) {
    return Math.min(score, 18);
  }

  if (len < 200 && score > 40 && !techMarkers.test(answer)) {
    return Math.min(score, 25);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function pickNodeJson(...names) {
  for (const name of names) {
    if (!name) continue;
    try {
      const raw = $(name).first().json;
      if (raw && typeof raw === 'object') return raw;
    } catch (_) {}
  }
  return null;
}

function pickBuildContext() {
  const built =
    pickNodeJson('CODE - Build LLM context', 'CODE - Build LLM context1') || {};

  if (built.session?.id && built.norm) return built;

  const norm =
    pickNodeJson('CODE - Normalize Data', 'CODE - Normalize Data1') || {};
  const fetchRaw = pickNodeJson('HTTP - Fetch Session', 'HTTP - Fetch Session1');
  const session = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;

  if (session?.id) {
    let history = session.interview_history;
    if (typeof history === 'string') {
      try {
        history = JSON.parse(history);
      } catch (_) {
        history = [];
      }
    }
    return {
      session: { ...session, interview_history: history },
      norm,
    };
  }

  throw new Error(
    'Session context missing. Wire CODE - Build LLM context before Parse Result, or rename node to match (no stray "1" suffix).'
  );
}

function parseSessionConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function resolveWorkflowConfig(current, session, built) {
  const cfgNode =
    pickNodeJson('CFG - Assessment Config', 'CFG - Assessment Config1') || {};
  const normCfg = current?.config || {};
  const sessionCfg = parseSessionConfig(session?.config);
  const builtCfg = built?.norm?.config || {};

  const supabase_url =
    normCfg.supabase_url ||
    sessionCfg.supabase_url ||
    builtCfg.supabase_url ||
    cfgNode.supabase_url ||
    cfgNode.config?.supabase_url ||
    '';

  const supabase_key =
    normCfg.supabase_key ||
    sessionCfg.supabase_key ||
    builtCfg.supabase_key ||
    cfgNode.supabase_key ||
    cfgNode.config?.supabase_key ||
    '';

  return {
    ...cfgNode,
    ...builtCfg,
    ...sessionCfg,
    ...normCfg,
    supabase_url,
    supabase_key,
  };
}

const llm = $input.first().json;
const built = pickBuildContext();
const session = built.session;
const current = built.norm;
const cfg = resolveWorkflowConfig(current, session, built);
const content = parseLlmContent(llm);

let history = session.interview_history;
if (typeof history === 'string') {
  try {
    history = JSON.parse(history);
  } catch (err) {
    history = [];
  }
}
if (!Array.isArray(history)) history = [];

const ph = Number(current.current_phase || 1);
const maxQ = Number(cfg.max_questions || 5);
const failThreshold = Number(cfg.fail_score_threshold ?? 30);
const passThreshold = Number(cfg.pass_score_threshold ?? 60);
const iso = new Date().toISOString();

const integrityTerminated = isIntegrityTermination(current.answer);
const scoringFailed = content._scoring_failed === true || content.score == null;
const rawLlmScore = Number(content.score ?? 0);
let normalizedScore = null;
let scoreAdjusted = false;

const questionForPhase = String(
  history.find((x) => Number(x.phase) === ph)?.question_text ||
    history.find((x) => Number(x.phase) === ph)?.question ||
    built.current_question_text ||
    ''
).trim();

if (integrityTerminated) {
  normalizedScore = null;
} else if (scoringFailed) {
  // Model returned unreadable output — keep the answer, leave the phase unscored
  // (excluded from the average) instead of unfairly recording a zero.
  normalizedScore = null;
} else {
  normalizedScore = normalizePhaseScore(current.answer, rawLlmScore, questionForPhase);
  scoreAdjusted = normalizedScore !== Math.round(rawLlmScore);
}

let idx = history.findIndex((x) => Number(x.phase) === ph);
const patch = {
  answer_text: current.answer,
  received_at: iso,
  feedback: content.feedback || null,
  suggested_answer: content.suggested_answer || content.suggestedAnswer || null,
  score: normalizedScore,
  integrity_terminated: integrityTerminated || undefined,
};
if (integrityTerminated) {
  patch.feedback =
    `Integrity violation on phase ${ph} — this phase is not scored. Prior completed phases keep their recorded scores.`;
} else if (scoringFailed) {
  patch.feedback = [
    patch.feedback,
    '[System: automatic scoring was unavailable for this answer; it was preserved for review and excluded from the average rather than scored zero.]',
  ]
    .filter(Boolean)
    .join(' ');
} else if (scoreAdjusted && normalizedScore < rawLlmScore) {
  const relCap = questionRelevanceCap(current.answer, questionForPhase);
  patch.feedback = [
    patch.feedback,
    relCap != null && relCap <= 32
      ? `[Score adjusted ${rawLlmScore}→${normalizedScore}: answer did not address the question asked.]`
      : `[Score adjusted ${rawLlmScore}→${normalizedScore}: answer lacks required technical substance.]`,
  ]
    .filter(Boolean)
    .join(' ');
}

if (idx >= 0) history[idx] = { ...history[idx], ...patch };
else history.push({ phase: ph, question_text: '', sent_at: iso, ...patch });

const getPhaseScore = (phase) => {
  const row = history.find((x) => Number(x.phase) === phase);
  if (!row || row.answer_text == null || row.score == null) return null;
  const n = Number(row.score);
  return Number.isFinite(n) ? n : null;
};

function computeAverageScore(rows, maxPhases) {
  const scores = rows
    .filter((row) => {
      const phase = Number(row.phase);
      if (!Number.isFinite(phase) || phase < 1 || phase > maxPhases) return false;
      return isScorablePhaseRow(row);
    })
    .map((row) => Number(row.score));
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// Run all maxQ phases — no early exit on low scores (final PASS/FAIL only on phase maxQ).
const earlyTerminate = false;
const earlyTerminateReason = '';

let nextQ = String(content.nextQuestion || content.next_question || '').trim();
let timeLimitSeconds = null;
let complexityTier = null;

// LLM sometimes omits next_question (esp. phase 4→5). Recover from history, then fallback.
let usedFallbackQuestion = false;
if (!nextQ && ph < maxQ && !integrityTerminated) {
  const existingNext = history.find(
    (x) => Number(x.phase) === ph + 1 && String(x.question_text || x.question || '').trim()
  );
  if (existingNext) {
    nextQ = String(existingNext.question_text || existingNext.question || '').trim();
    timeLimitSeconds = existingNext.time_limit_seconds ?? null;
    complexityTier = existingNext.complexity_tier ?? null;
  } else {
    nextQ = buildFallbackNextQuestion(ph, history, cfg, session);
    usedFallbackQuestion = Boolean(nextQ);
    if (usedFallbackQuestion) {
      content.feedback = [
        content.feedback || '',
        `[System: AI omitted phase ${ph + 1} question — auto-generated ${resolveTargetTier(String(cfg.requisition_title || ''), String(cfg.requisition_requirements || ''), String(session?.cv_plaintext || '')).targetTier}-level fallback.]`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  }
}

const isActualFinalPhase = ph >= maxQ;

// Ignore premature LLM finished/PASS/FAIL before the last phase.
if (!isActualFinalPhase) {
  if (content.status === 'finished') content.status = 'in_progress';
  content.result = '';
}

let isFinal = isActualFinalPhase || integrityTerminated;

if (integrityTerminated) {
  nextQ = '';
  content.result = 'FAIL';
}

if (nextQ && ph < maxQ && !integrityTerminated) {
  const llmTier = content.complexity_tier || content.complexityTier || null;
  const derived = deriveTimeLimitSeconds(
    content.time_limit_seconds,
    llmTier,
    nextQ,
    cfg,
    ph + 1
  );
  timeLimitSeconds = derived.seconds;
  complexityTier = derived.tier;
}

if (nextQ && !isFinal) {
  const sentAt = iso;
  const nextPhase = ph + 1;
  const existingIdx = history.findIndex((x) => Number(x.phase) === nextPhase);
  const nextEntry = {
    phase: nextPhase,
    question_text: nextQ,
    answer_text: null,
    sent_at: sentAt,
    received_at: null,
    score: null,
    suggested_answer: null,
    feedback: null,
    time_limit_seconds: timeLimitSeconds,
    complexity_tier: complexityTier,
    deadline_at: timeLimitSeconds ? buildDeadline(sentAt, timeLimitSeconds) : null,
  };
  if (existingIdx >= 0) {
    history[existingIdx] = { ...history[existingIdx], ...nextEntry };
  } else {
    history.push(nextEntry);
  }
}

// Before final phase: missing next question must not end the assessment.
if (ph < maxQ && !integrityTerminated && !nextQ) {
  isFinal = false;
  content.feedback = [
    content.feedback || '',
    `[System: model did not return phase ${ph + 1} question — submit again or contact support.]`,
  ]
    .filter(Boolean)
    .join(' ');
}

const phaseScore = normalizedScore;

const speechEnabled =
  cfg.speech_enabled === true ||
  cfg.speech_enabled === 'true' ||
  Number(cfg.speech_phases || 0) > 0;
let startSpeech = false;
let technicalScore = null;

if (isActualFinalPhase && !integrityTerminated) {
  const techAvg = computeAverageScore(history, maxQ);
  technicalScore = techAvg ?? 0;

  if (speechEnabled) {
    // Speech runs after all technical phases regardless of the technical score —
    // the combined result decides final PASS/FAIL, so a weak technical round must
    // not block the voice round from starting.
    isFinal = false;
    startSpeech = true;
    nextQ = String(content.first_speech_question || content.firstSpeechQuestion || '').trim();
    if (!nextQ) nextQ = buildFirstSpeechQuestion(cfg, session, 1, history, maxQ);
    if (!nextQ) nextQ = buildFallbackSpeechQuestion(cfg, 1);
    const speechStartPhase = maxQ + 1;
    const derived = deriveTimeLimitSeconds(180, 'B', nextQ, cfg, speechStartPhase);
    const speechTimeLimit = derived.seconds;
    const speechTier = derived.tier;
    const sentAt = iso;
    const speechEntry = {
      phase: speechStartPhase,
      mode: 'speech',
      question_text: nextQ,
      answer_text: null,
      sent_at: sentAt,
      received_at: null,
      score: null,
      time_limit_seconds: speechTimeLimit,
      complexity_tier: speechTier,
      deadline_at: speechTimeLimit ? buildDeadline(sentAt, speechTimeLimit) : null,
    };
    const speechIdx = history.findIndex((x) => Number(x.phase) === speechStartPhase);
    if (speechIdx >= 0) history[speechIdx] = { ...history[speechIdx], ...speechEntry };
    else history.push(speechEntry);
    timeLimitSeconds = speechTimeLimit;
    complexityTier = speechTier;

    content.feedback = [
      content.feedback || '',
      `Technical assessment complete (${technicalScore}/100). Communication round — answer the next question by voice.`,
    ]
      .filter(Boolean)
      .join(' ');
  } else {
    if (content.status === 'finished' || content.result) isFinal = true;
    else isFinal = true;
    if (!content.result) {
      const finalScore =
        techAvg ?? (Number.isFinite(phaseScore) && phaseScore != null ? phaseScore : 0);
      content.result = finalScore >= passThreshold ? 'PASS' : 'FAIL';
    }
  }
}

const body = { interview_history: history, updated_at: iso };
if (startSpeech) {
  body.assessment_stage = 'speech';
  body.technical_score = technicalScore;
  body.current_phase = maxQ + 1;
} else if (nextQ && !isFinal) body.current_phase = ph + 1;
else if (!isFinal) body.current_phase = ph;
else body.current_phase = ph;

const averageScore = computeAverageScore(history, maxQ);

let finalResult = null;
let finalFeedback = content.feedback || '';
if (isFinal) {
  body.status = 'completed';
  body.assessment_stage = 'completed';
  const finalScore =
    averageScore ??
    (Number.isFinite(phaseScore) && phaseScore != null ? phaseScore : null) ??
    0;
  body.score = finalScore;

  if (integrityTerminated) {
    body.result = 'FAIL';
    finalResult = 'FAIL';
    const phaseSummary = buildPhaseSummary(history);
    finalFeedback = [
      `Assessment failed: integrity violation on phase ${ph}.`,
      averageScore != null
        ? `Recorded average from completed phases before termination: ${averageScore}/100 (${phaseSummary}).`
        : `No prior scored phases (${phaseSummary || 'none'}).`,
    ]
      .filter(Boolean)
      .join(' ');
  } else if (earlyTerminate) {
    body.result = 'FAIL';
    finalResult = 'FAIL';
    const phaseSummary = buildPhaseSummary(history);
    if (averageScore != null) {
      finalFeedback = [
        finalFeedback,
        `Average score across completed phases: ${averageScore}/100 (${phaseSummary}). Pass mark: ${passThreshold}.`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  } else {
    body.result = finalScore >= passThreshold ? 'PASS' : 'FAIL';
    finalResult = body.result;
    if (averageScore != null) {
      const phaseSummary = buildPhaseSummary(history);
      finalFeedback = [
        finalFeedback,
        `Average score across all phases: ${averageScore}/100 (${phaseSummary}). Pass mark: ${passThreshold}.`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  }
}

const b = String(cfg.supabase_url || '').replace(/\/+$/, '');
if (!b || !/^https?:\/\//i.test(b)) {
  throw new Error(
    'supabase_url missing or invalid. Set top-level supabase_url in CFG - Assessment Config (e.g. https://xxx.supabase.co).'
  );
}
const patchUrl = `${b}/rest/v1/assessment_sessions?id=eq.${encodeURIComponent(String(session.id))}`;
const nextRow = history.find((x) => Number(x.phase) === ph + 1);

return [
  {
    json: {
      score: isFinal ? (body.score ?? averageScore ?? phaseScore) : phaseScore,
      phase_score: phaseScore,
      llm_score_raw: rawLlmScore,
      score_adjusted: scoreAdjusted,
      average_score: isFinal ? (body.score ?? averageScore) : null,
      feedback: isFinal ? finalFeedback : (patch.feedback || content.feedback || ''),
      nextQuestion: nextQ,
      suggested_answer: content.suggested_answer || content.suggestedAnswer || '',
      time_limit_seconds: nextRow?.time_limit_seconds ?? timeLimitSeconds,
      deadline_at: nextRow?.deadline_at ?? null,
      complexity_tier: nextRow?.complexity_tier ?? complexityTier,
      isFinal,
      result: isFinal ? finalResult : null,
      startSpeech,
      assessment_mode: startSpeech ? 'speech' : 'text',
      speech_phases: Number(cfg.speech_phases || 0) || 5,
      technical_score: technicalScore,
      terminatedEarly: earlyTerminate,
      integrity_terminated: integrityTerminated,
      candidate_email: current.candidate_email,
      session_id: current.session_id || session.id,
      current_phase: ph,
      config: cfg,
      gmail_thread_id: session.gmail_thread_id || null,
      gmail_message_id: session.gmail_message_id || null,
      mail_subject: session.mail_subject || null,
      _session_patch_url: patchUrl,
      _session_patch_body: body,
    },
  },
];

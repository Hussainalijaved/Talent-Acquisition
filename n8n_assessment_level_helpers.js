// Shared assessment level helpers — keep in sync across:
// n8n_code_build_llm_context.js, n8n_code_screening_phase1_prompt.js,
// n8n_code_parse_assessment_result.js, n8n_code_parse_technical_result.js, api/manual-shortlist.js

function detectSeniorityFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(intern|trainee|graduate|entry[\s-]?level|fresher|bootcamp)\b/.test(t)) return 'junior';
  if (/\b(junior|jr\.?)\b/.test(t)) return 'junior';
  if (/\b(associate)\b/.test(t)) return 'mid';
  if (/\b(senior|sr\.?|lead|principal|staff|architect|head|manager|director)\b/.test(t)) return 'senior';
  return 'mid';
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
  const candidateTier = inferCandidateTier(cvText);
  return { targetTier, roleTier, jdYears, candidateTier };
}

function stackHints(jdReq) {
  const jd = String(jdReq || '').toLowerCase();
  if (/\.net|asp\.net|c#|ef core|entity framework|linq/i.test(jd)) {
    return 'ASP.NET Core, REST, JWT/OAuth, EF Core, LINQ, middleware, DI';
  }
  if (/node|javascript|typescript|react/i.test(jd)) {
    return 'Node/JS APIs, REST, JWT, async I/O, HTTP';
  }
  if (/python|django|flask|fastapi/i.test(jd)) {
    return 'Python web APIs, REST, auth, ORM, HTTP';
  }
  return 'REST APIs, HTTP, auth, databases, backend fundamentals';
}

function tierLabel(tier) {
  if (tier === 'junior') return 'Junior / entry-level';
  if (tier === 'senior') return 'Senior / lead';
  return 'Mid-level';
}

function coreConceptHints(jdReq, targetTier) {
  const jd = String(jdReq || '').toLowerCase();
  const tier = targetTier === 'junior' || targetTier === 'senior' ? targetTier : 'mid';

  if (/\.net|asp\.net|c#|ef core|entity framework|linq/i.test(jd)) {
    const byTier = {
      junior:
        'OOP basics, HTTP status codes, authentication vs authorization, dependency injection purpose, middleware pipeline, MVC vs Web API, EF Core vs raw SQL, LINQ purpose, GET vs POST, REST statelessness',
      mid:
        'DI lifetimes/scopes, middleware vs filters, JWT vs cookie sessions, EF change tracking vs no-tracking, IQueryable vs IEnumerable, async/await purpose, REST idempotency, HTTP 401 vs 403, API versioning basics',
      senior:
        'DI composition roots and lifetimes, middleware ordering pitfalls, token refresh/revocation, EF N+1 and query shapes, LINQ deferred execution, async deadlocks/threading, distributed auth, concurrency (optimistic vs pessimistic), cache consistency',
    };
    return byTier[tier];
  }
  if (/node|javascript|typescript|react/i.test(jd)) {
    const byTier = {
      junior:
        'HTTP verbs/status codes, auth vs authorization, REST statelessness, JSON APIs, npm/modules, sync vs async I/O, middleware purpose, env config basics',
      mid:
        'JWT vs sessions, Express/Fastify middleware chain, async error handling, connection pooling, idempotency, CORS purpose, validation layers, 401 vs 403',
      senior:
        'Event loop and async pitfalls, backpressure, distributed tracing hooks, token rotation, rate limiting strategies, cache stampede, graceful shutdown',
    };
    return byTier[tier];
  }
  if (/python|django|flask|fastapi/i.test(jd)) {
    const byTier = {
      junior:
        'HTTP basics, auth vs authorization, REST principles, ORM purpose, virtualenv/packaging, request/response cycle, status codes, JSON APIs',
      mid:
        'Django/Flask middleware, ORM lazy loading, migrations purpose, JWT vs sessions, idempotency, WSGI/ASGI basics, 401 vs 403',
      senior:
        'ORM N+1 and select_related, transaction isolation, async views/workers, auth middleware layers, caching invalidation, API versioning',
    };
    return byTier[tier];
  }
  const generic = {
    junior: 'HTTP basics, auth vs authorization, REST statelessness, CRUD, databases vs APIs, status codes, JSON',
    mid: 'Auth models (token vs session), idempotency, caching basics, concurrency basics, 401 vs 403, API error design',
    senior: 'Distributed auth, cache consistency, retry/idempotency at scale, observability hooks, failure modes',
  };
  return generic[tier];
}

function phaseBlueprint(phaseNum, targetTier, jdReq) {
  const stack = stackHints(jdReq);
  const concepts = coreConceptHints(jdReq, targetTier);
  const lanes = {
    junior: {
      2: `Core concept — pick ONE from: ${concepts}. Ask a clear comparison or definition tied to ${stack}.`,
      3: `Core concept — explain ONE fundamental idea from: ${concepts}. Plain language + simple example, no code.`,
      4: `Applied reasoning — light scenario in ${stack}; name 2–3 likely causes and how you would check.`,
      5: `Core concept judgment — pick between two reasonable options from ${stack} fundamentals and justify briefly.`,
    },
    mid: {
      2: `Core concept — compare two related ideas from: ${concepts}. When would you choose each in ${stack}?`,
      3: `Core concept — explain how/why a mechanism works (from: ${concepts}), not just what it is.`,
      4: `Applied reasoning — realistic symptom in ${stack}; diagnostic reasoning, no code.`,
      5: `Core concept + judgment — multi-factor decision using ${stack} fundamentals; reasoned choice with trade-offs.`,
    },
    senior: {
      2: `Core concept — advanced trade-offs from: ${concepts}; include failure modes or ops impact in ${stack}.`,
      3: `Core concept — deep mechanism from: ${concepts}; inner behavior, pitfalls, or production consequences.`,
      4: `Applied reasoning — production incident in ${stack}; prioritized hypotheses and risks.`,
      5: `Strategic judgment — multi-constraint decision using ${stack} concepts; articulate risks of each path.`,
    },
  };
  const set = lanes[targetTier] || lanes.mid;
  return set[phaseNum] || `Core concept follow-up from: ${concepts} — at ${tierLabel(targetTier)} depth for ${stack}.`;
}

function tierCalibrationBlock(cal) {
  const { targetTier, roleTier, jdYears, candidateTier } = cal;
  const timing =
    targetTier === 'junior'
      ? 'Prefer complexity_tier A–B and 90–180s for most questions.'
      : targetTier === 'senior'
        ? 'Prefer complexity_tier C–D and 180–480s when the question warrants depth.'
        : 'Prefer complexity_tier B–C and 120–300s for most questions.';

  return `ROLE CALIBRATION (critical — questions must match the job being hired for):
- Target interview level: ${tierLabel(targetTier)} (grade answers against THIS bar)
- Role title signals: ${tierLabel(roleTier)}${jdYears ? ` | JD experience hint: ~${jdYears} years` : ''}
- Candidate CV signals (topic selection only, never quote CV): ${tierLabel(candidateTier)}
- Always ask questions appropriate for a ${tierLabel(targetTier)} ${targetTier === 'senior' ? 'hire' : 'role'} — not easier because the CV looks junior, not harder to quiz trivia
- ${timing}
- Pick topics evidenced in BOTH JD and CV; increase difficulty across phases when the candidate scores well (70+)`;
}

function tierExamplesBlock(targetTier, jdReq) {
  const isDotNet = /\.net|asp\.net|c#/i.test(String(jdReq || ''));
  if (targetTier === 'senior') {
    return isDotNet
      ? `GOOD senior examples:
- "After a blue-green deploy, some users get intermittent 401s while tokens look valid — what would you investigate first and why?"
- "When would you accept eventual consistency in a read-heavy API, and what user-visible risks must you handle?"
- "EF Core N+1 appeared only under peak traffic — how do you diagnose without jumping to caching blindly?"`
      : `GOOD senior examples:
- "Intermittent 5xx only on one pod after deploy — how do you narrow root cause before rollback?"
- "When is JWT validation at the edge insufficient, and what additional controls would you expect?"
- "Cache hit rate is high but users report stale data — what failure modes do you consider?"`;
  }
  if (targetTier === 'junior') {
    return isDotNet
      ? `GOOD junior examples:
- "What is the difference between authentication and authorization?"
- "Why is dependency injection useful in ASP.NET Core?"
- "What does a 404 status code mean versus a 500?"`
      : `GOOD junior examples:
- "What is the difference between authentication and authorization?"
- "Why are REST APIs often stateless?"
- "What is the difference between a GET and a POST request?"`;
  }
  return isDotNet
    ? `GOOD mid-level examples:
- "Cookie-based session auth vs JWT for an API — what are the main trade-offs?"
- "Why might you use no-tracking queries in EF Core, and what trade-off are you accepting?"
- "An endpoint returns 500 only under load — what categories of causes would you consider first?"`
    : `GOOD mid-level examples:
- "Token-based auth vs server-side sessions — main trade-offs for a public API?"
- "An API is slow only at peak traffic — what would you check first?"
- "What is idempotency and why does it matter for retried HTTP requests?"`;
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

function pickFallbackQuestion(nextPhase, history, targetTier, jdReq) {
  const pool = buildTierFallbackPools(targetTier, jdReq);
  const asked = (history || []).map((h) => String(h.question_text || h.question || '').toLowerCase()).filter(Boolean);
  const fundamentals = pool.fundamentals || [];
  const applied = pool.applied || [];
  const lane = nextPhase <= 2 ? fundamentals : nextPhase <= 4 ? applied : [applied[applied.length - 1] || fundamentals[0]];
  for (const q of lane) {
    const key = q.slice(0, 24).toLowerCase();
    if (!asked.some((a) => a.includes(key.slice(0, 16)))) return q;
  }
  return lane[(nextPhase - 1) % lane.length] || lane[0] || fundamentals[0];
}

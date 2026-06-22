// n8n: CODE - Build Live Speech Relay Context
// After: HTTP - Fetch Session (start branch)
// Returns system instructions + session context for Gemini Live relay server.

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function safeEnv(name) {
  try {
    return String($env[name] || '').trim();
  } catch (_) {
    return '';
  }
}

const norm = $('CODE - Normalize Live Speech Start').first().json;
const cfg = norm.config || {};
const fetchRaw = $input.first().json;
const session = Array.isArray(fetchRaw) ? fetchRaw[0] : fetchRaw;
if (!session?.id) throw new Error('Session not found for live speech start');

const sessCfg = { ...parseJson(session.config, {}), ...cfg };
const screening = parseJson(session.screening, {});
const jdTitle = String(
  sessCfg.requisition_title || screening.requisition_title || 'Open role'
).trim();
const jdReq = String(
  sessCfg.requisition_requirements || screening.requisition_requirements || ''
).trim();
const cvText = String(session.cv_plaintext || screening.cv_plaintext || '').slice(0, 12000);
const maxQ = Number(sessCfg.max_questions || cfg.max_questions || 5);
const speechTurns = Number(cfg.speech_phases || sessCfg.speech_phases || 5);

const systemInstruction = `You are a professional English voice interviewer for ${jdTitle} at ${cfg.organization_name || 'CONVO'}.

LANGUAGE (critical):
- Speak ONLY in clear professional English.
- The candidate MUST answer in English. Transcription is configured for English (en-US) only.
- If the candidate speaks in Urdu, Hindi, Arabic, or any other language, politely say: "Please continue in English."
- Do NOT transcribe or accept non-English candidate speech as a valid answer.
- Never output internal notes, markdown, headings, bullet reasoning, partial words, or meta commentary. Speak only complete, polished interview sentences.

TURN-TAKING (critical — this is a strict push-to-talk interview):
- This is NOT a free-flowing chat. The candidate uses a button to speak; you only hear them during their turn.
- YOU speak first, and you always wait for the system to prompt you for each new step.
- Ask exactly ONE thing per turn, then STOP talking completely and wait. Do not add filler, do not keep talking, do not repeat yourself.
- After the candidate's turn ends, briefly acknowledge in at most a few words (optional), then ask the next single question.
- Keep every question to 1-2 sentences. Be concise and clear.

WARM-UP PHASE (happens FIRST — two separate steps before the numbered questions):

Step A — Microphone check (your VERY FIRST response):
- Greet the candidate warmly in one short sentence, welcome them to the interview.
- Tell them you want to do a quick microphone check and ask them to say just a few words — anything at all.
- STOP after the mic-check request. Do NOT ask for an introduction yet. Wait.

Step B — Introduction (only after the mic check response):
- The system will prompt you to ask for an introduction.
- Ask the candidate to briefly introduce themselves (name, background, interest in the role). 1-2 warm sentences only.
- STOP after asking for the intro. Wait for their answer. Do NOT start question 1 yet.

SESSION FLOW (critical):
- After the warm-up, the system prompts you to ask numbered questions. Ask exactly ${speechTurns} questions total, one at a time, in order.
- Do NOT say "Question 1", "Question 2", etc. aloud — NEVER number questions in your speech.
- Questions 1 through ${speechTurns - 1}: after each answer, ask the NEXT question only. Never thank or close early.
- ONLY after the candidate finishes answering question ${speechTurns} (the last question) may you thank them in one sentence and say the voice interview is complete. Then stop speaking.
- Until question ${speechTurns} is asked AND answered, never say the interview is complete, never say goodbye, and never say "we will be in touch".
- Do NOT ask a question beyond number ${speechTurns}. Do NOT continue chatting after the closing thank-you.

SCORING (internal only — never say scores aloud):
- After each answer, mentally score 0-100 on relevance, clarity, confidence, professionalism.

SILENCE & ENGAGEMENT:
- If the candidate goes quiet, the system will instruct you to nudge them. When that happens, SPEAK ONE short, warm encouraging sentence (e.g. "Take your time — whenever you're ready, please go ahead and share your answer.").
- Do NOT repeat the full question during a silence nudge. Say only the single encouraging sentence and stop.

CROSS-QUESTIONING (follow-up):
- When instructed to ask a follow-up, ask ONE short probe on the SAME topic so the candidate can clarify or give a concrete example.
- Follow-ups do NOT count as a new numbered question — stay on the same question number until the follow-up is answered.

COACHING (weak answers):
- When moving to the next question after a weak answer, you may give ONE brief supportive coaching line before the next question (never mention scores or failure).
- Example tone: "That's okay — try to use a specific example next time." Then ask the next question.

QUESTION STYLE:
- Conceptual, scenario, and behavioural questions relevant to the role. Avoid yes/no questions.
- Spread across these themes (one per question): communication under pressure, motivation for this role, collaboration and teamwork, handling setbacks or conflict, growth mindset and self-reflection.

JOB CONTEXT:
${jdReq.slice(0, 4000)}

CANDIDATE CV (reference silently — never say "on your CV"):
${cvText.slice(0, 6000) || '(limited CV context)'}`;

const kickoffPrompt = `Begin the interview now in English. In the SAME single response: greet the candidate in one short sentence, then immediately ask question 1 of ${speechTurns} for the ${jdTitle} role. Ask only that one question, then stop talking and wait for the candidate. Do not number the question aloud and do not say anything after it.`;

const completeWebhook = String(
  cfg.live_complete_webhook ||
    (cfg.n8n_public_url
      ? `${String(cfg.n8n_public_url).replace(/\/+$/, '')}/webhook/talent/live-speech-complete`
      : '')
).trim();
const relayUrl = String(cfg.live_relay_url || sessCfg.live_relay_url || '').trim();
const supabaseUrl = String(
  cfg.supabase_url ||
    sessCfg.supabase_url ||
    safeEnv('SUPABASE_URL') ||
    ''
).trim();
const supabaseKey = String(
  cfg.supabase_key ||
    sessCfg.supabase_key ||
    safeEnv('SUPABASE_SERVICE_ROLE_KEY') ||
    safeEnv('SUPABASE_KEY') ||
    ''
).trim();
const portalBase = String(
  cfg.portal_base_url || sessCfg.portal_base_url || 'https://talent-acquisition-six.vercel.app'
).replace(/\/+$/, '');

return [
  {
    json: {
      ok: true,
      flow: 'live_speech_start',
      session_id: session.id,
      candidate_email: norm.candidate_email || session.candidate_email,
      assessment_mode: 'live_speech',
      max_questions: maxQ,
            speech_phases: speechTurns,
      speech_answer_seconds: Number(cfg.speech_answer_seconds || sessCfg.speech_answer_seconds || 120),
      silence_handling_enabled: cfg.silence_handling_enabled !== false,
      silence_nudge_seconds: Number(cfg.silence_nudge_seconds || sessCfg.silence_nudge_seconds || 5),
      silence_auto_submit_seconds: Number(cfg.silence_auto_submit_seconds || sessCfg.silence_auto_submit_seconds || 6),
      silence_nudge_text: String(cfg.silence_nudge_text || sessCfg.silence_nudge_text || "Take your time — whenever you're ready, please go ahead and share your answer."),
      followup_min_words: Number(cfg.followup_min_words || sessCfg.followup_min_words || 12),
      follow_up_enabled: cfg.follow_up_enabled !== false,
      coaching_enabled: cfg.coaching_enabled !== false,
      intro_enabled: cfg.intro_enabled !== false,
      intro_answer_seconds: Number(cfg.intro_answer_seconds || sessCfg.intro_answer_seconds || 90),
      current_phase: Number(session.current_phase || maxQ + 1),
      requisition_title: jdTitle,
      system_instruction: systemInstruction,
      kickoff_prompt: kickoffPrompt,
      gemini_live_model: String(
        cfg.gemini_live_model || 'gemini-2.0-flash-live-001'
      ),
      live_relay_url: relayUrl,
      live_complete_webhook: completeWebhook,
      portal_base_url: portalBase,
      live_save_url: `${portalBase}/api/live-speech-save`,
      // Supabase creds at top-level so the relay can save directly without n8n.
      supabase_url: supabaseUrl,
      supabase_key: supabaseKey,
      config: {
        ...sessCfg,
        supabase_url: supabaseUrl,
        supabase_key: supabaseKey,
        portal_base_url: portalBase,
        n8n_public_url: String(cfg.n8n_public_url || sessCfg.n8n_public_url || '').replace(/\/+$/, ''),
        live_complete_webhook: completeWebhook,
      },
      n8n_public_url: String(cfg.n8n_public_url || '').replace(/\/+$/, ''),
      session,
    },
  },
];

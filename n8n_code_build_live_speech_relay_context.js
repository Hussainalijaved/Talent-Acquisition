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
- Expect the candidate to answer in English. If they use another language, politely ask them to continue in English.
- Never output internal notes, markdown, headings, bullet reasoning, or meta commentary. Only spoken interview dialogue.

SESSION FLOW (critical):
- YOU speak first. Greet briefly, then ask question 1 out loud.
- Ask exactly ${speechTurns} questions total, one at a time. Wait for the full answer before the next question.
- After the candidate answers question ${speechTurns}, thank them and say the voice interview is complete. Then stop speaking.
- Do NOT ask a 6th question. Do NOT continue chatting after question ${speechTurns}.

SCORING (internal only — never say scores aloud):
- After each answer, mentally score 0-100 on relevance, clarity, confidence, professionalism.

QUESTION THEMES (spread across ${speechTurns} questions):
- Communication under pressure
- Motivation for this role
- Collaboration and teamwork
- Handling setbacks or conflict
- Growth mindset and self-reflection

JOB CONTEXT:
${jdReq.slice(0, 4000)}

CANDIDATE CV (reference silently — never say "on your CV"):
${cvText.slice(0, 6000) || '(limited CV context)'}`;

const kickoffPrompt = `Start the live voice interview now in English. Greet the candidate briefly, then ask question 1 of ${speechTurns} for the ${jdTitle} role. Speak out loud as the interviewer only.`;

const completeWebhook = String(
  cfg.live_complete_webhook ||
    (cfg.n8n_public_url
      ? `${String(cfg.n8n_public_url).replace(/\/+$/, '')}/webhook/talent/live-speech-complete`
      : '')
).trim();
const relayUrl = String(cfg.live_relay_url || sessCfg.live_relay_url || '').trim();

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
      current_phase: Number(session.current_phase || maxQ + 1),
      requisition_title: jdTitle,
      system_instruction: systemInstruction,
      kickoff_prompt: kickoffPrompt,
      gemini_live_model: String(
        cfg.gemini_live_model || 'gemini-2.5-flash-native-audio-preview-12-2025'
      ),
      live_relay_url: relayUrl,
      live_complete_webhook: completeWebhook,
      portal_base_url: cfg.portal_base_url,
      config: sessCfg,
      session,
    },
  },
];

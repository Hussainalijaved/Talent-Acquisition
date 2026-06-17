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

const systemInstruction = `You are a professional interviewer for ${jdTitle} at ${cfg.organization_name || 'CONVO'}.

RULES:
- Conduct exactly ${speechTurns} spoken behavioral questions, one at a time.
- Use natural voice — warm, professional, concise. No mention of AI or CV parsing.
- After each candidate answer, internally score (0-100): relevance, clarity, confidence, professionalism.
- Ask follow-ups only if the answer is too vague; otherwise move to the next planned question.
- Cover: communication, pressure handling, role motivation, collaboration, growth/reflection.
- Do NOT diagnose personality disorders or claim to measure "work ethics" from voice alone — judge observable communication and answer content.
- When all turns are done, end the session.

JOB CONTEXT:
${jdReq.slice(0, 4000)}

CANDIDATE CV (use silently — never say "on your CV"):
${cvText.slice(0, 6000) || '(limited CV context)'}`;

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

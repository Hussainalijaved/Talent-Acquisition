// n8n: CODE - Scheduling confirmed from session
// After HTTP GET session (scheduling-confirmed webhook)
// Replaces WAIT + Parse candidate choice for frontend-driven flow

function pickSessionRow() {
  const raw = $input.first().json;
  const row = Array.isArray(raw) ? raw[0] : raw?.session_row || raw;
  if (row?.id) return row;
  try {
    const prev = $('HTTP - SB GET session (confirmed)').first().json;
    return Array.isArray(prev) ? prev[0] : prev;
  } catch (_) {}
  return {};
}

const session = pickSessionRow();
const cfg =
  typeof session.config === 'string'
    ? (() => {
        try {
          return JSON.parse(session.config);
        } catch (_) {
          return {};
        }
      })()
    : session.config || {};

let slot = session.chosen_slot;
if (typeof slot === 'string') {
  try {
    slot = JSON.parse(slot);
  } catch (_) {
    slot = null;
  }
}

if (!slot || (!slot.start_iso && !slot.label)) {
  throw new Error('chosen_slot missing on session — candidate must confirm on candidate-pick.html first.');
}

const start_iso = slot.start_iso || slot.start || '';
const end_iso = slot.end_iso || slot.end || '';
const slot_label = slot.label || start_iso || 'Selected slot';

return [
  {
    json: {
      ...session,
      config: cfg,
      session_id: session.id,
      candidate_email: session.candidate_email,
      interviewer_email: cfg.interviewer_email || session.interviewer_email || '',
      proposed_slots: session.proposed_slots || [],
      selected_slot: slot,
      selected_slot_label: slot_label,
      slot_label,
      chosen_slot: slot_label,
      start_iso,
      end_iso,
      score: session.score,
      requisition_title: cfg.requisition_title || session.requisition_id,
    },
  },
];

// n8n: CODE - Parse candidate choice
// After WAIT - Candidate slot choice

const wait = $input.first().json;
const body = wait.body || wait;
const base = $('CODE - Build candidate slot mail').first().json;

const slot =
  body.selected_slot ||
  body.chosen_slot ||
  body.slot ||
  (body.slot_index != null && Array.isArray(base.slots)
    ? base.slots[Number(body.slot_index)]
    : null);

if (!slot) {
  throw new Error('Candidate did not select a slot.');
}

const start_iso = slot.start_iso || slot.start || '';
const end_iso = slot.end_iso || slot.end || '';
const slot_label = slot.label || start_iso || 'Selected slot';

return [
  {
    json: {
      ...base,
      selected_slot: slot,
      selected_slot_label: slot_label,
      slot_label,
      chosen_slot: slot_label,
      start_iso,
      end_iso,
      candidate_email: base.candidate_email,
      interviewer_email: base.config?.interviewer_email || base.interviewer_email,
    },
  },
];

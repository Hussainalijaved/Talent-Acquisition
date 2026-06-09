// n8n: CODE - Parse interviewer slot
// After WAIT - Interviewer availability — normalizes slots from interviewer portal

const wait = $input.first().json;
const body = wait.body || wait;
const base = $('CODE - Prep scheduling from PASS').first().json;

let slots = body.slots || body.proposed_slots || body.availability || [];
if (typeof slots === 'string') {
  try {
    slots = JSON.parse(slots);
  } catch (_) {
    slots = [];
  }
}
if (!Array.isArray(slots)) slots = [];

const normalized = slots
  .map((s, i) => {
    const start = s.start_iso || s.start || s.from || '';
    const end = s.end_iso || s.end || s.to || '';
    const label =
      s.label ||
      (start && end ? `${start} → ${end}` : start || `Slot ${i + 1}`);
    return { start_iso: start, end_iso: end, label };
  })
  .filter((s) => s.start_iso || s.label);

if (!normalized.length) {
  throw new Error('Interviewer submitted no valid slots.');
}

return [
  {
    json: {
      ...base,
      slots: normalized,
      proposed_slots: normalized,
      interviewer_submitted_at: new Date().toISOString(),
    },
  },
];

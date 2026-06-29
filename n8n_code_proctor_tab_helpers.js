// n8n helper — paste at top of parse nodes OR duplicate inline.
// Tab shift count is stored in proctor_report JSON (no dedicated DB column).

function parseProctorReportRaw(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** Merge frontend tab count into proctor_report for dashboard / report display. */
function mergeTabCountIntoProctorReport(session, tabCount) {
  if (!session || !Object.prototype.hasOwnProperty.call(session, 'proctor_report')) return {};
  const n = Number(tabCount);
  if (!Number.isFinite(n) || n < 0) return {};

  const existing = parseProctorReportRaw(session.proctor_report);
  const entries = Array.isArray(existing.entries) ? existing.entries.slice() : [];
  const fromEntries = entries.filter((e) => e && e.category === 'tab_switch').length;
  const total = Math.max(fromEntries, Math.round(n));

  if (total === fromEntries && Number(existing.tab_switches) === total) return {};

  return {
    proctor_report: {
      ...existing,
      entries,
      tab_switches: total,
    },
  };
}

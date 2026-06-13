// n8n: CODE - Pick Parse Result
// Wire AFTER: CODE - Parse Technical Result OR CODE - Parse Speech Result
// Unifies portal response + downstream IF nodes.

function pickParseJson() {
  const names = [
    'CODE - Parse Speech Result',
    'CODE - Parse Technical Result',
    'CODE - Parse Result',
  ];
  for (const name of names) {
    try {
      const raw = $(name).first().json;
      if (raw && typeof raw === 'object' && raw.session_id) return raw;
    } catch (_) {}
  }
  const inp = $input.first().json;
  if (inp && inp.session_id) return inp;
  throw new Error('No parse result from speech or technical branch.');
}

return [{ json: pickParseJson() }];

// n8n: CODE - Parse JD generate result
// After: HTTP Groq JD generate

const base = $('CODE - Build JD generate prompt').first().json;
const api = $input.first().json;
const text = api?.choices?.[0]?.message?.content;
const httpBad = !(api?.choices && api.choices[0]);

if (!text || httpBad) {
  const hint = api?.error?.message || api?.message || (httpBad ? 'GROQ_HTTP_EMPTY' : 'GROQ_EMPTY');
  return [
    {
      json: {
        success: false,
        error: hint,
        jd_text: '',
        title: base.title,
      },
    },
  ];
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch (e) {
  parsed = { jd_text: String(text || '').trim() };
}

let jd_text = String(parsed.jd_text || parsed.description || parsed.job_description || '').trim();

if (!jd_text && typeof parsed === 'object') {
  const parts = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && v.length > 40) parts.push(v);
  }
  jd_text = parts.join('\n\n').trim();
}

if (!jd_text) {
  return [
    {
      json: {
        success: false,
        error: 'Model returned empty jd_text',
        jd_text: '',
        title: base.title,
      },
    },
  ];
}

return [
  {
    json: {
      success: true,
      jd_text,
      title: base.title,
      department: base.department,
      location: base.location,
      employment_type: base.employment_type,
    },
  },
];

// n8n: CODE - SB URLs after outreach mail
// Runs AFTER: CODE - Merge Gmail send response (direct wire — use $input, not $('node name'))
// Gmail thread ids are already PATCHed by HTTP - SB PATCH session gmail thread (before Merge).

const j = $input.first().json;

const b = String(j.config?.supabase_url || '').replace(/\/+$/, '');

return [
  {
    json: {
      ...j,
      _sb_insert_candidates: `${b}/rest/v1/${j.config?.table_candidates || 'candidates'}`,
    },
  },
];

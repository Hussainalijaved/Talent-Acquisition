# Recruiter intake (Level 1) — setup guide

Frontend (single portal): `recruiter-intake.html` — tabs **Screen CVs** | **Results**  
Live: `https://talent-acquisition-six.vercel.app/recruiter-intake.html`  
Old URL `screening-results.html` redirects to `?tab=results`.

### Results tab (same page, same JD)

1. Enter **job title + JD** once at the top (shared).
2. Screen CVs on **Screen CVs** tab, then switch to **Results** (or `?tab=results`).
3. **Load / refresh results** — email, score, outcome, AI reason.
4. One-time Supabase: run `supabase_rls_candidates_read.sql` for anon `SELECT` on `candidates`.

### Multiple CVs (same JD)

1. Open recruiter intake → **Multiple CVs (same JD)**.
2. Enter job title + JD once.
3. Select several PDFs — **emails are extracted from each PDF** in the browser (first 2 pages; edit if wrong).
4. **Start screening** — the browser calls the same webhook **once per CV**, in order (~30–90s each).
5. Summary table shows OK / failed per candidate. n8n workflow unchanged (one execution per CV).

---

## Part 1 — Deploy frontend

1. Push `recruiter-intake.html` to GitHub `main`.
2. Wait for Vercel redeploy.
3. Open the page and paste your **n8n CV ingest webhook** (same as Postman):
   - `https://<your-host>/webhook/talent/cv-ingest`
4. Click **Save URL locally** (stored in browser).

Optional: pre-fill URL in the link:

`recruiter-intake.html?webhook=https%3A%2F%2F....%2Fwebhook%2Ftalent%2Fcv-ingest`

---

## Part 2 — n8n webhook (no structural change)

- Workflow must be **Active**.
- Webhook node: **TRG - Webhook CV ingest**, path `talent/cv-ingest`, method **POST**.
- For local dev use **ngrok** (or n8n cloud public URL). localhost will not work from Vercel.

### CORS (browser → n8n)

If the form shows “Network or CORS error”:

1. n8n **Settings → Security** → allow CORS for your Vercel origin, **or**
2. Webhook node **Options → Response headers**:
   - `Access-Control-Allow-Origin`: `https://talent-acquisition-six.vercel.app`
   - `Access-Control-Allow-Methods`: `POST, OPTIONS`
3. Add a short **OPTIONS** handler if needed, **or** use a Vercel serverless proxy (optional).

---

## Part 3 — Workflow code patches (JD from form)

Until these are applied, the form still sends JD fields but n8n **ignores** them and uses **CFG** defaults.

### 3a) `CODE - Expand CVs and duplicate flag`

After `requisition_id = ...` add:

```javascript
const body = triggerData.body || {};
const baseConfig = cfg.config || {};
const config = {
  ...baseConfig,
  requisition_title:
    body.requisition_title ||
    body.job_title ||
    baseConfig.requisition_title ||
    '',
  requisition_requirements:
    body.requisition_requirements ||
    body.jd_text ||
    baseConfig.requisition_requirements ||
    '',
};

return [{
  json: {
    ...cfg,
    config,
    candidate_email: email,
    cv_text: cv,
    fingerprint,
    is_duplicate,
    requisition_id,
  },
}];
```

Replace the old `return [{ json: { ...cfg, ...` block that does not build `config` overrides.

### 3b) `CODE - SB prepare session insert`

Inside `sessionBody`, add (if Supabase column exists):

```javascript
config: {
  ...cfg,
  requisition_title: cfg.requisition_title || parse.config?.requisition_title,
  requisition_requirements: cfg.requisition_requirements || parse.config?.requisition_requirements,
},
```

If `config` column is missing on `assessment_sessions`, run:

```sql
ALTER TABLE assessment_sessions
  ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb;
```

### 3c) `CODE - Normalize Data` (assessment webhook)

After building `config` from `nested`, merge from fetched session (after HTTP fetch session node runs, use session row in a follow-up code node **or** extend Normalize if session is on `item`):

```javascript
requisition_title:
  nested.requisition_title ||
  item.requisition_title ||
  (item.screening && item.screening.requisition_title) ||
  '',
```

**Better:** in **HTTP - Fetch Session** path, add **CODE - Merge session config** that sets `norm.config` from `session.config` when present.

### 3d) `CODE - Build LLM context` (assessment)

Already uses `cfg.requisition_title` from `norm.config` — works once 3b–3c pass JD into session.

---

## Part 4 — Test

| Step | Check |
|------|--------|
| 1 | n8n execution **green** after form submit |
| 2 | Groq screening prompt includes **your JD title** (not only CFG default) |
| 3 | Shortlisted candidate gets outreach email |
| 4 | Assessment phases use same role name in AI questions |

Postman parity: same fields as form — `candidate_email`, `requisition_title`, `requisition_requirements`, `cv_file` or `cv_text`.

---

## Part 5 — Field map (frontend → n8n)

| Form field | Webhook body key |
|------------|------------------|
| Candidate email | `candidate_email` |
| Job title | `requisition_title` |
| Job slug (auto) | `requisition_id` |
| JD textarea | `requisition_requirements` |
| PDF file | `cv_file` (binary) |
| Pasted CV | `cv_text` |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| CORS / Failed to fetch | Part 2 CORS or proxy |
| 404 webhook | Workflow active; correct URL `/webhook/talent/cv-ingest` |
| PDF empty in n8n | Binary field name must be `cv_file` |
| JD still old | Apply Part 3 patches |
| Duplicate skipped | Same email **and** same CV fingerprint already in `candidates` table |

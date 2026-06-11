# Super Admin — deployment guide

Talent Admin (`dashboard.html`) is protected by **Supabase Auth** + **role-based RLS**.

## 1. Run SQL (Supabase → SQL Editor)

Run in order (if not already done):

1. `supabase_jobs.sql`
2. `supabase_rls_candidates_read.sql`
3. `supabase_admin_panel.sql`
4. `supabase_scheduling.sql`
5. **`supabase_auth_profiles.sql`**
6. **`supabase_hiring_manager.sql`** ← HM notes, job scope, onsite access
7. **`supabase_roles_expand.sql`** ← HR Head, HM Head, Interviewer roles

## 2. Set bootstrap secret (one-time)

```sql
INSERT INTO public.app_config (key, value)
VALUES ('admin_bootstrap_secret', 'REPLACE_WITH_LONG_RANDOM_SECRET')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

## 3. Supabase Auth settings

Dashboard → **Authentication** → **Providers** → Email:

- Enable **Email** provider
- For fastest demo: disable **Confirm email** (optional)
- **Disable public sign-ups** after first super admin is created (recommended)

## 4. Create first super admin

1. Deploy frontend to Vercel (push `main`)
2. Open `https://talent-acquisition-six.vercel.app/setup-admin.html`
3. Enter bootstrap secret + your email/password
4. Sign in at `login.html` → `dashboard.html`

## 5. Roles

| Role | Access |
|------|--------|
| **super_admin** | Everything + invite any role |
| **hr_head** | Full access (temp) + invite Recruiter/HR & Interviewer |
| **hiring_manager_head** | Full access (temp) + invite Hiring Manager & Interviewer |
| **interviewer** | Full access (temp) |
| **recruiter** | Full access (temp) — Recruiter / HR |
| **hiring_manager** | Full access (temp) |
| **viewer** | Full access (temp) — legacy |

*Permissions are wide open for now — tighten per role later in `admin-auth.js`.*

Super admin invites users from **Users** tab in dashboard.

## 6. Public pages (unchanged)

These still use the **anon** key — no login:

- `careers.html`, `apply.html`, `index.html` (assessment)
- Scheduling portals (`interviewer.html`, `candidate-pick.html`)

n8n continues to use **service role** for writes.

## 7. Manual user (alternative)

Supabase → Authentication → Add user → then:

```sql
INSERT INTO public.profiles (id, email, full_name, role)
VALUES ('USER_UUID_FROM_AUTH', 'admin@convo.com', 'Admin', 'super_admin')
ON CONFLICT (id) DO UPDATE SET role = 'super_admin', is_active = true;
```

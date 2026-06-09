# AI-Powered Recruitment & Talent Acquisition Platform
## System Design Documentation

**Version:** 1.0  
**Last Updated:** June 2026  
**Production URL:** `https://talent-acquisition-six.vercel.app`  
**Document Classification:** Technical Architecture / Enterprise Handover

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Module Breakdown](#3-module-breakdown)
4. [End-to-End Workflow](#4-end-to-end-workflow)
5. [Database Design](#5-database-design)
6. [AI Integration Layer](#6-ai-integration-layer)
7. [Workflow Automation (n8n)](#7-workflow-automation-n8n)
8. [Frontend System](#8-frontend-system)
9. [Security & Anti-Cheat System](#9-security--anti-cheat-system)
10. [Deployment Architecture](#10-deployment-architecture)
11. [Appendix](#11-appendix)

---

## 1. Project Overview

### 1.1 High-Level Description

The **Talent Acquisition Platform** is a full-stack, AI-powered recruitment system that automates the complete hiring funnel—from job posting and candidate application through CV screening, multi-phase technical assessment, interview scheduling, and final recruiter decision support.

The platform combines:

- **Static frontend portals** (Vercel-hosted HTML/React)
- **Supabase** as the operational database and session store
- **n8n** as the workflow orchestration and integration engine
- **Large Language Models** (Google Gemini, Groq/Vertex) for screening and assessment intelligence
- **Gmail** for threaded, event-driven email automation

### 1.2 Purpose and Problem It Solves

Traditional recruitment pipelines suffer from:

| Problem | Platform Solution |
|---------|-------------------|
| Manual CV triage at scale | AI screening against job-specific JD with structured scoring |
| Inconsistent interview quality | 5-phase adaptive technical assessment grounded in CV + JD |
| Scheduling friction | Automated interviewer → candidate slot negotiation via email threads |
| Fragmented tooling | Single integrated flow from apply link to calendar invite |
| Assessment integrity risk | Browser-based proctoring with violation tracking and auto-termination |

### 1.3 Key Capabilities

| Capability | Description |
|------------|-------------|
| **AI CV Screening** | Gemini-powered analysis of PDF/text CVs against recruiter-provided JD; outputs SHORTLIST / REJECT / REVIEW |
| **5-Phase Assessment** | Sequential, timed, CV-grounded technical Q&A with per-phase scoring |
| **Anti-Cheat Monitoring** | Fullscreen enforcement, DevTools detection, tab-switch tracking, integrity termination |
| **Threaded Email Automation** | Gmail thread replies for outreach, results, scheduling, and confirmations |
| **Interview Scheduling** | Interviewer proposes slots → candidate picks → Google Calendar event |
| **Recruiter Dashboard** | Job management, bulk CV screening, live results from Supabase |
| **Public Careers Portal** | Open jobs listing + per-job apply pages with external LinkedIn integration |

---

## 2. System Architecture

### 2.1 Architectural Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT LAYER (Vercel CDN)                          │
├──────────────────┬──────────────────┬──────────────────┬────────────────────┤
│ Recruiter Portal │ Candidate Apply  │ Assessment Portal│ Scheduling Pages   │
│ recruiter-intake │ apply.html       │ index.html       │ interviewer.html   │
│ .html            │ careers.html     │                  │ candidate-pick.html│
└────────┬─────────┴────────┬─────────┴────────┬─────────┴──────────┬─────────┘
         │                  │                  │                    │
         │  POST webhook    │  POST webhook    │  POST webhook      │  POST wait
         │  + Supabase R/W  │  + Supabase R    │  + Supabase R/W    │  resume URLs
         ▼                  ▼                  ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATION LAYER (n8n)                             │
├──────────────────────────────┬──────────────────────────────────────────────┤
│ CV Screening Workflow        │ Assessment + Scheduling Workflow               │
│ TRG talent/cv-ingest         │ TRG assessment-answer                        │
│ PDF → Gemini → Gmail         │ LLM Chain → PATCH session → Gmail threads    │
│ → Supabase candidates/sessions│ → WAIT interviewer/candidate → Calendar     │
└────────┬─────────────────────┴──────────────────────┬───────────────────────┘
         │                                              │
         ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DATA LAYER (Supabase PostgreSQL)                     │
│  jobs │ app_config │ candidates │ assessment_sessions │ (interview_history)  │
└─────────────────────────────────────────────────────────────────────────────┘
         ▲                                              ▲
         │                                              │
┌────────┴──────────────────────────────────────────────┴───────────────────────┐
│                           AI LAYER                                             │
│  Google Gemini (CV screening) │ Groq / Google Vertex (assessment phases)      │
└───────────────────────────────────────────────────────────────────────────────┘
         ▲
         │
┌────────┴─────────────────────────────────────────────────────────────────────┐
│  INTEGRATIONS: Gmail (OAuth) │ Google Calendar │ PDF text extraction          │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Responsibilities

| Component | Role | Technology |
|-----------|------|------------|
| **Frontend** | User interfaces for recruiters, candidates, interviewers | HTML, CSS, React 18 (CDN), Tailwind |
| **n8n** | Webhook receivers, AI calls, email, DB writes, wait/resume flows | n8n Cloud / self-hosted |
| **Supabase** | Persistent storage, session state, RLS policies | PostgreSQL + REST API |
| **AI Layer** | CV screening decisions, question generation, answer scoring | Gemini 2.0, Llama 3.3 70B |
| **Gmail** | Candidate and interviewer email threads with In-Reply-To chaining | Gmail API via n8n |
| **Vercel** | Static site hosting, clean URLs | `vercel.json` |

### 2.3 Inter-Component Communication

```
Recruiter Form ──POST──► n8n /webhook/talent/cv-ingest
                              │
                              ├──► Gemini API (screening)
                              ├──► Supabase REST (candidates, assessment_sessions)
                              └──► Gmail Send (shortlist outreach)

Candidate Portal ──POST──► n8n /webhook/assessment-answer
                              │
                              ├──► Supabase GET session
                              ├──► LLM Chain (grade + next question)
                              ├──► Supabase PATCH interview_history
                              └──► Gmail Thread Reply (on PASS/FAIL)

Interviewer Page ──POST──► n8n WAIT resume (interviewer-availability)
Candidate Pick   ──POST──► n8n WAIT resume (candidate-slot-choice)
```

**Communication patterns:**

- **Synchronous webhooks:** CV ingest, assessment answer submission
- **Database-as-state:** `assessment_sessions.interview_history` JSONB holds full Q&A state
- **Email-as-signal:** Gmail thread IDs stored on session for reply chaining
- **Wait nodes:** n8n pauses workflow until interviewer/candidate submits via resume URL

---

## 3. Module Breakdown

### 3.1 Job Posting System

**Purpose:** Allow recruiters to create, publish, and manage job requisitions with associated metadata and apply links.

| Aspect | Detail |
|--------|--------|
| **Inputs** | Job title, JD text, interviewer email, location, employment type, department, status |
| **Outputs** | `jobs` table row, public apply URL, careers listing entry |
| **Internal Logic** | Slug (`job_id`) auto-generated from title; status `draft` → `open` → `closed`; webhook URL stored in `app_config` |
| **Connected Modules** | Candidate Application System, CV Screening Engine, Recruiter Dashboard |

**Key files:** `recruiter-intake.html` (Manage Jobs tab), `supabase_jobs.sql`, `careers.html`

---

### 3.2 Candidate Application System

**Purpose:** Public-facing application flow for candidates arriving from careers page or external job boards (e.g., LinkedIn).

| Aspect | Detail |
|--------|--------|
| **Inputs** | Email, PDF CV (`cv_file`), job slug from URL (`?job=junior-net-developer`) |
| **Outputs** | HTTP POST to n8n CV ingest webhook with `requisition_title`, `requisition_requirements`, `requisition_id`, `interviewer_email` |
| **Internal Logic** | Loads job from Supabase by slug; loads webhook from `app_config.cv_ingest_webhook`; duplicate detection deferred to n8n |
| **Connected Modules** | Job Posting System, CV Screening Engine |

**Webhook payload (apply.html → n8n):**

```json
{
  "candidate_email": "candidate@example.com",
  "requisition_title": "Junior .NET Developer",
  "requisition_requirements": "<JD text>",
  "requisition_id": "junior-net-developer",
  "interviewer_email": "interviewer@company.com",
  "cv_file": "<binary PDF>"
}
```

**Key files:** `apply.html`, `careers.html`, `LINKEDIN_JOBS_GUIDE.md`

---

### 3.3 CV Screening Engine

**Purpose:** AI-powered first-pass evaluation of candidate CVs against a specific job description.

| Aspect | Detail |
|--------|--------|
| **Inputs** | CV PDF/text, JD title + requirements, candidate email, requisition_id, interviewer_email |
| **Outputs** | Decision (`SHORTLIST` / `REJECT` / `REVIEW`), score 0–100, Phase 1 question, `candidates` row, optional `assessment_sessions` row |
| **Internal Logic** | See flow below |
| **Connected Modules** | AI Integration Layer, Email Automation, Database, Assessment System |

**Processing pipeline:**

```
TRG Webhook CV ingest
  → MUX (manual + webhook)
  → PDF Extract text
  → CODE Frontend intake (validate JD fields)
  → CFG Workflow configuration
  → DB Supabase read candidates (duplicate check)
  → CODE Expand CVs and duplicate flag
  → GATE Not duplicate
  → CODE CV plain text
  → Gemini CV screening agent
  → CODE Parse CV screening outcome
  → GATE Screening transport OK
  → GATE Initial CV Pass (SHORTLIST?)
      ├─ YES → Prepare session → Insert session → Gmail outreach → PATCH thread
      ├─ REVIEW → Log ReviewQueue
      └─ REJECT → Log Rejected
```

**Duplicate detection:** Same `candidate_email` + `fingerprint` (email|canonical CV text) + `requisition_id` → skip with `DuplicateSkipped` stage.

**Key files:** `Talent Acquisition — CV Screening.json`, `n8n_code_frontend_intake.js`

---

### 3.4 AI Assessment System (5-Phase Evaluation)

**Purpose:** Conduct a rigorous, adaptive, timed technical assessment after CV shortlisting.

| Aspect | Detail |
|--------|--------|
| **Inputs** | Session ID, candidate email, phase number, answer text, tab switch count |
| **Outputs** | Per-phase score, next question (phases 1–4), final PASS/FAIL, updated `interview_history` |
| **Internal Logic** | LLM grades current answer; generates CV+JD-grounded next question; deterministic score normalization; early termination rules |
| **Connected Modules** | Candidate Portal, Anti-Cheat System, Email Automation, Scheduling System |

**Phase structure:**

| Phase | Behavior |
|-------|----------|
| **Phase 1** | Question pre-generated during CV screening; first answer submitted via portal |
| **Phases 2–4** | LLM generates next question based on prior Q&A, CV excerpt, JD requirements |
| **Phase 5** | Final holistic PASS/FAIL; no new question emitted |

**Scoring thresholds (configurable):**

- `fail_score_threshold`: 30 (default)
- `pass_score_threshold`: 60 (default)
- Final result: average of scorable phases ≥ pass threshold → PASS

**Early termination:**

- After Phase 2: P1 ≤ 18 AND P2 ≤ 8 → FAIL
- After Phase 3: P1, P2, P3 all < fail threshold → FAIL
- Integrity violation → immediate FAIL

**Key files:** `index.html`, `Talent Acquisition — Assessment + Scheduling (Threaded Mail).json`, `n8n_code_parse_assessment_result.js`

---

### 3.5 Anti-Cheat Monitoring System

**Purpose:** Maintain assessment integrity through browser-based proctoring.

| Aspect | Detail |
|--------|--------|
| **Inputs** | Browser events: visibility change, fullscreen exit, keyboard shortcuts, DevTools probes |
| **Outputs** | Violation count, warnings, `[SYSTEM TERMINATION]` answer to n8n, FAIL result |
| **Internal Logic** | 3-strike policy; debounced violation recording; portal lock during assessment |
| **Connected Modules** | AI Assessment System (integrity termination parsing) |

See [Section 9](#9-security--anti-cheat-system) for full detail.

---

### 3.6 Interview Scheduling System

**Purpose:** Coordinate interview time slots between interviewer and candidate after assessment PASS.

| Aspect | Detail |
|--------|--------|
| **Inputs** | Interviewer email, proposed slots (ISO datetimes), candidate slot selection |
| **Outputs** | Gmail thread replies, Google Calendar event, confirmation emails |
| **Internal Logic** | Sequential wait-resume pattern via n8n |
| **Connected Modules** | Email Automation, Assessment System (PASS gate) |

**Scheduling flow:**

```
PASS result
  → CODE Prep scheduling from PASS
  → CODE Build interviewer mail context
  → MAIL Interviewer pick slot (new thread)
  → PATCH interviewer_gmail_thread_id
  → WAIT Interviewer availability (interviewer.html resume)
  → CODE Parse interviewer slot
  → CODE Build candidate slot mail (thread reply)
  → WAIT Candidate slot choice (candidate-pick.html resume)
  → CODE Parse candidate choice
  → Google Calendar Create Event
  → CODE Build interview confirmed mail (thread reply)
  → CODE Build interviewer confirmed mail
```

**Key files:** `interviewer.html`, `candidate-pick.html`, `scheduling-success.html`, `n8n_code_build_interviewer_mail_context.js`, `n8n_code_build_candidate_slot_mail.js`

---

### 3.7 Email Automation System

**Purpose:** Manage all candidate and interviewer communications as threaded Gmail conversations.

| Aspect | Detail |
|--------|--------|
| **Inputs** | Session context, Gmail thread/message IDs, HTML mail templates from code nodes |
| **Outputs** | Sent/replied emails; updated `gmail_message_id`, `mail_subject`, `interviewer_gmail_*` columns |
| **Internal Logic** | Thread reply chaining via `In-Reply-To`; merge nodes patch Supabase after each send |
| **Connected Modules** | CV Screening, Assessment, Scheduling |

**Email types:**

| Email | Trigger | Thread |
|-------|---------|--------|
| Shortlist outreach | CV SHORTLIST | New thread → assessment portal link |
| Assessment result | PASS or FAIL | Reply to candidate thread |
| Interviewer availability request | PASS | New interviewer thread |
| Candidate slot options | Interviewer submits slots | Reply to candidate thread |
| Interview confirmed | Candidate picks slot | Reply to both threads |

**Key files:** `n8n_code_merge_gmail_reply_response.js`, `n8n_code_merge_gmail_interviewer_response.js`, `supabase_gmail_thread_columns.sql`

---

### 3.8 Recruiter Dashboard

**Purpose:** Central hub for recruiters to manage jobs, screen CVs, and review outcomes.

| Aspect | Detail |
|--------|--------|
| **Inputs** | JD text, CV PDFs, webhook URL, Supabase anon key |
| **Outputs** | Screening requests, results table, published jobs |
| **Internal Logic** | Tab-based SPA-lite (`?tab=intake|results|jobs`); localStorage for webhook URL |
| **Connected Modules** | Job Posting, CV Screening, Database (candidates read) |

**Tabs:**

| Tab | Function |
|-----|----------|
| **Screen CVs** | Single or bulk PDF upload with email extraction |
| **Results** | Load `candidates` table filtered by requisition |
| **Manage Jobs** | CRUD on `jobs`, publish/close, copy apply links |

**Key files:** `recruiter-intake.html`, `screening-results.html` (redirects), `RECRUITER_INTAKE_SETUP.md`

---

### 3.9 Candidate Portal

**Purpose:** Secure assessment experience for shortlisted candidates.

| Aspect | Detail |
|--------|--------|
| **Inputs** | Session ID (from email link), candidate email, phase answers |
| **Outputs** | Answers to n8n webhook; timer state in Supabase |
| **Internal Logic** | React SPA with views: login → guidelines → assessment → finished |
| **Connected Modules** | Assessment System, Anti-Cheat, Supabase session R/W |

**Key files:** `index.html`

---

## 4. End-to-End Workflow

### 4.1 Complete Hiring Funnel

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ 1. Job       │───►│ 2. Publish   │───►│ 3. Candidate │───►│ 4. CV        │
│    Creation  │    │    & Link    │    │    Applies   │    │    Screening │
└──────────────┘    └──────────────┘    └──────────────┘    └──────┬───────┘
                                                                    │
                    ┌───────────────────────────────────────────────┘
                    ▼
         ┌──────────────────┐
         │ Decision Gate    │
         └────────┬─────────┘
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
  REJECT      REVIEW       SHORTLIST
     │            │            │
     ▼            ▼            ▼
  Log to      Human         Create session
  candidates  queue         + outreach email
  table                     │
                              ▼
                    ┌──────────────────┐
                    │ 5. Assessment    │
                    │    Phases 1–5    │
                    └────────┬─────────┘
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
                  FAIL              PASS
                    │                 │
                    ▼                 ▼
              Result email      6. Scheduling
              (thread reply)    interviewer → candidate
                                      │
                                      ▼
                              7. Calendar + Confirm
                                      │
                                      ▼
                              8. Recruiter Review
                              (Results tab)
```

### 4.2 Step-by-Step Narrative

**Step 1 — Job Creation**  
Recruiter opens `recruiter-intake.html?tab=jobs`, enters title, JD, interviewer email. Job saved to `jobs` with status `draft`.

**Step 2 — Job Publishing**  
Recruiter clicks Publish → status `open`. Apply link generated:  
`https://talent-acquisition-six.vercel.app/apply.html?job={job_id}`  
Job appears on `careers.html`. Optional: post to LinkedIn with external apply URL (Easy Apply disabled).

**Step 3 — Candidate Application**  
Candidate submits email + PDF on apply page. Frontend POSTs to n8n `talent/cv-ingest` with job context from Supabase.

**Step 4 — CV Screening**  
n8n extracts PDF text, checks duplicates, calls Gemini with JD-specific prompt. Returns score, decision, Phase 1 question.

**Step 5 — Shortlist Path**  
If SHORTLIST: insert `assessment_sessions` with Phase 1 question in `interview_history`; send Gmail with portal link `/?session={uuid}&email={email}`.

**Step 6 — Assessment**  
Candidate enters session ID, accepts guidelines, enters fullscreen. For each phase: timer starts → answer submitted → n8n LLM grades → next question or final result.

**Step 7 — Scoring & Decision**  
After Phase 5 (or early termination): average phase scores computed. PASS if ≥ 60. Result PATCHed to session; result email sent.

**Step 8 — Scheduling (PASS only)**  
Interviewer receives email with link to `interviewer.html`. Submits 2–5 slots. Candidate receives slot options via `candidate-pick.html`. Selection creates calendar event.

**Step 9 — Final Decision**  
Recruiter reviews `candidates` table (stage, score, notes) and assessment session results in Results tab.

---

## 5. Database Design

### 5.1 Schema Overview

```
┌─────────────────┐       ┌──────────────────────┐
│     jobs        │       │     app_config       │
├─────────────────┤       ├──────────────────────┤
│ id (uuid PK)    │       │ key (text PK)        │
│ job_id (slug)   │       │ value (text)         │
│ title           │       │ updated_at           │
│ jd_text         │       └──────────────────────┘
│ interviewer_email│              │
│ location        │              │ cv_ingest_webhook
│ employment_type │              ▼
│ department      │       ┌──────────────────────┐
│ status          │       │     candidates       │
│ created_at      │       ├──────────────────────┤
│ updated_at      │       │ id                   │
└────────┬────────┘       │ candidate_email      │
         │                │ stage                │
         │ requisition_id │ score                │
         └───────────────►│ fingerprint          │
                          │ requisition_id       │
                          │ notes (jsonb)        │
                          │ created_at           │
                          └──────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                   assessment_sessions                         │
├──────────────────────────────────────────────────────────────┤
│ id (uuid PK)                                                  │
│ gmail_thread_id          │ candidate_email                   │
│ gmail_message_id         │ mail_subject                      │
│ interviewer_gmail_thread_id │ interviewer_gmail_message_id   │
│ interviewer_mail_subject │ current_phase │ max_phases       │
│ status (assessment|completed) │ result (PASS|FAIL)          │
│ score                    │ screening (jsonb)                 │
│ requisition_id           │ fingerprint                       │
│ cv_plaintext             │ config (jsonb)                    │
│ interview_history (jsonb)│ last_question_sent_at             │
│ created_at │ updated_at                                      │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 Key Tables

#### `jobs`

| Column | Type | Description |
|--------|------|-------------|
| `job_id` | text (unique) | URL slug for apply links |
| `title` | text | Display title |
| `jd_text` | text | Full job description |
| `interviewer_email` | text | Default interviewer for scheduling |
| `status` | text | `draft`, `open`, `closed` |

#### `candidates`

| Column | Type | Description |
|--------|------|-------------|
| `candidate_email` | text | Applicant email |
| `stage` | text | `Shortlisted`, `Rejected`, `ReviewQueue`, `DuplicateSkipped`, `ScreeningTransportFailed` |
| `score` | numeric | CV screening score |
| `fingerprint` | text | `email\|canonical_cv_text` hash |
| `requisition_id` | text | Job slug |
| `notes` | jsonb | Full screening response / AI reason |

#### `assessment_sessions`

| Column | Type | Description |
|--------|------|-------------|
| `interview_history` | jsonb | Array of phase Q&A objects |
| `result` | text | Final `PASS` or `FAIL` |
| `config` | jsonb | JD, thresholds, model config |
| `gmail_*` | text | Thread chaining for email |

#### `interview_history` Entry Schema

```json
{
  "phase": 1,
  "question_text": "On your ASP.NET project...",
  "answer_text": "I implemented...",
  "sent_at": "2026-06-09T10:00:00Z",
  "received_at": "2026-06-09T10:03:00Z",
  "deadline_at": "2026-06-09T10:04:00Z",
  "time_limit_seconds": 240,
  "complexity_tier": "B",
  "timed_out": false,
  "score": 72,
  "feedback": "...",
  "suggested_answer": "...",
  "integrity_terminated": false
}
```

### 5.3 Data Flow Between Tables

```
apply.html ──reads──► jobs, app_config
n8n screening ──writes──► candidates (all outcomes)
n8n shortlist ──writes──► assessment_sessions (new session)
index.html ──reads/writes──► assessment_sessions (timers, history via Supabase client)
n8n assessment ──patches──► assessment_sessions.interview_history, result, score
recruiter-intake ──reads──► candidates, jobs
```

### 5.4 Row-Level Security

- `jobs`, `app_config`: anon read/insert/update (public careers)
- `candidates`: anon SELECT for recruiter results (`supabase_rls_candidates_read.sql`)
- `assessment_sessions`: accessed via anon key from candidate portal (production should tighten to session-scoped policies)

---

## 6. AI Integration Layer

### 6.1 Role of LLM in CV Screening

**Model:** Google Gemini (via n8n HTTP node)

**System prompt characteristics:**

- Acts as Lead AI Talent Acquisition Specialist
- Evaluates CV against recruiter-provided JD only (not generic role)
- Outputs structured JSON: `score`, `decision`, `phase_1_question`, `summary`, `assessment_status`
- Decisions: `SHORTLIST` (strong match), `REJECT` (clear non-fit), `REVIEW` (uncertain)

**Grounding:** JD title and requirements injected from `CODE - Frontend intake`; screening blocked if JD missing.

### 6.2 Role of LLM in Assessment

**Models:** Groq Llama 3.3 70B and/or Google Vertex Gemini 2.0 Flash (configurable per workflow)

**Prompt engineering logic (`CODE - Build LLM context`):**

| Rule Category | Requirement |
|---------------|-------------|
| **CV grounding** | Questions ONLY on skills/projects evidenced in CV excerpt (~8000 chars) |
| **JD alignment** | Every question references JD outcome + CV anchor |
| **Forbidden** | JD-only technologies not on CV (e.g., Blazor if CV shows only ASP.NET Core) |
| **Phase rules** | Phases 1–4: score + next_question; Phase 5: holistic PASS/FAIL only |
| **Time limits** | LLM assigns `time_limit_seconds` (60–600) and `complexity_tier` (A–D) |
| **Output format** | Strict JSON, no markdown fences |

### 6.3 Scoring and Decision-Making

**Two-layer scoring:**

1. **LLM score** (0–100 per phase) — semantic evaluation of answer quality
2. **Deterministic normalization** (`normalizePhaseScore`) — caps scores for:
   - Empty/trivial answers ("ok", "yes")
   - Keyboard mash patterns
   - Short answers without technical markers
   - Generic responses lacking CV-specific evidence

**Final decision logic:**

```
average_score = mean(scorable phase scores)
if integrity_terminated → FAIL
else if early_terminate → FAIL
else if average_score >= pass_threshold (60) → PASS
else → FAIL
```

**Transport failure handling:** Gemini HTTP/parse errors → `REVIEW` decision, logged as `ScreeningTransportFailed`.

---

## 7. Workflow Automation (n8n)

### 7.1 Workflow Inventory

| Workflow File | Trigger | Purpose |
|---------------|---------|---------|
| `Talent Acquisition — CV Screening.json` | `POST /webhook/talent/cv-ingest` | CV intake, screening, shortlist |
| `Talent Acquisition — Assessment + Scheduling (Threaded Mail).json` | `POST /webhook/assessment-answer` | Assessment grading + scheduling |
| `Talent Acquisition — Enterprise (...).json` | Combined enterprise variant | Full pipeline in one workflow |

### 7.2 Webhook Structure

| Endpoint | Method | Body Fields |
|----------|--------|-------------|
| `/webhook/talent/cv-ingest` | POST | `candidate_email`, `requisition_title`, `requisition_requirements`, `requisition_id`, `interviewer_email`, `cv_file` or `cv_text` |
| `/webhook/assessment-answer` | POST | `sessionId`, `email`, `answer`, `phase`, `tabSwitches`, `integrityViolations`, `violationReason` |
| WAIT `interviewer-availability` | POST (resume) | `slots[]` with `start_iso`, `end_iso`, `label` |
| WAIT `candidate-slot-choice` | POST (resume) | `selected_slot` or `slot_index` |

### 7.3 CV Screening Node Flow

```
TRG - Manual (testing)  ──┐
TRG - Webhook CV ingest ──┼──► MUX - Combine manual and webhook
                          │
                          ▼
                    PDF - Extract text
                          ▼
              CODE - Frontend intake (JD + CV)
                          ▼
              CFG - Workflow configuration
                          ▼
              DB - Supabase read candidates
                          ▼
              CODE - Expand CVs and duplicate flag
                          ▼
              GATE - Not duplicate ──► (duplicate skip log)
                          ▼
              CODE - CV plain text
                          ▼
              Gemini - CV screening agent (request + API)
                          ▼
              CODE - Parse CV screening outcome
                          ▼
              GATE - Screening transport OK
                          ▼
              GATE - Initial CV Pass
                    ├─ SHORTLIST → Session insert → Gmail → PATCH
                    ├─ REVIEW → Log ReviewQueue
                    └─ REJECT → Log Rejected
```

### 7.4 Assessment + Scheduling Node Flow

```
TRG - Assessment Answer
      ▼
CFG - Assessment Config
      ▼
CODE - Normalize Data
      ▼
HTTP - Fetch Session
      ▼
CODE - Build LLM context
      ▼
Basic LLM Chain ◄── Google Vertex Chat Model
      ▼
CODE - Parse Result
      ▼
HTTP - SB PATCH session interview_history
      ▼
Respond to Portal (JSON: nextQuestion, score, isFinal, result)
      │
      ├─ isFinal + PASS ──► Result mail → Prep scheduling → Interviewer mail
      │                                              ▼
      │                                    WAIT interviewer-availability
      │                                              ▼
      │                                    Candidate slot mail
      │                                              ▼
      │                                    WAIT candidate-slot-choice
      │                                              ▼
      │                                    Calendar event → Confirm mails
      │
      └─ isFinal + FAIL ──► Result mail (thread reply)
```

### 7.5 Event-Driven Architecture

| Event | Producer | Consumer | Side Effect |
|-------|----------|----------|-------------|
| CV submitted | apply.html / recruiter-intake | n8n CV workflow | Screening execution |
| SHORTLIST | Gemini decision gate | Gmail + Supabase | Session + email |
| Answer submitted | index.html | n8n assessment webhook | LLM grade + history PATCH |
| PASS | Parse Result | Scheduling chain | Interviewer email |
| Slots proposed | interviewer.html | WAIT resume | Candidate slot email |
| Slot chosen | candidate-pick.html | WAIT resume | Calendar + confirmations |

### 7.6 Supporting Code Modules

Reusable JavaScript modules (paste into n8n Code nodes):

| File | Node |
|------|------|
| `n8n_code_frontend_intake.js` | CODE - Frontend intake |
| `n8n_code_parse_assessment_result.js` | CODE - Parse Result |
| `n8n_code_build_pass_session_patch.js` | PASS session PATCH |
| `n8n_code_prep_scheduling_from_pass.js` | Scheduling prep |
| `n8n_code_build_interviewer_mail_context.js` | Interviewer email |
| `n8n_code_build_candidate_slot_mail.js` | Candidate slot email |
| `n8n_code_merge_gmail_reply_response.js` | Thread ID chaining |
| `n8n_code_sb_urls_after_outreach_mail.js` | Post-outreach Supabase URLs |

Build/migration tooling: `apply_workflow_migration.py`, `scripts/build_assessment_scheduling_workflow.mjs`

---

## 8. Frontend System

### 8.1 Portal Structure

| Page | Audience | Stack |
|------|----------|-------|
| `recruiter-intake.html` | Recruiters | Vanilla JS + Supabase |
| `apply.html` | Applicants | Vanilla JS + Supabase + FormData |
| `careers.html` | Public | Job listing from Supabase |
| `index.html` | Assessment candidates | React 18 + Tailwind + Supabase |
| `interviewer.html` | Interviewers | Flatpickr date picker |
| `candidate-pick.html` | Candidates (scheduling) | Slot selection UI |
| `scheduling-success.html` | Confirmation | Static thank-you |
| `screening-results.html` | Legacy redirect | → `recruiter-intake.html?tab=results` |

### 8.2 UI/UX Flow

**Recruiter:**

```
Hub → Screen CVs | Results | Manage Jobs
         │              │           │
         ▼              ▼           ▼
    Upload PDFs    Load candidates  CRUD jobs
    + JD once      by requisition   + publish
```

**Candidate (Assessment):**

```
Email link → Login (session ID)
         → Guidelines (integrity rules)
         → Fullscreen assessment (timed phases)
         → Finished (PASS/FAIL display)
```

### 8.3 State Management and Session Handling

**Assessment portal (`index.html`):**

| State | Storage | Purpose |
|-------|---------|---------|
| `current_session_id` | sessionStorage | Active session UUID |
| `candidate_email` | sessionStorage | Email validation |
| `assessment_started` | sessionStorage | Guidelines completion flag |
| `deadline_at` / `time_left` | sessionStorage | Timer recovery on refresh |
| `interview_history` | Supabase | Authoritative Q&A state |
| `view` | React state | `login` → `guidelines` → `assessment` → `finished` |

**Session resolution:** Accepts UUID or `gmail_thread_id` from URL `?session=` parameter.

**Timer model:** Deadline stored in Supabase `interview_history[].deadline_at`; client computes remaining from ISO timestamp; auto-submits `[Timeout]` on expiry.

---

## 9. Security & Anti-Cheat System

### 9.1 Design Principles

- Assessment runs in **mandatory fullscreen** from sign-in
- **Portal lock** disables copy/paste/context menu during assessment
- **3-strike integrity policy** before automatic termination
- Violations debounced (1200ms) to prevent false positives

### 9.2 Detection Mechanisms

| Mechanism | Implementation |
|-----------|----------------|
| **DevTools detection** | Window size delta (>140px), console probe, debugger timing |
| **Tab switch** | `visibilitychange` event + blocked Alt+Tab/Ctrl+Tab |
| **Fullscreen exit** | `fullscreenchange` listener + Esc blur overlay |
| **Screenshot** | Print Screen, Win+Shift+S (Snipping Tool) blocked |
| **Keyboard shortcuts** | F12, Ctrl+Shift+I, Ctrl+U, F11 blocked |

### 9.3 Violation Tracking Logic

```javascript
MAX_INTEGRITY_VIOLATIONS = 3  // 3rd violation terminates

Violation types:
  - tab_switch
  - devtools
  - fullscreen_exit
  - blocked_shortcut
  - screenshot / snipping_tool
  - print_attempt

On violation #1 or #2: alert warning
On violation #3: POST to n8n with
  answer: "[SYSTEM TERMINATION: Integrity violation #N (reason). Cheating detected.]"
  → Parse Result marks integrity_terminated
  → Immediate FAIL (prior phase scores preserved)
```

### 9.4 Esc Key Behavior

Pressing Esc does not exit assessment—it **blurs the screen** and hides question content until candidate returns to fullscreen and closes DevTools.

---

## 10. Deployment Architecture

### 10.1 Repository & CI

| Aspect | Detail |
|--------|--------|
| **Source control** | Git (Bitbucket + GitHub remotes) |
| **Branch strategy** | `main` (production), feature branches (e.g., `HussainAliJaved`) |
| **GitHub Actions** | Not configured in repo (manual Vercel deploy on push) |

### 10.2 Vercel Deployment

**Configuration (`vercel.json`):**

```json
{
  "version": 2,
  "outputDirectory": ".",
  "cleanUrls": true,
  "trailingSlash": false
}
```

- Static HTML files served from repository root
- Clean URLs: `/apply` → `apply.html`
- Production: `https://talent-acquisition-six.vercel.app`

### 10.3 Environment Variables and Configuration

| Variable / Config | Location | Purpose |
|-------------------|----------|---------|
| `SUPABASE_URL` | Frontend + n8n CFG | Database endpoint |
| `SUPABASE_ANON_KEY` | Frontend | Client-side reads/writes |
| `SUPABASE_SERVICE_ROLE_KEY` | n8n `$env` | Server-side REST writes |
| `GOOGLE_CLOUD_PROJECT` | n8n Vertex node | Gemini assessment |
| `WEBHOOK_URL` / `N8N_WEBHOOK_URL` | n8n env | Public webhook base for resume URLs |
| Gmail OAuth credentials | n8n | Email send/reply |
| `cv_ingest_webhook` | `app_config` table | Apply page webhook URL |
| n8n webhook URL | localStorage (recruiter browser) | CV screening form |

**Secrets excluded from git (`.gitignore`):** `.env`, `credentials.json`, `google_service_account.json`, `*.pem`, `*.key`

### 10.4 Production vs Development

| Concern | Production | Development |
|---------|------------|-------------|
| Frontend | Vercel CDN | Local file server or Vercel preview |
| n8n | Cloud public URL | ngrok tunnel to localhost |
| CORS | Vercel origin whitelisted in n8n | ngrok or localhost allowed |
| Webhooks | Stable `/webhook/talent/cv-ingest` | ngrok URL (changes per session) |
| Supabase | Shared project | Same or branch database |

### 10.5 n8n Deployment Requirements

1. Import workflow JSON files
2. Activate workflows
3. Configure credentials: Gmail, Google Vertex, Supabase service key
4. Set CORS headers on webhook nodes for Vercel origin
5. Apply code node patches from `n8n_code_*.js` files
6. Run Supabase migrations: `supabase_jobs.sql`, `supabase_interview_history.sql`, `supabase_gmail_thread_columns.sql`, `supabase_rls_candidates_read.sql`

---

## 11. Appendix

### 11.1 Glossary

| Term | Definition |
|------|------------|
| **JD** | Job Description — requirements text provided by recruiter |
| **Fingerprint** | Dedup key: `email\|canonical_cv_text` |
| **requisition_id** | Job slug linking application to specific posting |
| **interview_history** | JSONB array of all assessment Q&A phases |
| **Threaded mail** | Gmail replies using stored `gmail_message_id` for chaining |
| **WAIT node** | n8n node that pauses until resume webhook called |

### 11.2 Stage Values (`candidates.stage`)

| Stage | Meaning |
|-------|---------|
| `Shortlisted` | CV passed; assessment initiated |
| `Rejected` | CV failed screening |
| `ReviewQueue` | Uncertain; needs human review |
| `DuplicateSkipped` | Same email+CV+job already processed |
| `ScreeningTransportFailed` | AI API error during screening |

### 11.3 External Integrations

| Integration | Use Case |
|-------------|----------|
| LinkedIn Jobs | External apply URL pointing to `apply.html` |
| Google Calendar | Interview event with candidate + interviewer attendees |
| ngrok | Local n8n webhook tunneling for development |

### 11.4 Document Maintenance

When modifying the system, update this document if changes affect:

- Webhook paths or payload schemas
- Database columns or RLS policies
- Assessment phase count or scoring thresholds
- Email thread field names
- Frontend portal URLs or tab structure

---

*End of System Design Documentation*

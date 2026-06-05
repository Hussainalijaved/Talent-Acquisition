"""
Apply Supabase + 5-phase assessment migration to Talent Acquisition n8n export.

  python apply_workflow_migration.py
"""

from __future__ import annotations

import copy
import json
import pathlib
import uuid


def nid() -> str:
    return str(uuid.uuid4())


def fork(true_t: str, false_t: str) -> dict:
    return {"main": [[{"node": true_t, "type": "main", "index": 0}], [{"node": false_t, "type": "main", "index": 0}]]}


ROOT = pathlib.Path(__file__).resolve().parent
_path = next(ROOT.glob("Talent Acquisition*.json"))
wf = json.loads(_path.read_text(encoding="utf-8"))

ORIG_CONN = copy.deepcopy(wf.get("connections", {}))

KILL_TYPES = {"n8n-nodes-base.googleSheets", "n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.stickyNote"}
KILL_NAMES = {
    "TRG - Cron weekly sweep",
    "Note - Cron ingest",
    "DB - Sheets read pending replies",
    "CODE - Resolve reply and context",
    "CODE - Timer Calculation",
    "Gemini - AI Detection (request)",
}

SKIP_CONN_KEYS = {
    "TRG - Cron weekly sweep",
}

wf["nodes"] = [n for n in wf["nodes"] if not (n.get("type") in KILL_TYPES or n.get("name") in KILL_NAMES)]
by_name = {n["name"]: n for n in wf["nodes"]}


def cn(name: str, pos: list[int], js: str):
    return {"parameters": {"jsCode": js}, "id": nid(), "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2, "position": pos}


def gate(name: str, pos: list[int], left: str, right, op_type: str, op: str = "equals"):
    return {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                "conditions": [{"id": nid()[:12], "leftValue": left, "rightValue": right, "operator": {"type": op_type, "operation": op}}],
                "combinator": "and",
            }
        },
        "id": nid(),
        "name": name,
        "type": "n8n-nodes-base.if",
        "typeVersion": 2.2,
        "position": pos,
    }


def http(name: str, pos: list[int], method: str, url: str, body: str | None, headers_reply: bool, prefer_repr: bool):
    h = []
    if headers_reply:
        h = [
            {"name": "apikey", "value": "={{ $('CFG - Reply track (merge)').first().json.config.supabase_key }}"},
            {"name": "Authorization", "value": "=Bearer {{ $('CFG - Reply track (merge)').first().json.config.supabase_key }}"},
        ]
    else:
        h = [
            {"name": "apikey", "value": "={{ $('CFG - Workflow configuration').first().json.config.supabase_key }}"},
            {"name": "Authorization", "value": "=Bearer {{ $('CFG - Workflow configuration').first().json.config.supabase_key }}"},
        ]
    rest = [{"name": "Accept", "value": "application/json"}]
    if method in ("POST", "PATCH"):
        rest.insert(0, {"name": "Content-Type", "value": "application/json"})
    if prefer_repr and method not in ("GET",):
        rest.append({"name": "Prefer", "value": "return=representation"})
    if not prefer_repr and method == "PATCH":
        rest.append({"name": "Prefer", "value": "return=minimal"})
    params: dict = {
        "method": method,
        "url": url,
        "authentication": "none",
        "sendHeaders": True,
        "headerParameters": {"parameters": [*h, *rest]},
        "options": {"timeout": 180000},
    }
    if body is not None:
        params["sendBody"] = True
        params["specifyBody"] = "json"
        params["jsonBody"] = body
    return {"parameters": params, "id": nid(), "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": pos, "retryOnFail": True, "maxTries": 3}


def gh(name: str, pos: list[int], url: str, body: str):
    return {
        "parameters": {
            "method": "POST",
            "url": url,
            "authentication": "none",
            "sendHeaders": True,
            "headerParameters": {
                "parameters": [
                    {"name": "Content-Type", "value": "application/json"},
                    {"name": "x-goog-api-key", "value": "={{ $env.GEMINI_API_KEY }}"},
                ]
            },
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": body,
            "options": {"timeout": 180000},
        },
        "id": nid(),
        "name": name,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": pos,
    }


for n in wf["nodes"]:
    if n["name"] != "CFG - Workflow configuration":
        continue
    a = n["parameters"]["assignments"]["assignments"]
    seen = {x["name"] for x in a}
    for tup in (
        ("t_sess", "config.table_assessment_sessions", "assessment_sessions", "string"),
        ("t_q", "config.table_assessment_questions", "assessment_questions", "string"),
        ("t_er", "config.table_errors", "workflow_errors", "string"),
        ("t_min", "config.min_response_seconds", 30, "number"),
    ):
        k = tup[1]
        if k in seen:
            continue
        d = {"id": tup[0], "name": k, "value": tup[2], "type": tup[3]}
        a.append(d)
        seen.add(k)

for n in wf["nodes"]:
    if n["name"] == "CFG - Reply track (merge)":
        n["parameters"]["assignments"]["assignments"] = [
            {"id": "r1", "name": "config.supabase_url", "value": "={{ $env.SUPABASE_URL || 'https://your-project.supabase.co' }}", "type": "string"},
            {"id": "r2", "name": "config.supabase_key", "value": "={{ $env.SUPABASE_SERVICE_ROLE_KEY }}", "type": "string"},
            {"id": "r3", "name": "config.table_assessment_sessions", "value": "assessment_sessions", "type": "string"},
            {"id": "r4", "name": "config.table_assessment_questions", "value": "assessment_questions", "type": "string"},
            {"id": "r5", "name": "config.table_scheduling", "value": "scheduling_log", "type": "string"},
            {"id": "r6", "name": "config.table_candidates", "value": "candidates", "type": "string"},
            {"id": "r7", "name": "config.table_errors", "value": "workflow_errors", "type": "string"},
            {"id": "r8", "name": "config.gemini_model", "value": "gemini-2.0-flash", "type": "string"},
            {"id": "r9", "name": "config.calendar_id", "value": "primary", "type": "string"},
            {"id": "r10", "name": "config.interviewer_email", "value": "interviewer@example.com", "type": "string"},
            {"id": "r11", "name": "config.max_questions", "value": 5, "type": "number"},
            {"id": "r12", "name": "config.organization_name", "value": "Example Corporation Ltd.", "type": "string"},
            {"id": "r13", "name": "config.min_response_seconds", "value": 30, "type": "number"},
            {"id": "r14", "name": "config.talent_alias", "value": "talent@example.com", "type": "string"},
        ]

p_js = by_name["CODE - Parse CV screening outcome"]["parameters"]["jsCode"]
p_js = (
    p_js.replace(
        "assessment_status: 'IN_PROGRESS',\n      screening_transport_failed: true",
        "assessment_status: 'IN_PROGRESS',\n      session_phase: 1,\n      screening_transport_failed: true",
    )
    .replace(
        "assessment_status: 'IN_PROGRESS',\n      screening_transport_failed: false",
        "assessment_status: 'IN_PROGRESS',\n      session_phase: 1,\n      screening_transport_failed: false",
    )
)
p_js = p_js.replace(
    "phase_1_question, assessment_status, screening_transport_failed: false } }];",
    "phase_1_question, assessment_status, session_phase: 1, screening_transport_failed: false } }];",
)
by_name["CODE - Parse CV screening outcome"]["parameters"]["jsCode"] = p_js

m = by_name["MAIL - Email outreach agent (shortlist)"]
m["parameters"]["message"] = (
    "=Dear candidate,\\n\\nCV screening score: {{ $json.score }}/100.\\n\\n"
    "Phase {{ $json.session_phase }} of {{ $json.config.max_questions }} — technical drill-down. "
    "Reply to this thread with your answer only.\\n\\n{{ $json.phase_1_question }}\\n\\n"
    "Assessment status: {{ $json.assessment_status }}\\n\\nTalent team: {{ $json.config.talent_alias }}.\\n\\n"
    "Regards,\\n{{ $json.config.organization_name }}\\nTalent Acquisition"
)
m["parameters"]["subject"] = "=Your application — assessment Phase {{ $json.session_phase }}/{{ $json.config.max_questions }}"

MAIL_FOLLOW = copy.deepcopy(m)
MAIL_FOLLOW["id"] = nid()
MAIL_FOLLOW["name"] = "MAIL - Assessment follow-up question"
MAIL_FOLLOW["position"] = [5120, 880]
MAIL_FOLLOW["webhookId"] = nid()


NEW = []
NEW.append(
    http(
        "HTTP - SB log duplicate skip",
        [1400, 880],
        "POST",
        "={{ $('CFG - Workflow configuration').first().json.config.supabase_url.replace(/\\/$/, '') + '/rest/v1/' + $('CFG - Workflow configuration').first().json.config.table_candidates }}",
        """={{ ({
  candidate_email: $json.candidate_email,
  stage: 'DuplicateSkipped',
  score: null,
  fingerprint: $json.fingerprint,
  requisition_id: $json.requisition_id || '',
  notes: { reason: 'duplicate_same_job_cv', fingerprint: $json.fingerprint },
}) }}""",
        False,
        True,
    )
)

NEW.extend(
    [
        http(
            "HTTP - SB log screening failed",
            [2460, 864],
            "POST",
            "={{ $('CFG - Workflow configuration').first().json.config.supabase_url.replace(/\\/$/, '') + '/rest/v1/' + $('CFG - Workflow configuration').first().json.config.table_candidates }}",
            """={{ ({
  candidate_email: $json.candidate_email,
  stage: 'ScreeningTransportFailed',
  score: $json.score,
  fingerprint: $json.fingerprint,
  requisition_id: $json.requisition_id || '',
  notes: $json.screening,
}) }}""",
            False,
            True,
        ),
        http(
            "HTTP - SB log review queue",
            [2660, 480],
            "POST",
            "={{ $('CFG - Workflow configuration').first().json.config.supabase_url.replace(/\\/$/, '') + '/rest/v1/' + $('CFG - Workflow configuration').first().json.config.table_candidates }}",
            """={{ ({
  candidate_email: $json.candidate_email,
  stage: 'ReviewQueue',
  score: $json.score,
  fingerprint: $json.fingerprint,
  requisition_id: $json.requisition_id || '',
  notes: $json.screening,
}) }}""",
            False,
            True,
        ),
        http(
            "HTTP - SB log rejected",
            [2660, 736],
            "POST",
            "={{ $('CFG - Workflow configuration').first().json.config.supabase_url.replace(/\\/$/, '') + '/rest/v1/' + $('CFG - Workflow configuration').first().json.config.table_candidates }}",
            """={{ ({
  candidate_email: $json.candidate_email,
  stage: 'Rejected',
  score: $json.score,
  fingerprint: $json.fingerprint,
  requisition_id: $json.requisition_id || '',
  notes: $json.screening,
}) }}""",
            False,
            True,
        ),
    ]
)

NEW.extend(
    [
        cn(
            "CODE - SB URLs after outreach mail",
            [2720, 520],
            r"""const j = $('CODE - Merge Gmail send response').first().json;
const b = String(j.config?.supabase_url || '').replace(/\/+$/, '');
return [{
  json: {
    ...j,
    session_phase: j.session_phase || 1,
    _sb_insert_candidates: `${b}/rest/v1/${j.config?.table_candidates || 'candidates'}`,
    _sb_insert_sessions: `${b}/rest/v1/${j.config?.table_assessment_sessions || 'assessment_sessions'}`,
    _sb_insert_questions: `${b}/rest/v1/${j.config?.table_assessment_questions || 'assessment_questions'}`,
  },
}];""",
        ),
        http(
            "HTTP - SB candidates shortlisted",
            [2940, 520],
            "POST",
            "={{ $('CODE - SB URLs after outreach mail').first().json._sb_insert_candidates }}",
            """={{ ({
  candidate_email: $('CODE - SB URLs after outreach mail').first().json.candidate_email,
  stage: 'Shortlisted',
  score: $('CODE - SB URLs after outreach mail').first().json.score,
  fingerprint: $('CODE - SB URLs after outreach mail').first().json.fingerprint,
  requisition_id: $('CODE - SB URLs after outreach mail').first().json.requisition_id || '',
  notes: $('CODE - SB URLs after outreach mail').first().json.screening,
}) }}""",
            False,
            True,
        ),
        cn(
            "CODE - SB prepare session insert",
            [3160, 520],
            r"""const base = $('CODE - SB URLs after outreach mail').first().json;
const nowIso = new Date().toISOString();
const cv = String(base.cv_plaintext || base.cv_text || '').slice(0, 12000);
const sessionBody = {
  gmail_thread_id: base.gmail_thread_id,
  candidate_email: base.candidate_email,
  current_phase: 1,
  max_phases: base.config?.max_questions ?? 5,
  status: 'assessment',
  screening: base.screening,
  score: base.score,
  requisition_id: base.requisition_id || '',
  fingerprint: base.fingerprint || '',
  cv_plaintext: cv,
  last_question_sent_at: nowIso,
  updated_at: nowIso,
};
const b = String(base.config?.supabase_url||'').replace(/\/+$/, '');
return [{
  json: {
    ...base,
    _sb_insert_sessions: `${b}/rest/v1/${base.config?.table_assessment_sessions||'assessment_sessions'}`,
    _sb_insert_questions: `${b}/rest/v1/${base.config?.table_assessment_questions||'assessment_questions'}`,
    _session_body: sessionBody,
    _q_text: base.phase_1_question,
    _now: nowIso,
  },
}];""",
        ),
        http(
            "HTTP - SB insert assessment session",
            [3380, 520],
            "POST",
            "={{ $('CODE - SB prepare session insert').first().json._sb_insert_sessions }}",
            "={{ $('CODE - SB prepare session insert').first().json._session_body }}",
            False,
            True,
        ),
        cn(
            "CODE - SB map session id for Q1",
            [3560, 520],
            r"""const base = $('CODE - SB prepare session insert').first().json;
let row = $input.first().json;
if (Array.isArray(row)) row = row[0];
const session_id = row?.id;
if (!session_id) return [{ json: { ...base, sb_error: 'no_session_row', raw: row } }];
const qBody = { session_id, phase: 1, question_text: base._q_text || '', sent_at: base._now };
return [{
  json: {
    ...base,
    session_db_id: session_id,
    _question_payload: qBody,
  },
}];""",
        ),
        http(
            "HTTP - SB insert question phase 1",
            [3780, 520],
            "POST",
            "={{ $('CODE - SB prepare session insert').first().json._sb_insert_questions }}",
            "={{ $('CODE - SB map session id for Q1').first().json._question_payload }}",
            False,
            True,
        ),
        http(
            "HTTP - SB scheduling conflict log",
            [2380, 1520],
            "POST",
            "={{ $('CFG - Reply track (merge)').first().json.config.supabase_url.replace(/\\/$/, '') + '/rest/v1/' + $('CFG - Reply track (merge)').first().json.config.table_scheduling }}",
            """={{ ({
  candidate_email: $('CODE - Matching result').first().json.candidate_email,
  event_id: '',
  status: 'scheduled_conflict',
}) }}""",
            True,
            True,
        ),
        http(
            "HTTP - SB scheduling success log",
            [3120, 1520],
            "POST",
            "={{ $('CFG - Reply track (merge)').first().json.config.supabase_url.replace(/\\/$/, '') + '/rest/v1/' + $('CFG - Reply track (merge)').first().json.config.table_scheduling }}",
            """={{ ({
  candidate_email: $('CODE - Matching result').first().json.candidate_email,
  event_id: 'scheduled',
  status: 'notified_complete',
}) }}""",
            True,
            True,
        ),
        http(
            "HTTP - SB workflow error log",
            [520, 1600],
            "POST",
            r"={{ `${String($env.SUPABASE_URL || '').replace(/\/+$/, '')}/rest/v1/workflow_errors` }}",
            """={{ ({
  ts: $now.toISO(),
  workflow: $workflow.name,
  message: $json.execution.error.message || 'unknown_error',
  node: $json.execution.error.node?.name || '',
}) }}""",
            False,
            True,
        ),
    ]
)

sticky = {
    "parameters": {
        "content": (
            "### Supabase DDL — run once in SQL editor\\n```sql\\n"
            "CREATE TABLE IF NOT EXISTS candidates (\\n"
            "  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\\n"
            "  candidate_email TEXT NOT NULL,\\n"
            "  stage TEXT,\\n"
            "  score INT,\\n"
            "  fingerprint TEXT,\\n"
            "  requisition_id TEXT,\\n"
            "  notes JSONB,\\n"
            "  screening JSONB,\\n"
            "  created_at TIMESTAMPTZ DEFAULT NOW()\\n"
            ");\\n"
            "CREATE TABLE IF NOT EXISTS assessment_sessions (\\n"
            "  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\\n"
            "  gmail_thread_id TEXT NOT NULL UNIQUE,\\n"
            "  candidate_email TEXT NOT NULL,\\n"
            "  current_phase INT DEFAULT 1,\\n"
            "  max_phases INT DEFAULT 5,\\n"
            "  status TEXT DEFAULT 'assessment',\\n"
            "  screening JSONB,\\n"
            "  score INT,\\n"
            "  requisition_id TEXT,\\n"
            "  fingerprint TEXT,\\n"
            "  cv_plaintext TEXT,\\n"
            "  last_question_sent_at TIMESTAMPTZ,\\n"
            "  updated_at TIMESTAMPTZ DEFAULT NOW()\\n"
            ");\\n"
            "CREATE TABLE IF NOT EXISTS assessment_questions (\\n"
            "  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\\n"
            "  session_id UUID NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,\\n"
            "  phase INT NOT NULL,\\n"
            "  question_text TEXT NOT NULL,\\n"
            "  sent_at TIMESTAMPTZ NOT NULL,\\n"
            "  answer_text TEXT,\\n"
            "  received_at TIMESTAMPTZ,\\n"
            "  response_time_seconds INT,\\n"
            "  is_too_fast BOOLEAN,\\n"
            "  ai_likelihood REAL,\\n"
            "  ai_reason TEXT\\n"
            ");\\n"
            "CREATE TABLE IF NOT EXISTS scheduling_log (\\n"
            "  id BIGSERIAL PRIMARY KEY,\\n"
            "  candidate_email TEXT NOT NULL,\\n"
            "  event_id TEXT,\\n"
            "  status TEXT\\n"
            ");\\n"
            "CREATE TABLE IF NOT EXISTS workflow_errors (\\n"
            "  id BIGSERIAL PRIMARY KEY,\\n"
            "  ts TEXT,\\n"
            "  workflow TEXT,\\n"
            "  message TEXT,\\n"
            "  node TEXT\\n"
            ");\\n```\\nCredentials: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, GEMINI_API_KEY."
        ),
        "height": 460,
        "width": 540,
    },
    "type": "n8n-nodes-base.stickyNote",
    "typeVersion": 1,
    "position": [520, 40],
    "id": nid(),
    "name": "Note - Supabase schema",
}

# --- Gmail assessment chain ---
NEW.append(
    cn(
        "CODE - Inbound Gmail normalize",
        [420, 1216],
        r"""const email = $('TRG - Gmail candidate reply').first().json;
const cfg = $('CFG - Reply track (merge)').first().json.config;
const from = (email.from?.value?.[0]?.address || '').trim().toLowerCase();
const threadId = email.threadId || email.thread_id || '';
const text = email.text || email.textPlain || email.snippet || '';
const base = String(cfg.supabase_url || '').replace(/\/+$/, '');
const tb = cfg.table_assessment_sessions || 'assessment_sessions';
const encT = encodeURIComponent(threadId || 'none');
const encE = encodeURIComponent(from);
const lookup = `${base}/rest/v1/${tb}?select=*&or=(gmail_thread_id.eq.${encT},candidate_email.eq.${encE})&order=updated_at.desc&limit=5`;
return [{ json: { config: cfg, candidate_email: from, thread_id: threadId, reply_text: text, session_lookup_url: lookup } }];""",
    )
)

NEW.append(
    http(
        "HTTP - SB fetch assessment session",
        [620, 1216],
        "GET",
        "={{ $('CODE - Inbound Gmail normalize').first().json.session_lookup_url }}",
        None,
        True,
        False,
    )
)


NEW.extend(
    [
        cn(
            "CODE - Pick assessment session row",
            [820, 1216],
            r"""const rows = Array.isArray($json) ? $json : ($json.body || []);
const prev = $('CODE - Inbound Gmail normalize').first().json;
const pick =
  rows.find((r) => r.gmail_thread_id && prev.thread_id && String(r.gmail_thread_id) === String(prev.thread_id)) ||
  rows.find((r) => String(r.candidate_email || '').toLowerCase() === prev.candidate_email) ||
  rows[0] ||
  null;
return [{ json: { ...prev, session_row: pick, session_found: Boolean(pick) } }];""",
        ),
        gate("GATE - Assessment session found", [1020, 1216], "={{ $json.session_found }}", True, "boolean", "equals"),
        gate("GATE - Session in assessment status", [1120, 1216], "={{ $json.session_row.status }}", "assessment", "string", "equals"),
        cn(
            "CODE - Prep open question URL",
            [1260, 1080],
            r"""const p = $('CODE - Pick assessment session row').first().json;
const s = p.session_row;
const cfg = p.config;
const b = String(cfg.supabase_url || '').replace(/\/+$/, '');
const tb = cfg.table_assessment_questions || 'assessment_questions';
const sid = String(s.id);
const ph = Number(s.current_phase || 1);
const url = `${b}/rest/v1/${tb}?select=*&session_id=eq.${encodeURIComponent(sid)}&phase=eq.${ph}&received_at=is.null&order=sent_at.desc&limit=1`;
return [{ json: { ...p, open_question_lookup_url: url, session_phase_num: ph, session_snapshot: s } }];""",
        ),
        http(
            "HTTP - SB fetch open question",
            [1480, 1080],
            "GET",
            "={{ $('CODE - Prep open question URL').first().json.open_question_lookup_url }}",
            None,
            True,
            False,
        ),
        cn(
            "CODE - Attach open question row",
            [1660, 1080],
            r"""const rows = Array.isArray($json) ? $json : ($json.body || []);
const prev = $('CODE - Prep open question URL').first().json;
const open_question = rows[0] || null;
return [{
  json: {
    ...prev,
    open_question,
    has_open_question: Boolean(open_question?.id && String(open_question.question_text || '').trim().length > 0),
  },
}];""",
        ),
        gate("GATE - Has open question", [1860, 1080], "={{ $json.has_open_question }}", True, "boolean", "equals"),
        cn(
            "CODE - Timer + PATCH answer payload",
            [2060, 1080],
            r"""const p = $('CODE - Attach open question row').first().json;
const q = p.open_question;
const minSec = Number(p.config.min_response_seconds ?? 30);
const sentMs = new Date(q.sent_at).getTime();
const secs = Number.isFinite(sentMs) ? Math.max(0, Math.floor((Date.now() - sentMs) / 1000)) : 0;
const isToo = secs < minSec;
const answer = String(p.reply_text || '').trim();
const b = String(p.config.supabase_url || '').replace(/\/+$/, '');
const tb = p.config.table_assessment_questions || 'assessment_questions';
const url = `${b}/rest/v1/${tb}?id=eq.${encodeURIComponent(q.id)}`;
return [{
  json: {
    ...p,
    response_time_seconds: secs,
    is_too_fast: isToo,
    cleaned_answer: answer,
    _answer_patch_url: url,
    _answer_patch_body: {
      answer_text: answer,
      received_at: new Date().toISOString(),
      response_time_seconds: secs,
      is_too_fast: isToo,
    },
  },
}];""",
        ),
        http(
            "HTTP - SB PATCH question answer",
            [2260, 1080],
            "PATCH",
            "={{ $('CODE - Timer + PATCH answer payload').first().json._answer_patch_url }}",
            "={{ $('CODE - Timer + PATCH answer payload').first().json._answer_patch_body }}",
            True,
            False,
        ),
        cn(
            "Gemini - AI Detection (request body)",
            [2460, 1080],
            r"""const p = $('CODE - Timer + PATCH answer payload').first().json;
const model = p.config.gemini_model || 'gemini-2.0-flash';
const sys = ['You classify if the reply likely used heavy ChatGPT/similar rewriting.', 'Return JSON only.', 'Weak signals ok: timing_seconds, fluency.', 'Likelihood scale 0-1.'].join(' ');
const user = ['timing_seconds='+String(p.response_time_seconds),'too_fast='+String(p.is_too_fast),'text:', String(p.cleaned_answer||'').slice(0,16000)].join('\n');
const body = {
  systemInstruction:{role:'system',parts:[{text:sys}]},
  contents:[{role:'user',parts:[{text:user}]}],
  generationConfig:{
    temperature:0.15,
    responseMimeType:'application/json',
    responseSchema:{
      type:'OBJECT',
      properties:{ ai_likelihood:{type:'NUMBER'}, reason:{type:'STRING'}},
      required:['ai_likelihood','reason'],
    },
  },
};
return [{ json:{ ...p,_gem_ai_model:model,gemini_ai_detect_request:body}}];""",
        ),
        gh(
            "Gemini - AI Detection (API)",
            [2680, 1080],
            "=https://generativelanguage.googleapis.com/v1beta/models/{{ $json._gem_ai_model }}:generateContent",
            "={{ $json.gemini_ai_detect_request }}",
        ),
        cn(
            "CODE - Parse AI detection payload",
            [2880, 1080],
            r"""const api = $input.first().json;
const base = $('CODE - Timer + PATCH answer payload').first().json;
const text = api?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
let d = { ai_likelihood: 0.5, reason:'parse_fail'};
try{d=JSON.parse(text);}catch(_){}
const lik=Math.max(0,Math.min(1,Number(d.ai_likelihood)||0));
const b=String(base.config.supabase_url||'').replace(/\/+$/,'');
const tb=base.config.table_assessment_questions||'assessment_questions';
const url=`${b}/rest/v1/${tb}?id=eq.${encodeURIComponent(base.open_question.id)}`;
const body={ ai_likelihood:lik, ai_reason:String(d.reason||'').slice(0,2000)};
return[{json:{ ...base,ai_detection:d,_ai_patch_url:url,_ai_patch_body:body}}];""",
        ),
        http(
            "HTTP - SB PATCH question AI fields",
            [3060, 1080],
            "PATCH",
            "={{ $json._ai_patch_url }}",
            "={{ $json._ai_patch_body }}",
            True,
            False,
        ),
        cn(
            "CODE - More questions after phase?",
            [3240, 1080],
            r"""const p=$('CODE - Parse AI detection payload').first().json;
const s=p.session_snapshot;
const cur=Number(s.current_phase||1), max=Number(s.max_phases||5);
return[{json:{...p,_more_remaining: cur < max }}];""",
        ),
        gate("GATE - More phases remain", [3440, 1080], "={{ $('CODE - More questions after phase?').first().json._more_remaining }}", True, "boolean", "equals"),
        cn(
            "Gemini - Next assessment Q (request body)",
            [3680, 880],
            r"""const p=$('CODE - More questions after phase?').first().json;
const model=p.config.gemini_model||'gemini-2.0-flash';
const nextPhase=Number(p.session_snapshot.current_phase||1)+1;
const maxP=Number(p.session_snapshot.max_phases||5);
const sys=`You ask exactly ONE concise technical drill-down for email. Phase ${nextPhase}/${maxP}. Tie to THEIR CV/context; anti-generic. JSON only phase_question`;
const user=`prior_answer:\n${String(p.cleaned_answer||'').slice(0,4000)}\n---\ncv:\n${String(p.session_row.cv_plaintext||'').slice(0,4500)}`;
const body={
  systemInstruction:{role:'system',parts:[{text:sys}]},
  contents:[{role:'user',parts:[{text:user}]}],
  generationConfig:{
    temperature:0.3,
    responseMimeType:'application/json',
    responseSchema:{type:'OBJECT',properties:{phase_question:{type:'STRING'}},required:['phase_question']},
  },
};
return[{json:{...p,_next_phase:nextPhase,_gem_next_model:model,gemini_next_q_request:body}}];""",
        ),
        gh(
            "Gemini - Next assessment Q (API)",
            [3940, 880],
            "=https://generativelanguage.googleapis.com/v1beta/models/{{ $json._gem_next_model }}:generateContent",
            "={{ $json.gemini_next_q_request }}",
        ),
        cn(
            "CODE - Compose follow-up mail + DB rows",
            [4180, 880],
            r"""const api=$input.first().json;
const base=$('Gemini - Next assessment Q (request body)').first().json;
let pq=''; try{ pq=JSON.parse(api?.candidates?.[0]?.content?.parts?.[0]?.text||'{}').phase_question||'';}catch(_){}
pq=String(pq||'').trim(); const iso=new Date().toISOString();
const cfg=base.config,b=String(cfg.supabase_url||'').replace(/\/+$/,'');
return[{
  json:{
    config:cfg,
    candidate_email:base.candidate_email,
    talent_alias: cfg.talent_alias||'',
    phase_1_question:pq,
    session_phase: base._next_phase,
    assessment_status:'IN_PROGRESS',
    score: base.session_snapshot.score ?? base.session_row.score,
    organization_name: cfg.organization_name,
    _sb_q_url:`${b}/rest/v1/${cfg.table_assessment_questions||'assessment_questions'}`,
    _sb_s_url:`${b}/rest/v1/${cfg.table_assessment_sessions||'assessment_sessions'}?id=eq.${encodeURIComponent(String(base.session_snapshot.id))}`,
    _q_insert:{ session_id: base.session_snapshot.id, phase: base._next_phase, question_text: pq, sent_at: iso},
    _sess_patch:{ current_phase: base._next_phase, last_question_sent_at: iso, updated_at: iso, status:'assessment'},
  },
}];""",
        ),
        http(
            "HTTP - SB insert follow-up question row",
            [4400, 880],
            "POST",
            "={{ $('CODE - Compose follow-up mail + DB rows').first().json._sb_q_url }}",
            "={{ $('CODE - Compose follow-up mail + DB rows').first().json._q_insert }}",
            True,
            True,
        ),
        http(
            "HTTP - SB PATCH session after follow-up DB",
            [4620, 880],
            "PATCH",
            "={{ $('CODE - Compose follow-up mail + DB rows').first().json._sb_s_url }}",
            "={{ $('CODE - Compose follow-up mail + DB rows').first().json._sess_patch }}",
            True,
            False,
        ),
        MAIL_FOLLOW,
        cn(
            "CODE - Build availability transition PATCH",
            [3680, 1320],
            r"""const p=$('CODE - More questions after phase?').first().json;
const b=String(p.config.supabase_url||'').replace(/\/+$/,'');
const tbl=p.config.table_assessment_sessions||'assessment_sessions';
const id=p.session_snapshot.id;
const iso=new Date().toISOString();
return[{ json:{ ...p,_avail_url:`${b}/rest/v1/${tbl}?id=eq.${encodeURIComponent(String(id))}`,_avail_body:{status:'availability',updated_at:iso}}}];""",
        ),
        http(
            "HTTP - SB PATCH session awaiting availability",
            [3920, 1320],
            "PATCH",
            "={{ $('CODE - Build availability transition PATCH').first().json._avail_url }}",
            "={{ $('CODE - Build availability transition PATCH').first().json._avail_body }}",
            True,
            False,
        ),
        cn(
            "CODE - Recover context post availability PATCH",
            [4180, 1320],
            r"""return [{ json: $('CODE - Build availability transition PATCH').first().json }];""",
        ),
        cn(
            "CODE - Prep availability from inbound",
            [1320, 1320],
            r"""const p=$('CODE - Pick assessment session row').first().json;
const s=p.session_row||{};
return[{json:{ reply_text:p.reply_text,candidate_email:p.candidate_email,thread_id:p.thread_id,session_row:s,session_snapshot:s,inbound:$('TRG - Gmail candidate reply').first().json,config:p.config}}];""",
        ),
        http(
            "HTTP - SB log unmatched reply",
            [900, 1400],
            "POST",
            "={{ $('CFG - Reply track (merge)').first().json.config.supabase_url.replace(/\\/$/, '') + '/rest/v1/' + $('CFG - Reply track (merge)').first().json.config.table_scheduling }}",
            """={{ ({
  candidate_email: $('CODE - Pick assessment session row').first().json?.candidate_email || '',
  event_id: '',
  status: 'reply_no_matching_session',
}) }}""",
            True,
            True,
        ),
    ]
)

for _nod in NEW:
    if _nod["name"] in ("HTTP - SB fetch assessment session", "HTTP - SB fetch open question"):
        _nod["parameters"].pop("jsonBody", None)
        _nod["parameters"]["sendBody"] = False

wf["nodes"].extend(NEW)
wf["nodes"].append(sticky)
names_seen = {}
for nod in wf["nodes"]:
    if nod["name"] in names_seen:
        raise SystemExit(f"duplicate node name: {nod['name']}")
    names_seen[nod["name"]] = True


C = {
    "TRG - Manual (testing)": {"main": [[{"node": "MUX - Combine manual and webhook", "type": "main", "index": 0}]]},
    "TRG - Webhook CV ingest": {"main": [[{"node": "MUX - Combine manual and webhook", "type": "main", "index": 1}]]},
    "MUX - Combine manual and webhook": {"main": [[{"node": "PDF - Extract text", "type": "main", "index": 0}]]},
    "PDF - Extract text": {"main": [[{"node": "CFG - Workflow configuration", "type": "main", "index": 0}]]},
    "CFG - Workflow configuration": {"main": [[{"node": "DB - Supabase read candidates", "type": "main", "index": 0}]]},
    "DB - Supabase read candidates": {"main": [[{"node": "CODE - Expand CVs and duplicate flag", "type": "main", "index": 0}]]},
    "CODE - Expand CVs and duplicate flag": {"main": [[{"node": "GATE - Not duplicate", "type": "main", "index": 0}]]},
    "GATE - Not duplicate": fork("CODE - CV plain text", "HTTP - SB log duplicate skip"),
    "CODE - CV plain text": {"main": [[{"node": "Gemini - CV screening agent (request body)", "type": "main", "index": 0}]]},
    "Gemini - CV screening agent (request body)": {"main": [[{"node": "Gemini - CV screening agent (API)", "type": "main", "index": 0}]]},
    "Gemini - CV screening agent (API)": {"main": [[{"node": "CODE - Parse CV screening outcome", "type": "main", "index": 0}]]},
    "CODE - Parse CV screening outcome": {"main": [[{"node": "GATE - Screening transport OK", "type": "main", "index": 0}]]},
    "GATE - Screening transport OK": fork("GATE - Initial CV Pass", "HTTP - SB log screening failed"),
    "GATE - Initial CV Pass": fork("MAIL - Email outreach agent (shortlist)", "GATE - Needs human review"),
    "MAIL - Email outreach agent (shortlist)": {"main": [[{"node": "CODE - Merge Gmail send response", "type": "main", "index": 0}]]},
    "CODE - Merge Gmail send response": {"main": [[{"node": "CODE - SB URLs after outreach mail", "type": "main", "index": 0}]]},
    "CODE - SB URLs after outreach mail": {"main": [[{"node": "HTTP - SB candidates shortlisted", "type": "main", "index": 0}]]},
    "HTTP - SB candidates shortlisted": {"main": [[{"node": "CODE - SB prepare session insert", "type": "main", "index": 0}]]},
    "CODE - SB prepare session insert": {"main": [[{"node": "HTTP - SB insert assessment session", "type": "main", "index": 0}]]},
    "HTTP - SB insert assessment session": {"main": [[{"node": "CODE - SB map session id for Q1", "type": "main", "index": 0}]]},
    "CODE - SB map session id for Q1": {"main": [[{"node": "HTTP - SB insert question phase 1", "type": "main", "index": 0}]]},
    "GATE - Needs human review": fork("HTTP - SB log review queue", "HTTP - SB log rejected"),
    # Gmail branch
    "TRG - Gmail candidate reply": {"main": [[{"node": "CFG - Reply track (merge)", "type": "main", "index": 0}]]},
    "CFG - Reply track (merge)": {"main": [[{"node": "CODE - Inbound Gmail normalize", "type": "main", "index": 0}]]},
    "CODE - Inbound Gmail normalize": {"main": [[{"node": "HTTP - SB fetch assessment session", "type": "main", "index": 0}]]},
    "HTTP - SB fetch assessment session": {"main": [[{"node": "CODE - Pick assessment session row", "type": "main", "index": 0}]]},
    "CODE - Pick assessment session row": {"main": [[{"node": "GATE - Assessment session found", "type": "main", "index": 0}]]},
    "GATE - Assessment session found": fork("GATE - Session in assessment status", "HTTP - SB log unmatched reply"),
    "GATE - Session in assessment status": fork("CODE - Prep open question URL", "CODE - Prep availability from inbound"),
    "CODE - Prep open question URL": {"main": [[{"node": "HTTP - SB fetch open question", "type": "main", "index": 0}]]},
    "HTTP - SB fetch open question": {"main": [[{"node": "CODE - Attach open question row", "type": "main", "index": 0}]]},
    "CODE - Attach open question row": {"main": [[{"node": "GATE - Has open question", "type": "main", "index": 0}]]},
    "GATE - Has open question": fork("CODE - Timer + PATCH answer payload", "CODE - Prep availability from inbound"),
    "CODE - Timer + PATCH answer payload": {"main": [[{"node": "HTTP - SB PATCH question answer", "type": "main", "index": 0}]]},
    "HTTP - SB PATCH question answer": {"main": [[{"node": "Gemini - AI Detection (request body)", "type": "main", "index": 0}]]},
    "Gemini - AI Detection (request body)": {"main": [[{"node": "Gemini - AI Detection (API)", "type": "main", "index": 0}]]},
    "Gemini - AI Detection (API)": {"main": [[{"node": "CODE - Parse AI detection payload", "type": "main", "index": 0}]]},
    "CODE - Parse AI detection payload": {"main": [[{"node": "HTTP - SB PATCH question AI fields", "type": "main", "index": 0}]]},
    "HTTP - SB PATCH question AI fields": {"main": [[{"node": "CODE - More questions after phase?", "type": "main", "index": 0}]]},
    "CODE - More questions after phase?": {"main": [[{"node": "GATE - More phases remain", "type": "main", "index": 0}]]},
    "GATE - More phases remain": fork("Gemini - Next assessment Q (request body)", "CODE - Build availability transition PATCH"),
    "Gemini - Next assessment Q (request body)": {"main": [[{"node": "Gemini - Next assessment Q (API)", "type": "main", "index": 0}]]},
    "Gemini - Next assessment Q (API)": {"main": [[{"node": "CODE - Compose follow-up mail + DB rows", "type": "main", "index": 0}]]},
    "CODE - Compose follow-up mail + DB rows": {"main": [[{"node": "HTTP - SB insert follow-up question row", "type": "main", "index": 0}]]},
    "HTTP - SB insert follow-up question row": {"main": [[{"node": "HTTP - SB PATCH session after follow-up DB", "type": "main", "index": 0}]]},
    "HTTP - SB PATCH session after follow-up DB": {"main": [[{"node": "MAIL - Assessment follow-up question", "type": "main", "index": 0}]]},
    "CODE - Build availability transition PATCH": {"main": [[{"node": "HTTP - SB PATCH session awaiting availability", "type": "main", "index": 0}]]},
    "HTTP - SB PATCH session awaiting availability": {"main": [[{"node": "CODE - Recover context post availability PATCH", "type": "main", "index": 0}]]},
    "CODE - Recover context post availability PATCH": {"main": [[{"node": "Gemini - Availability agent (request body)", "type": "main", "index": 0}]]},
    "CODE - Prep availability from inbound": {"main": [[{"node": "Gemini - Availability agent (request body)", "type": "main", "index": 0}]]},
}


KEEP_AVAIL_BRANCH = (
    "Gemini - Availability agent (request body)",
    "Gemini - Availability agent (API)",
    "CODE - Normalize availability",
    "MAIL - Interviewer coordination agent",
    "WAIT - Interviewer availability webhook",
    "Gemini - Smart matching agent (request body)",
    "Gemini - Smart matching agent (API)",
    "CODE - Matching result",
    "Gemini - Interview briefing agent (request body)",
    "Gemini - Interview briefing agent (API)",
    "CAL - Create interview event",
    "MAIL - Notify candidate",
    "MAIL - Notify interviewer",
)

for k in KEEP_AVAIL_BRANCH:
    if k in ORIG_CONN:
        C[k] = ORIG_CONN[k]

C["GATE - Match resolved (no conflict)"] = fork(
    "Gemini - Interview briefing agent (request body)",
    "HTTP - SB scheduling conflict log",
)

more_skip = SKIP_CONN_KEYS.copy()
more_skip.update(
    {
        "DB - Sheets read pending replies",
        "CODE - Resolve reply and context",
        "GATE - Pending context found",
        "CODE - Timer Calculation",
        "Gemini - AI Detection (request)",
        "DB - Supabase Lookup Candidate",
    }
)

for k, v in ORIG_CONN.items():
    if k.startswith("DB - Sheets"):
        continue
    if k in more_skip:
        continue
    if k in SKIP_CONN_KEYS:
        continue
    if k in C:
        continue
    C[k] = v

C["MAIL - Notify interviewer"] = {"main": [[{"node": "HTTP - SB scheduling success log", "type": "main", "index": 0}]]}
C["TRG - Error workflow"] = {"main": [[{"node": "HTTP - SB workflow error log", "type": "main", "index": 0}]]}

wf["connections"] = C

_path.write_text(json.dumps(wf, indent=2, ensure_ascii=False), encoding="utf-8")
print("Wrote migration to", _path)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function readJs(name) {
  return fs.readFileSync(path.join(root, name), 'utf8').trim();
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (v) => (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Fix uuid bug
function id() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function codeNode(name, jsFile, position) {
  return {
    parameters: { jsCode: readJs(jsFile) },
    id: id(),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function httpPatch(name, urlExpr, bodyExpr, keyExpr, position) {
  return {
    parameters: {
      method: 'PATCH',
      url: urlExpr,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'apikey', value: keyExpr },
          { name: 'Authorization', value: `=Bearer {{ $('CFG - Assessment Config').first().json.supabase_key }}` },
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Prefer', value: 'return=minimal' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: bodyExpr,
      options: {},
    },
    id: id(),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    onError: 'continueRegularOutput',
  };
}

function gmailThreadReply(name, position) {
  return {
    parameters: {
      resource: 'thread',
      operation: 'reply',
      threadId: '={{ $json.gmail_thread_id }}',
      messageId: '={{ $json.gmail_message_id }}',
      emailType: 'html',
      message: '={{ $json.mail_body_html }}',
      options: {},
    },
    id: id(),
    name,
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position,
    credentials: {
      gmailOAuth2: { id: 'BA2SGIRvrMkcdHoQ', name: 'Gmail account' },
    },
  };
}

function gmailInterviewerReply(name, position) {
  return {
    parameters: {
      resource: 'thread',
      operation: 'reply',
      threadId: '={{ $json.interviewer_gmail_thread_id }}',
      messageId: '={{ $json.interviewer_gmail_message_id }}',
      emailType: 'html',
      message: '={{ $json.mail_body_html }}',
      options: {},
    },
    id: id(),
    name,
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position,
    credentials: {
      gmailOAuth2: { id: 'BA2SGIRvrMkcdHoQ', name: 'Gmail account' },
    },
  };
}

function gmailSend(name, toExpr, subjectExpr, position, messageExpr) {
  return {
    parameters: {
      sendTo: toExpr,
      subject: subjectExpr,
      emailType: 'html',
      message:
        messageExpr ||
        "={{ (() => { const ru = String($execution.resumeUrl || '').trim(); if (!ru) throw new Error('resumeUrl empty — MAIL must wire directly to WAIT'); return $json.mail_body_html.split('{{RESUME_URL}}').join(encodeURIComponent(ru)); })() }}",
      options: {},
    },
    id: id(),
    name,
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position,
    credentials: {
      gmailOAuth2: { id: 'BA2SGIRvrMkcdHoQ', name: 'Gmail account' },
    },
  };
}

const old = readJson('Talent Acquisition — Assessment + Scheduling.json');
const cfgNode = JSON.parse(JSON.stringify(old.nodes.find((n) => n.name === 'CFG - Assessment Config')));
const normNode = old.nodes.find((n) => n.name === 'CODE - Normalize Data');

cfgNode.parameters.assignments.assignments.push(
  { id: 'cfg-cal', name: 'calendar_id', value: 'primary', type: 'string' },
  {
    id: 'cfg-n8n',
    name: 'n8n_public_url',
    value: 'https://randy-gaunt-bradley.ngrok-free.dev',
    type: 'string',
  },
  {
    id: 'cfg-portal',
    name: 'portal_base_url',
    value: 'https://talent-acquisition-six.vercel.app',
    type: 'string',
  }
);

const KEY = "={{ $('CFG - Assessment Config').first().json.supabase_key }}";

const nodes = [
  old.nodes.find((n) => n.name === 'TRG - Assessment Answer'),
  cfgNode,
  normNode,
  {
    ...old.nodes.find((n) => n.name === 'HTTP - Fetch Session'),
    name: 'HTTP - Fetch Session',
    position: [928, 1200],
  },
  codeNode('CODE - Build LLM context', 'n8n_code_build_llm_context.js', [1152, 1200]),
  {
    parameters: {
      promptType: 'define',
      text: '={{ $json.prompt }}',
      hasOutputParser: false,
    },
    id: id(),
    name: 'Basic LLM Chain',
    type: '@n8n/n8n-nodes-langchain.chainLlm',
    typeVersion: 1.6,
    position: [1376, 1200],
  },
  {
    parameters: {
      projectId: { __rl: true, mode: 'id', value: '={{ $env.GOOGLE_CLOUD_PROJECT }}' },
      modelName: 'gemini-2.0-flash-001',
      options: { temperature: 0.2 },
    },
    id: id(),
    name: 'Google Vertex Chat Model',
    type: '@n8n/n8n-nodes-langchain.lmChatGoogleVertex',
    typeVersion: 1,
    position: [1376, 1400],
    credentials: {
      googleApi: { id: 'GOOGLE_VERTEX_CREDENTIAL_ID', name: 'Google Vertex account' },
    },
  },
  codeNode('CODE - Parse Result', 'n8n_code_parse_assessment_result.js', [1600, 1200]),
  httpPatch(
    'HTTP - SB PATCH session interview_history',
    "={{ $('CODE - Parse Result').first().json._session_patch_url }}",
    "={{ $('CODE - Parse Result').first().json._session_patch_body }}",
    KEY,
    [1824, 1200]
  ),
  {
    ...old.nodes.find((n) => n.name === 'Respond to Portal'),
    position: [2048, 1080],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'final-check',
            leftValue: "={{ $('CODE - Parse Result').first().json.isFinal }}",
            rightValue: true,
            operator: { type: 'boolean', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: id(),
    name: 'IF - Assessment finished?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [2048, 1320],
  },
  codeNode('CODE - Build assessment result mail', 'n8n_code_build_assessment_result_mail.js', [2288, 1320]),
  gmailThreadReply('MAIL - Reply candidate (assessment result)', [2512, 1320]),
  codeNode('CODE - Merge Gmail reply response (result)', 'n8n_code_merge_gmail_reply_response.js', [2736, 1320]),
  httpPatch(
    'HTTP - PATCH candidate gmail (result)',
    '={{ $json._gmail_patch_url }}',
    '={{ $json._gmail_patch_body }}',
    KEY,
    [2960, 1320]
  ),
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'pass-check',
            leftValue: "={{ $('CODE - Parse Result').first().json.result }}",
            rightValue: 'PASS',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: id(),
    name: 'IF - Result PASS?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [3184, 1320],
  },
  codeNode('CODE - Prep scheduling from PASS', 'n8n_code_prep_scheduling_from_pass.js', [3408, 1240]),
  codeNode('CODE - Build interviewer mail context', 'n8n_code_build_interviewer_mail_context.js', [3632, 1240]),
  gmailSend(
    'MAIL - Interviewer pitch mail',
    '={{ $json.interviewer_email }}',
    '={{ $json.mail_subject }}',
    [3856, 1240],
    "={{ (() => { let u = String($execution.resumeUrl || '').trim(); let b = String($json.config?.n8n_public_url || $json._debug_public_base || '').replace(/\\/+$/, ''); if (!b || /YOUR-NGROK/i.test(b)) b = 'https://randy-gaunt-bradley.ngrok-free.dev'; if (b && /localhost|127\\.0\\.0\\.1/i.test(u)) u = u.replace(/^https?:\\/\\/[^/]+/i, b); if (!u) throw new Error('resumeUrl empty — MAIL must wire directly to WAIT'); return $json.mail_body_html.split($json.resume_url).join(encodeURIComponent(u)); })() }}"
  ),
  codeNode('CODE - Merge Gmail interviewer send', 'n8n_code_merge_gmail_interviewer_response.js', [4080, 1240]),
  httpPatch(
    'HTTP - PATCH interviewer thread (pitch)',
    '={{ $json._interviewer_patch_url }}',
    '={{ $json._interviewer_patch_body }}',
    KEY,
    [4304, 1240]
  ),
  {
    parameters: {
      resume: 'webhook',
      options: { webhookSuffix: 'interviewer-availability' },
    },
    id: id(),
    name: 'WAIT - Interviewer availability',
    type: 'n8n-nodes-base.wait',
    typeVersion: 1.1,
    position: [4528, 1240],
    webhookId: 'interviewer-availability-wait',
  },
  codeNode('CODE - Parse interviewer slot', 'n8n_code_parse_interviewer_slot.js', [4752, 1240]),
  codeNode('CODE - Build candidate slot mail', 'n8n_code_build_candidate_slot_mail.js', [4976, 1240]),
  gmailThreadReply('MAIL - Candidate pitch mail', [5200, 1240]),
  codeNode('CODE - Merge Gmail reply response (scheduling)', 'n8n_code_merge_gmail_reply_response.js', [5424, 1240]),
  httpPatch(
    'HTTP - PATCH candidate gmail (scheduling)',
    '={{ $json._gmail_patch_url }}',
    '={{ $json._gmail_patch_body }}',
    KEY,
    [5648, 1240]
  ),
  {
    parameters: {
      resume: 'webhook',
      options: { webhookSuffix: 'candidate-slot-choice' },
    },
    id: id(),
    name: 'WAIT - Candidate slot choice',
    type: 'n8n-nodes-base.wait',
    typeVersion: 1.1,
    position: [5872, 1240],
    webhookId: 'candidate-slot-choice-wait',
  },
  codeNode('CODE - Parse candidate choice', 'n8n_code_parse_candidate_choice.js', [6096, 1240]),
  {
    parameters: {
      calendar: { __rl: true, value: "={{ $json.config.calendar_id || 'primary' }}", mode: 'list', cachedResultName: 'primary' },
      start: '={{ $json.start_iso || $now.toISO() }}',
      end: '={{ $json.end_iso || $now.plus({ hours: 1 }).toISO() }}',
      additionalFields: {
        attendees:
          '={{ [$json.candidate_email, $json.interviewer_email || $json.config.interviewer_email].filter(Boolean) }}',
        summary: '=Interview — {{ $json.candidate_email }} ({{ $json.config.requisition_title || "Role" }})',
      },
    },
    id: id(),
    name: 'CAL - Create interview event',
    type: 'n8n-nodes-base.googleCalendar',
    typeVersion: 1.3,
    position: [6320, 1240],
    credentials: {
      googleCalendarOAuth2Api: { id: 'GOOGLE_CALENDAR_CREDENTIAL_ID', name: 'Google Calendar account' },
    },
  },
  codeNode('CODE - Build interview confirmed mail', 'n8n_code_build_interview_confirmed_mail.js', [6544, 1120]),
  gmailThreadReply('MAIL - Notify candidate', [6768, 1120]),
  codeNode('CODE - Merge Gmail reply response (confirmed)', 'n8n_code_merge_gmail_reply_response.js', [6992, 1120]),
  httpPatch(
    'HTTP - PATCH candidate gmail (confirmed)',
    '={{ $json._gmail_patch_url }}',
    '={{ $json._gmail_patch_body }}',
    KEY,
    [7216, 1120]
  ),
  codeNode('CODE - Build interviewer confirmed mail', 'n8n_code_build_interviewer_confirmed_mail.js', [6544, 1360]),
  gmailInterviewerReply('MAIL - Notify interviewer', [6768, 1360]),
  codeNode('CODE - Merge Gmail interviewer reply (confirmed)', 'n8n_code_merge_gmail_interviewer_response.js', [6992, 1360]),
  httpPatch(
    'HTTP - PATCH interviewer thread (confirmed)',
    '={{ $json._interviewer_patch_url }}',
    '={{ $json._interviewer_patch_body }}',
    KEY,
    [7216, 1360]
  ),
  httpPatch(
    'HTTP - SB scheduling concluding',
    "={{ $('CFG - Assessment Config').first().json.supabase_url.replace(/\\/$/, '') + '/rest/v1/assessment_sessions?id=eq.' + encodeURIComponent($('CODE - Parse candidate choice').first().json.session_id) }}",
    "={{ ({ status: 'scheduled', updated_at: new Date().toISOString() }) }}",
    KEY,
    [7440, 1240]
  ),
];

const connections = {
  'TRG - Assessment Answer': { main: [[{ node: 'CFG - Assessment Config', type: 'main', index: 0 }]] },
  'CFG - Assessment Config': { main: [[{ node: 'CODE - Normalize Data', type: 'main', index: 0 }]] },
  'CODE - Normalize Data': { main: [[{ node: 'HTTP - Fetch Session', type: 'main', index: 0 }]] },
  'HTTP - Fetch Session': { main: [[{ node: 'CODE - Build LLM context', type: 'main', index: 0 }]] },
  'CODE - Build LLM context': { main: [[{ node: 'Basic LLM Chain', type: 'main', index: 0 }]] },
  'Basic LLM Chain': { main: [[{ node: 'CODE - Parse Result', type: 'main', index: 0 }]] },
  'Google Vertex Chat Model': {
    ai_languageModel: [[{ node: 'Basic LLM Chain', type: 'ai_languageModel', index: 0 }]],
  },
  'CODE - Parse Result': {
    main: [[{ node: 'HTTP - SB PATCH session interview_history', type: 'main', index: 0 }]],
  },
  'HTTP - SB PATCH session interview_history': {
    main: [
      [
        { node: 'Respond to Portal', type: 'main', index: 0 },
        { node: 'IF - Assessment finished?', type: 'main', index: 0 },
      ],
    ],
  },
  'IF - Assessment finished?': {
    main: [
      [{ node: 'CODE - Build assessment result mail', type: 'main', index: 0 }],
      [],
    ],
  },
  'CODE - Build assessment result mail': {
    main: [[{ node: 'MAIL - Reply candidate (assessment result)', type: 'main', index: 0 }]],
  },
  'MAIL - Reply candidate (assessment result)': {
    main: [[{ node: 'CODE - Merge Gmail reply response (result)', type: 'main', index: 0 }]],
  },
  'CODE - Merge Gmail reply response (result)': {
    main: [[{ node: 'HTTP - PATCH candidate gmail (result)', type: 'main', index: 0 }]],
  },
  'HTTP - PATCH candidate gmail (result)': {
    main: [[{ node: 'IF - Result PASS?', type: 'main', index: 0 }]],
  },
  'IF - Result PASS?': {
    main: [[{ node: 'CODE - Prep scheduling from PASS', type: 'main', index: 0 }], []],
  },
  'CODE - Prep scheduling from PASS': {
    main: [[{ node: 'CODE - Build interviewer mail context', type: 'main', index: 0 }]],
  },
  'CODE - Build interviewer mail context': {
    main: [[{ node: 'MAIL - Interviewer pitch mail', type: 'main', index: 0 }]],
  },
  'MAIL - Interviewer pitch mail': {
    main: [[{ node: 'WAIT - Interviewer availability', type: 'main', index: 0 }]],
  },
  'WAIT - Interviewer availability': {
    main: [[{ node: 'CODE - Parse interviewer slot', type: 'main', index: 0 }]],
  },
  'CODE - Parse interviewer slot': {
    main: [[{ node: 'CODE - Merge Gmail interviewer send', type: 'main', index: 0 }]],
  },
  'CODE - Merge Gmail interviewer send': {
    main: [[{ node: 'HTTP - PATCH interviewer thread (pitch)', type: 'main', index: 0 }]],
  },
  'HTTP - PATCH interviewer thread (pitch)': {
    main: [[{ node: 'CODE - Build candidate slot mail', type: 'main', index: 0 }]],
  },
  'CODE - Build candidate slot mail': {
    main: [[{ node: 'MAIL - Candidate pitch mail', type: 'main', index: 0 }]],
  },
  'MAIL - Candidate pitch mail': {
    main: [[{ node: 'WAIT - Candidate slot choice', type: 'main', index: 0 }]],
  },
  'WAIT - Candidate slot choice': {
    main: [[{ node: 'CODE - Parse candidate choice', type: 'main', index: 0 }]],
  },
  'CODE - Parse candidate choice': {
    main: [[{ node: 'CODE - Merge Gmail reply response (scheduling)', type: 'main', index: 0 }]],
  },
  'CODE - Merge Gmail reply response (scheduling)': {
    main: [[{ node: 'HTTP - PATCH candidate gmail (scheduling)', type: 'main', index: 0 }]],
  },
  'HTTP - PATCH candidate gmail (scheduling)': {
    main: [[{ node: 'CAL - Create interview event', type: 'main', index: 0 }]],
  },
  'CAL - Create interview event': {
    main: [
      [
        { node: 'CODE - Build interview confirmed mail', type: 'main', index: 0 },
        { node: 'CODE - Build interviewer confirmed mail', type: 'main', index: 0 },
      ],
    ],
  },
  'CODE - Build interview confirmed mail': {
    main: [[{ node: 'MAIL - Notify candidate', type: 'main', index: 0 }]],
  },
  'MAIL - Notify candidate': {
    main: [[{ node: 'CODE - Merge Gmail reply response (confirmed)', type: 'main', index: 0 }]],
  },
  'CODE - Merge Gmail reply response (confirmed)': {
    main: [[{ node: 'HTTP - PATCH candidate gmail (confirmed)', type: 'main', index: 0 }]],
  },
  'HTTP - PATCH candidate gmail (confirmed)': {
    main: [[{ node: 'HTTP - SB scheduling concluding', type: 'main', index: 0 }]],
  },
  'CODE - Build interviewer confirmed mail': {
    main: [[{ node: 'MAIL - Notify interviewer', type: 'main', index: 0 }]],
  },
  'MAIL - Notify interviewer': {
    main: [[{ node: 'CODE - Merge Gmail interviewer reply (confirmed)', type: 'main', index: 0 }]],
  },
  'CODE - Merge Gmail interviewer reply (confirmed)': {
    main: [[{ node: 'HTTP - PATCH interviewer thread (confirmed)', type: 'main', index: 0 }]],
  },
};

const workflow = {
  name: 'Talent Acquisition — Assessment + Scheduling (Threaded Mail)',
  nodes,
  connections,
  pinData: {},
  active: false,
  settings: { executionOrder: 'v1' },
  meta: {
    templateCredsSetupCompleted: true,
    description:
      'Assessment Q1–Q5 with Vertex. Candidate mails = one Gmail thread (reply). Interviewer mails = separate thread. Import, set credentials, activate.',
  },
  tags: [],
};

const outPath = path.join(
  root,
  'Talent Acquisition — Assessment + Scheduling (Threaded Mail).json'
);
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log('Written:', outPath);
console.log('Nodes:', nodes.length);

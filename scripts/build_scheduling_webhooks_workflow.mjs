import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function readJs(name) {
  return fs.readFileSync(path.join(root, name), 'utf8').trim();
}

function id() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function cfgNode(name, position) {
  return {
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'sb',
            name: 'supabase_url',
            value: 'https://vnxstyadacgntnsvcvzn.supabase.co',
            type: 'string',
          },
          {
            id: 'key',
            name: 'supabase_key',
            value: '={{ $env.SUPABASE_SERVICE_ROLE_KEY }}',
            type: 'string',
          },
          {
            id: 'portal',
            name: 'portal_base_url',
            value: 'https://talent-acquisition-six.vercel.app',
            type: 'string',
          },
          {
            id: 'cal',
            name: 'calendar_id',
            value: 'primary',
            type: 'string',
          },
        ],
      },
      options: {},
    },
    id: id(),
    name,
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position,
  };
}

function codeNode(name, file, position) {
  return {
    parameters: { jsCode: readJs(file) },
    id: id(),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function httpGetSession(name, normalizeNode, cfgNode, position) {
  return {
    parameters: {
      url: `={{ $('${cfgNode}').first().json.supabase_url.replace(/\\/$/, '') }}/rest/v1/assessment_sessions?id=eq.{{ $('${normalizeNode}').first().json.session_id }}&select=*`,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'apikey', value: `={{ $('${cfgNode}').first().json.supabase_key }}` },
          { name: 'Authorization', value: `=Bearer {{ $('${cfgNode}').first().json.supabase_key }}` },
        ],
      },
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

function httpPatchSession(name, bodyExpr, cfgNode, sessionExpr, position) {
  return {
    parameters: {
      method: 'PATCH',
      url: `={{ $('${cfgNode}').first().json.supabase_url.replace(/\\/$/, '') }}/rest/v1/assessment_sessions?id=eq.{{ ${sessionExpr} }}`,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'apikey', value: `={{ $('${cfgNode}').first().json.supabase_key }}` },
          { name: 'Authorization', value: `=Bearer {{ $('${cfgNode}').first().json.supabase_key }}` },
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

const nodes = [
  {
    parameters: {
      httpMethod: 'POST',
      path: 'talent/scheduling-slots',
      responseMode: 'onReceived',
      options: {},
    },
    id: id(),
    name: 'TRG - Webhook scheduling slots',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [240, 280],
    webhookId: id(),
  },
  {
    parameters: {
      httpMethod: 'POST',
      path: 'talent/scheduling-confirmed',
      responseMode: 'onReceived',
      options: {},
    },
    id: id(),
    name: 'TRG - Webhook scheduling confirmed',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [240, 720],
    webhookId: id(),
  },
  cfgNode('CFG - Scheduling (slots)', [720, 280]),
  cfgNode('CFG - Scheduling (confirmed)', [720, 720]),
  codeNode('CODE - Scheduling normalize (slots)', 'n8n_code_scheduling_webhook_normalize.js', [480, 280]),
  codeNode('CODE - Scheduling normalize (confirmed)', 'n8n_code_scheduling_webhook_normalize.js', [480, 720]),
  httpGetSession(
    'HTTP - SB GET session (slots)',
    'CODE - Scheduling normalize (slots)',
    'CFG - Scheduling (slots)',
    [960, 280]
  ),
  httpGetSession(
    'HTTP - SB GET session (confirmed)',
    'CODE - Scheduling normalize (confirmed)',
    'CFG - Scheduling (confirmed)',
    [960, 720]
  ),
  codeNode('CODE - Build candidate slot mail', 'n8n_code_build_candidate_slot_mail.js', [1200, 280]),
  {
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
    name: 'MAIL - Candidate slot options',
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position: [1440, 280],
    credentials: {
      gmailOAuth2: { id: 'BA2SGIRvrMkcdHoQ', name: 'Gmail account' },
    },
  },
  codeNode('CODE - Merge Gmail reply (slots)', 'n8n_code_merge_gmail_reply_response.js', [1680, 280]),
  httpPatchSession(
    'HTTP - PATCH scheduling candidate_invited',
    "={{ { scheduling_status: 'candidate_invited', scheduling_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() } }}",
    'CFG - Scheduling (slots)',
    "$json.session_id || $('CODE - Scheduling normalize (slots)').first().json.session_id",
    [1920, 280]
  ),
  codeNode('CODE - Scheduling confirmed from session', 'n8n_code_scheduling_confirmed_from_session.js', [1200, 720]),
  {
    parameters: {
      calendar: {
        __rl: true,
        value: "={{ $json.config.calendar_id || 'primary' }}",
        mode: 'list',
        cachedResultName: 'primary',
      },
      start: '={{ $json.start_iso }}',
      end: '={{ $json.end_iso || $now.plus({ hours: 1 }).toISO() }}',
      additionalFields: {
        attendees:
          '={{ [$json.candidate_email, $json.interviewer_email || $json.config.interviewer_email].filter(Boolean) }}',
        summary:
          '=Interview — {{ $json.candidate_email }} ({{ $json.config.requisition_title || "Role" }})',
      },
    },
    id: id(),
    name: 'CAL - Create interview event',
    type: 'n8n-nodes-base.googleCalendar',
    typeVersion: 1.3,
    position: [1440, 720],
    credentials: {
      googleCalendarOAuth2Api: {
        id: 'GOOGLE_CALENDAR_CREDENTIAL_ID',
        name: 'Google Calendar account',
      },
    },
    onError: 'continueRegularOutput',
  },
  codeNode('CODE - Build interview confirmed mail', 'n8n_code_build_interview_confirmed_mail.js', [1680, 640]),
  codeNode('CODE - Build interviewer confirmed mail', 'n8n_code_build_interviewer_confirmed_mail.js', [1680, 800]),
  {
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
    name: 'MAIL - Notify candidate confirmed',
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position: [1920, 640],
    credentials: {
      gmailOAuth2: { id: 'BA2SGIRvrMkcdHoQ', name: 'Gmail account' },
    },
  },
  {
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
    name: 'MAIL - Notify interviewer confirmed',
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position: [1920, 800],
    credentials: {
      gmailOAuth2: { id: 'BA2SGIRvrMkcdHoQ', name: 'Gmail account' },
    },
  },
  httpPatchSession(
    'HTTP - PATCH scheduling done',
    "={{ { scheduling_status: 'done', scheduling_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() } }}",
    'CFG - Scheduling (confirmed)',
    "$json.session_id || $('CODE - Scheduling normalize (confirmed)').first().json.session_id",
    [2160, 720]
  ),
];

const connections = {
  'TRG - Webhook scheduling slots': {
    main: [[{ node: 'CODE - Scheduling normalize (slots)', type: 'main', index: 0 }]],
  },
  'TRG - Webhook scheduling confirmed': {
    main: [[{ node: 'CODE - Scheduling normalize (confirmed)', type: 'main', index: 0 }]],
  },
  'CODE - Scheduling normalize (slots)': {
    main: [[{ node: 'CFG - Scheduling (slots)', type: 'main', index: 0 }]],
  },
  'CODE - Scheduling normalize (confirmed)': {
    main: [[{ node: 'CFG - Scheduling (confirmed)', type: 'main', index: 0 }]],
  },
  'CFG - Scheduling (slots)': {
    main: [[{ node: 'HTTP - SB GET session (slots)', type: 'main', index: 0 }]],
  },
  'CFG - Scheduling (confirmed)': {
    main: [[{ node: 'HTTP - SB GET session (confirmed)', type: 'main', index: 0 }]],
  },
  'HTTP - SB GET session (slots)': {
    main: [[{ node: 'CODE - Build candidate slot mail', type: 'main', index: 0 }]],
  },
  'HTTP - SB GET session (confirmed)': {
    main: [[{ node: 'CODE - Scheduling confirmed from session', type: 'main', index: 0 }]],
  },
  'CODE - Build candidate slot mail': {
    main: [[{ node: 'MAIL - Candidate slot options', type: 'main', index: 0 }]],
  },
  'MAIL - Candidate slot options': {
    main: [[{ node: 'CODE - Merge Gmail reply (slots)', type: 'main', index: 0 }]],
  },
  'CODE - Merge Gmail reply (slots)': {
    main: [[{ node: 'HTTP - PATCH scheduling candidate_invited', type: 'main', index: 0 }]],
  },
  'CODE - Scheduling confirmed from session': {
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
    main: [[{ node: 'MAIL - Notify candidate confirmed', type: 'main', index: 0 }]],
  },
  'CODE - Build interviewer confirmed mail': {
    main: [[{ node: 'MAIL - Notify interviewer confirmed', type: 'main', index: 0 }]],
  },
  'MAIL - Notify candidate confirmed': {
    main: [[{ node: 'HTTP - PATCH scheduling done', type: 'main', index: 0 }]],
  },
  'MAIL - Notify interviewer confirmed': {
    main: [[]],
  },
};

const workflow = {
  name: 'Talent Acquisition — Scheduling Webhooks',
  nodes,
  connections,
  pinData: {},
  active: false,
  settings: { executionOrder: 'v1' },
  meta: {
    templateCredsSetupCompleted: true,
    description:
      'Frontend-driven scheduling: POST talent/scheduling-slots and talent/scheduling-confirmed with { session_id }. No WAIT nodes.',
  },
  tags: [],
};

const out = path.join(root, 'Talent Acquisition — Scheduling Webhooks.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2), 'utf8');
console.log('Written', out);

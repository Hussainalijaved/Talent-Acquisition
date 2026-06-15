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

function httpPatch(name, urlExpr, bodyExpr, position) {
  return {
    parameters: {
      method: 'PATCH',
      url: urlExpr,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'apikey', value: "={{ $('CFG - Assessment Config').first().json.supabase_key }}" },
          {
            name: 'Authorization',
            value: "=Bearer {{ $('CFG - Assessment Config').first().json.supabase_key }}",
          },
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
        "={{ (() => { let u = String($execution.resumeUrl || '').trim(); let b = String($json.config?.n8n_public_url || '').replace(/\\/+$/, ''); if (b && /localhost|127\\.0\\.0\\.1/i.test(u)) u = u.replace(/^https?:\\/\\/[^/]+/i, b); if (!u) throw new Error('resumeUrl empty'); return $json.mail_body_html.split($json.resume_url).join(encodeURIComponent(u)); })() }}",
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

const old = readJson('Talent Acquisition — Assessment + Scheduling (Threaded Mail).json');
const cfgNode = JSON.parse(JSON.stringify(old.nodes.find((n) => n.name === 'CFG - Assessment Config')));

cfgNode.parameters.assignments.assignments.push(
  { id: 'sp-en', name: 'speech_enabled', value: true, type: 'boolean' },
  { id: 'sp-ph', name: 'speech_phases', value: 3, type: 'number' },
  { id: 'sp-tw', name: 'technical_weight', value: 0.7, type: 'number' },
  { id: 'sp-sw', name: 'speech_weight', value: 0.3, type: 'number' },
  { id: 'a_groq_key', name: 'groq_api_key', value: '={{ $env.GROQ_API_KEY }}', type: 'string' }
);

const KEY = "={{ $('CFG - Assessment Config').first().json.supabase_key }}";
const PICK = '$("CODE - Pick Parse Result").first().json';

const nodes = [
  old.nodes.find((n) => n.name === 'TRG - Assessment Answer'),
  cfgNode,
  codeNode('CODE - Normalize Data', 'n8n_code_normalize_assessment.js', [704, 1888]),
  {
    ...old.nodes.find((n) => n.name === 'HTTP - Fetch Session'),
    position: [928, 1888],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'speech-mode',
            leftValue:
              "={{ $('CODE - Normalize Data').first().json.assessment_mode === 'speech' || (Array.isArray($json) ? $json[0].assessment_stage : $json.assessment_stage) === 'speech' }}",
            rightValue: true,
            operator: { type: 'boolean', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: id(),
    name: 'IF - Speech mode?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [1152, 1888],
  },
  // Technical branch (top)
  codeNode('CODE - Build LLM context', 'n8n_code_build_llm_context.js', [1376, 1680]),
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
    position: [1600, 1680],
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
    position: [1600, 1880],
    credentials: {
      googleApi: { id: 'GOOGLE_VERTEX_CREDENTIAL_ID', name: 'Google Vertex account' },
    },
  },
  codeNode('CODE - Parse Technical Result', 'n8n_code_parse_technical_result.js', [1824, 1680]),
  // Speech branch (bottom)
  codeNode('CODE - Build Speech LLM context', 'n8n_code_build_speech_llm_context.js', [1376, 2080]),
  {
    parameters: {
      promptType: 'define',
      text: '={{ $json.prompt }}',
      hasOutputParser: false,
    },
    id: id(),
    name: 'Basic LLM Chain Speech',
    type: '@n8n/n8n-nodes-langchain.chainLlm',
    typeVersion: 1.6,
    position: [1600, 2080],
  },
  {
    parameters: {
      projectId: { __rl: true, mode: 'id', value: '={{ $env.GOOGLE_CLOUD_PROJECT }}' },
      modelName: 'gemini-2.0-flash-001',
      options: { temperature: 0.2 },
    },
    id: id(),
    name: 'Google Vertex Chat Model Speech',
    type: '@n8n/n8n-nodes-langchain.lmChatGoogleVertex',
    typeVersion: 1,
    position: [1600, 2280],
    credentials: {
      googleApi: { id: 'GOOGLE_VERTEX_CREDENTIAL_ID', name: 'Google Vertex account' },
    },
  },
  codeNode('CODE - Parse Speech Result', 'n8n_code_parse_speech_result.js', [1824, 2080]),
  codeNode('CODE - Pick Parse Result', 'n8n_code_pick_parse_result.js', [2048, 1888]),
  httpPatch(
    'HTTP - SB PATCH session interview_history',
    `={{ ${PICK}._session_patch_url }}`,
    `={{ ${PICK}._session_patch_body }}`,
    [2272, 1888]
  ),
  {
    parameters: {
      respondWith: 'json',
      responseBody: `={{ {
  score: ${PICK}.score,
  feedback: ${PICK}.feedback,
  nextQuestion: ${PICK}.nextQuestion,
  time_limit_seconds: ${PICK}.time_limit_seconds,
  deadline_at: ${PICK}.deadline_at,
  complexity_tier: ${PICK}.complexity_tier,
  isFinal: ${PICK}.isFinal,
  result: ${PICK}.result || '',
  assessment_mode: ${PICK}.assessment_mode || 'text',
  startSpeech: ${PICK}.startSpeech || false,
  speech_phases: ${PICK}.speech_phases || 3,
  soft_skills: ${PICK}.soft_skills || null
} }}`,
      options: { responseCode: 200 },
    },
    id: id(),
    name: 'Respond to Portal',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1,
    position: [2496, 1760],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'final-check',
            leftValue: `={{ ${PICK}.isFinal }}`,
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
    position: [2496, 2000],
  },
  codeNode('CODE - Build assessment result mail', 'n8n_code_build_assessment_result_mail.js', [2720, 2000]),
  gmailThreadReply('MAIL - Reply candidate (assessment result)', [2960, 2000]),
  codeNode('CODE - Merge Gmail reply response (result)', 'n8n_code_merge_gmail_reply_response.js', [3200, 2000]),
  httpPatch(
    'HTTP - PATCH candidate gmail (result)',
    '={{ $json._gmail_patch_url }}',
    '={{ $json._gmail_patch_body }}',
    [3520, 2000]
  ),
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'pass-check',
            leftValue: `={{ ${PICK}.result }}`,
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
    position: [3760, 2000],
  },
  codeNode('CODE - Prep scheduling from PASS', 'n8n_code_prep_scheduling_from_pass.js', [4000, 1920]),
  codeNode('CODE - Build interviewer mail context', 'n8n_code_build_interviewer_mail_context.js', [4224, 1920]),
  gmailSend(
    'MAIL - Interviewer pitch mail',
    '={{ $json.interviewer_email }}',
    '={{ $json.mail_subject }}',
    [4448, 1920]
  ),
  codeNode('CODE - Merge Gmail interviewer send', 'n8n_code_merge_gmail_interviewer_response.js', [4672, 1920]),
  httpPatch(
    'HTTP - PATCH interviewer thread (pitch)',
    '={{ $json._interviewer_patch_url }}',
    '={{ $json._interviewer_patch_body }}',
    [4896, 1920]
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
    position: [5120, 1920],
    webhookId: 'interviewer-availability-wait',
  },
  codeNode('CODE - Parse interviewer slot', 'n8n_code_parse_interviewer_slot.js', [5344, 1920]),
  codeNode('CODE - Build candidate slot mail', 'n8n_code_build_candidate_slot_mail.js', [5568, 1920]),
  gmailThreadReply('MAIL - Candidate pitch mail', [5800, 1920]),
  codeNode('CODE - Merge Gmail reply response (scheduling)', 'n8n_code_merge_gmail_reply_response.js', [6024, 1920]),
  httpPatch(
    'HTTP - PATCH candidate gmail (scheduling)',
    '={{ $json._gmail_patch_url }}',
    '={{ $json._gmail_patch_body }}',
    [6248, 1920]
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
    position: [6472, 1920],
    webhookId: 'candidate-slot-choice-wait',
  },
  codeNode('CODE - Parse candidate choice', 'n8n_code_parse_candidate_choice.js', [6696, 1920]),
  {
    parameters: {
      calendar: {
        __rl: true,
        value: "={{ $json.config.calendar_id || 'primary' }}",
        mode: 'list',
        cachedResultName: 'primary',
      },
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
    position: [6920, 1920],
    credentials: {
      googleCalendarOAuth2Api: { id: 'GOOGLE_CALENDAR_CREDENTIAL_ID', name: 'Google Calendar account' },
    },
  },
  codeNode('CODE - Build interview confirmed mail', 'n8n_code_build_interview_confirmed_mail.js', [7144, 1800]),
  gmailThreadReply('MAIL - Notify candidate', [7368, 1800]),
  codeNode('CODE - Merge Gmail reply response (confirmed)', 'n8n_code_merge_gmail_reply_response.js', [7592, 1800]),
  httpPatch(
    'HTTP - PATCH candidate gmail (confirmed)',
    '={{ $json._gmail_patch_url }}',
    '={{ $json._gmail_patch_body }}',
    [7816, 1800]
  ),
  codeNode('CODE - Build interviewer confirmed mail', 'n8n_code_build_interviewer_confirmed_mail.js', [7144, 2040]),
  gmailInterviewerReply('MAIL - Notify interviewer', [7368, 2040]),
  codeNode('CODE - Merge Gmail interviewer reply (confirmed)', 'n8n_code_merge_gmail_interviewer_response.js', [7592, 2040]),
  httpPatch(
    'HTTP - PATCH interviewer thread (confirmed)',
    '={{ $json._interviewer_patch_url }}',
    '={{ $json._interviewer_patch_body }}',
    [7816, 2040]
  ),
  httpPatch(
    'HTTP - SB scheduling concluding',
    "={{ $('CFG - Assessment Config').first().json.supabase_url.replace(/\\/$/, '') }}/rest/v1/assessment_sessions?id=eq.{{ $('CODE - Parse candidate choice').first().json.session_id }}",
    "={{ { status: 'completed', updated_at: new Date().toISOString() } }}",
    [8032, 1920]
  ),
  httpPatch(
    'HTTP - PATCH scheduling pending',
    "={{ $('CFG - Assessment Config').first().json.supabase_url.replace(/\\/$/, '') }}/rest/v1/assessment_sessions?id=eq.{{ $('CODE - Prep scheduling from PASS').first().json.session_id }}",
    "={{ { scheduling_status: 'pending', updated_at: new Date().toISOString() } }}",
    [4000, 2120]
  ),
];

const connections = {
  'TRG - Assessment Answer': { main: [[{ node: 'CFG - Assessment Config', type: 'main', index: 0 }]] },
  'CFG - Assessment Config': { main: [[{ node: 'CODE - Normalize Data', type: 'main', index: 0 }]] },
  'CODE - Normalize Data': { main: [[{ node: 'HTTP - Fetch Session', type: 'main', index: 0 }]] },
  'HTTP - Fetch Session': { main: [[{ node: 'IF - Speech mode?', type: 'main', index: 0 }]] },
  'IF - Speech mode?': {
    main: [
      [{ node: 'CODE - Build Speech LLM context', type: 'main', index: 0 }],
      [{ node: 'CODE - Build LLM context', type: 'main', index: 0 }],
    ],
  },
  'CODE - Build LLM context': { main: [[{ node: 'Basic LLM Chain', type: 'main', index: 0 }]] },
  'Basic LLM Chain': { main: [[{ node: 'CODE - Parse Technical Result', type: 'main', index: 0 }]] },
  'Google Vertex Chat Model': {
    ai_languageModel: [[{ node: 'Basic LLM Chain', type: 'ai_languageModel', index: 0 }]],
  },
  'CODE - Parse Technical Result': {
    main: [[{ node: 'CODE - Pick Parse Result', type: 'main', index: 0 }]],
  },
  'CODE - Build Speech LLM context': {
    main: [[{ node: 'Basic LLM Chain Speech', type: 'main', index: 0 }]],
  },
  'Basic LLM Chain Speech': {
    main: [[{ node: 'CODE - Parse Speech Result', type: 'main', index: 0 }]],
  },
  'Google Vertex Chat Model Speech': {
    ai_languageModel: [[{ node: 'Basic LLM Chain Speech', type: 'ai_languageModel', index: 0 }]],
  },
  'CODE - Parse Speech Result': {
    main: [[{ node: 'CODE - Pick Parse Result', type: 'main', index: 0 }]],
  },
  'CODE - Pick Parse Result': {
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
    main: [[{ node: 'CODE - Build assessment result mail', type: 'main', index: 0 }], []],
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
    main: [
      [
        { node: 'CODE - Build interviewer mail context', type: 'main', index: 0 },
        { node: 'HTTP - PATCH scheduling pending', type: 'main', index: 0 },
      ],
    ],
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
  name: 'Talent Acquisition — Assessment + Speech + Scheduling',
  nodes,
  connections,
  pinData: {},
  active: false,
  settings: { executionOrder: 'v1' },
  meta: {
    templateCredsSetupCompleted: true,
    description:
      'Technical phases 1–5 (text) then communication phases 6–8 (speech). Same assessment-answer webhook. Import, set credentials, run supabase_speech_assessment.sql, activate.',
  },
  tags: [],
};

const outPath = path.join(root, 'Talent Acquisition — Assessment + Speech + Scheduling.json');
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log('Written:', outPath);
console.log('Nodes:', nodes.length);

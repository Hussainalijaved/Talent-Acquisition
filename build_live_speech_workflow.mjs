// Build Talent Acquisition — Live Speech.json from companion .js files
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readJs(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

const pickParseJs = `// n8n: CODE - Pick Parse Result (live speech)
function pickParseJson() {
  const names = [
    'CODE - Parse Live Speech Result',
    'CODE - Parse Speech Result',
    'CODE - Parse Technical Result',
  ];
  for (const name of names) {
    try {
      const raw = $(name).first().json;
      if (raw && typeof raw === 'object' && raw.session_id) return raw;
    } catch (_) {}
  }
  const inp = $input.first().json;
  if (inp && inp.session_id) return inp;
  throw new Error('No parse result found.');
}
return [{ json: pickParseJson() }];`;

const buildMailJs = readJs('n8n_code_build_assessment_result_mail.js').replace(
  "'CODE - Parse Speech Result',\n    'CODE - Parse Speech Result1',\n    'CODE - Parse Technical Result',\n    'CODE - Parse Technical Result1'",
  "'CODE - Parse Live Speech Result',\n    'CODE - Parse Speech Result',\n    'CODE - Parse Speech Result1',\n    'CODE - Parse Technical Result',\n    'CODE - Parse Technical Result1'"
).replace(
  "'CODE - Build Speech LLM context',\n      'CODE - Build Speech LLM context1',\n      'CODE - Build LLM context',\n      'CODE - Build LLM context1'",
  "'CODE - Build Live Speech Relay Context',\n      'CODE - Build Speech LLM context',\n      'CODE - Build Speech LLM context1',\n      'CODE - Build LLM context',\n      'CODE - Build LLM context1'"
);

const cfgAssignments = [
  { id: 'ls-cfg-1', name: 'supabase_url', value: 'https://vnxstyadacgntnsvcvzn.supabase.co', type: 'string' },
  { id: 'ls-cfg-2', name: 'supabase_key', value: '={{ $env.SUPABASE_SERVICE_ROLE_KEY }}', type: 'string' },
  { id: 'ls-cfg-3', name: 'gemini_live_model', value: 'gemini-2.0-flash-live-001', type: 'string' },
  { id: 'ls-cfg-4', name: 'max_questions', value: '5', type: 'string' },
  { id: 'ls-cfg-5', name: 'live_speech_turns', value: 5, type: 'number' },
  { id: 'ls-cfg-6', name: 'speech_phases', value: 5, type: 'number' },
  { id: 'ls-cfg-7', name: 'technical_weight', value: 0.7, type: 'number' },
  { id: 'ls-cfg-8', name: 'speech_weight', value: 0.3, type: 'number' },
  { id: 'ls-cfg-9', name: 'pass_score_threshold', value: 60, type: 'number' },
  { id: 'ls-cfg-10', name: 'fail_score_threshold', value: 30, type: 'number' },
  { id: 'ls-cfg-11', name: 'organization_name', value: 'Convo Pvt Ltd', type: 'string' },
  { id: 'ls-cfg-12', name: 'interviewer_email', value: 'hussainalijaved712@gmail.com', type: 'string' },
  { id: 'ls-cfg-13', name: 'portal_base_url', value: 'https://talent-acquisition-six.vercel.app', type: 'string' },
  { id: 'ls-cfg-14', name: 'n8n_public_url', value: 'https://randy-gaunt-bradley.ngrok-free.dev', type: 'string' },
  { id: 'ls-cfg-15', name: 'live_relay_url', value: 'wss://YOUR-LIVE-RELAY.example.com/live', type: 'string' },
  {
    id: 'ls-cfg-16',
    name: 'live_complete_webhook',
    value: '={{ $json.n8n_public_url }}/webhook/talent/live-speech-complete',
    type: 'string',
  },
  { id: 'ls-cfg-17', name: 'table_assessment_sessions', value: 'assessment_sessions', type: 'string' },
];

const workflow = {
  name: 'Talent Acquisition — Live Speech',
  nodes: [
    {
      parameters: {
        content:
          '## Live Speech — START\nPortal / relay calls **POST /webhook/talent/live-speech-start** with `session_id` + `email`.\nReturns Gemini Live system prompt + session context.\n\nSet **live_relay_url** in CFG to your WebSocket relay.',
        height: 200,
        width: 420,
      },
      id: 'ls-note-start',
      name: 'NOTE - Live Speech Start',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [80, 80],
    },
    {
      parameters: {
        content:
          '## Live Speech — COMPLETE\nRelay posts **POST /webhook/talent/live-speech-complete** with `turns[]`, scores, optional `session_audio_url`.\nPATCHes session → result mail if PASS/FAIL.\n\n**Connect:** Disable old per-phase speech branch in Assessment workflow when using live mode.',
        height: 220,
        width: 440,
      },
      id: 'ls-note-complete',
      name: 'NOTE - Live Speech Complete',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [80, 520],
    },
    {
      parameters: { httpMethod: 'POST', path: 'talent/live-speech-start', responseMode: 'responseNode', options: {} },
      id: 'ls-trg-start',
      name: 'TRG - Live Speech Start',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [240, 240],
      webhookId: 'live-speech-start-webhook-01',
    },
    {
      parameters: { httpMethod: 'POST', path: 'talent/live-speech-complete', responseMode: 'responseNode', options: {} },
      id: 'ls-trg-complete',
      name: 'TRG - Live Speech Complete',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [240, 680],
      webhookId: 'live-speech-complete-webhook-01',
    },
    {
      parameters: { assignments: { assignments: cfgAssignments }, includeOtherFields: true, options: {} },
      id: 'ls-cfg-start',
      name: 'CFG - Live Speech Config (start)',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [480, 240],
    },
    {
      parameters: { assignments: { assignments: cfgAssignments }, includeOtherFields: true, options: {} },
      id: 'ls-cfg-complete',
      name: 'CFG - Live Speech Config (complete)',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [480, 680],
    },
    {
      parameters: { jsCode: readJs('n8n_code_normalize_live_speech_start.js') },
      id: 'ls-norm-start',
      name: 'CODE - Normalize Live Speech Start',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [720, 240],
    },
    {
      parameters: { jsCode: readJs('n8n_code_normalize_live_speech_complete.js') },
      id: 'ls-norm-complete',
      name: 'CODE - Normalize Live Speech Complete',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [720, 680],
    },
    {
      parameters: {
        method: 'GET',
        url: "={{ $json.config.supabase_url }}/rest/v1/{{ $json.config.table_assessment_sessions || 'assessment_sessions' }}?id=eq.{{ encodeURIComponent($json.session_id) }}&select=*",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'apikey', value: '={{ $json.config.supabase_key }}' },
            { name: 'Authorization', value: '=Bearer {{ $json.config.supabase_key }}' },
          ],
        },
        options: { timeout: 60000 },
      },
      id: 'ls-fetch-start',
      name: 'HTTP - Fetch Session Start',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [960, 240],
      retryOnFail: true,
      maxTries: 3,
    },
    {
      parameters: {
        method: 'GET',
        url: "={{ $('CODE - Normalize Live Speech Complete').first().json.config.supabase_url }}/rest/v1/{{ $('CODE - Normalize Live Speech Complete').first().json.config.table_assessment_sessions || 'assessment_sessions' }}?id=eq.{{ encodeURIComponent($('CODE - Normalize Live Speech Complete').first().json.session_id) }}&select=*",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'apikey', value: "={{ $('CODE - Normalize Live Speech Complete').first().json.config.supabase_key }}" },
            { name: 'Authorization', value: "=Bearer {{ $('CODE - Normalize Live Speech Complete').first().json.config.supabase_key }}" },
          ],
        },
        options: { timeout: 60000 },
      },
      id: 'ls-fetch-complete',
      name: 'HTTP - Fetch Session Complete',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [960, 680],
      retryOnFail: true,
      maxTries: 3,
    },
    {
      parameters: { jsCode: readJs('n8n_code_build_live_speech_relay_context.js') },
      id: 'ls-relay-ctx',
      name: 'CODE - Build Live Speech Relay Context',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1200, 240],
    },
    {
      parameters: { jsCode: readJs('n8n_code_parse_live_speech_result.js') },
      id: 'ls-parse',
      name: 'CODE - Parse Live Speech Result',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1200, 680],
    },
    {
      parameters: { jsCode: pickParseJs },
      id: 'ls-pick',
      name: 'CODE - Pick Parse Result',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1440, 680],
    },
    {
      parameters: {
        method: 'PATCH',
        url: '={{ $("CODE - Pick Parse Result").first().json._session_patch_url }}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'apikey', value: "={{ $('CFG - Live Speech Config (complete)').first().json.supabase_key }}" },
            { name: 'Authorization', value: "=Bearer {{ $('CFG - Live Speech Config (complete)').first().json.supabase_key }}" },
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Prefer', value: 'return=minimal' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ $("CODE - Pick Parse Result").first().json._session_patch_body }}',
        options: {},
      },
      id: 'ls-patch',
      name: 'HTTP - SB PATCH session',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1680, 680],
      onError: 'continueRegularOutput',
    },
    {
      parameters: {
        respondWith: 'json',
        responseBody:
          '={{ {\n  ok: true,\n  session_id: $json.session_id,\n  candidate_email: $json.candidate_email,\n  system_instruction: $json.system_instruction,\n  kickoff_prompt: $json.kickoff_prompt,\n  gemini_live_model: $json.gemini_live_model,\n  live_relay_url: $json.live_relay_url,\n  live_complete_webhook: $json.live_complete_webhook,\n  portal_base_url: $json.portal_base_url,\n  supabase_url: $json.supabase_url,\n  supabase_key: $json.supabase_key,\n  max_questions: $json.max_questions,\n  speech_phases: $json.speech_phases,\n  speech_answer_seconds: $json.speech_answer_seconds,\n  current_phase: $json.current_phase,\n  requisition_title: $json.requisition_title,\n  assessment_mode: "live_speech",\n  config: $json.config\n} }}',
        options: { responseCode: 200 },
      },
      id: 'ls-respond-start',
      name: 'Respond - Live Speech Start',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1,
      position: [1440, 240],
    },
    {
      parameters: {
        respondWith: 'json',
        responseBody:
          '={{ {\n  score: $("CODE - Pick Parse Result").first().json.score,\n  feedback: $("CODE - Pick Parse Result").first().json.feedback,\n  isFinal: $("CODE - Pick Parse Result").first().json.isFinal,\n  result: $("CODE - Pick Parse Result").first().json.result || "",\n  assessment_mode: "live_speech",\n  speech_phases: $("CODE - Pick Parse Result").first().json.speech_phases || 5\n} }}',
        options: { responseCode: 200 },
      },
      id: 'ls-respond-complete',
      name: 'Respond - Live Speech Complete',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1,
      position: [1920, 560],
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [
            {
              id: 'final-check',
              leftValue: '={{ $("CODE - Pick Parse Result").first().json.isFinal }}',
              rightValue: true,
              operator: { type: 'boolean', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: 'ls-if-finished',
      name: 'IF - Assessment finished?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1920, 760],
    },
    {
      parameters: { jsCode: buildMailJs },
      id: 'ls-mail-build',
      name: 'CODE - Build assessment result mail',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [2160, 760],
    },
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
      id: 'ls-mail-reply',
      name: 'MAIL - Reply candidate (assessment result)',
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      position: [2400, 760],
      credentials: { gmailOAuth2: { name: 'Gmail account' } },
    },
  ],
  connections: {
    'TRG - Live Speech Start': { main: [[{ node: 'CFG - Live Speech Config (start)', type: 'main', index: 0 }]] },
    'TRG - Live Speech Complete': { main: [[{ node: 'CFG - Live Speech Config (complete)', type: 'main', index: 0 }]] },
    'CFG - Live Speech Config (start)': {
      main: [[{ node: 'CODE - Normalize Live Speech Start', type: 'main', index: 0 }]],
    },
    'CFG - Live Speech Config (complete)': {
      main: [[{ node: 'CODE - Normalize Live Speech Complete', type: 'main', index: 0 }]],
    },
    'CODE - Normalize Live Speech Start': {
      main: [[{ node: 'HTTP - Fetch Session Start', type: 'main', index: 0 }]],
    },
    'CODE - Normalize Live Speech Complete': {
      main: [[{ node: 'HTTP - Fetch Session Complete', type: 'main', index: 0 }]],
    },
    'HTTP - Fetch Session Start': {
      main: [[{ node: 'CODE - Build Live Speech Relay Context', type: 'main', index: 0 }]],
    },
    'HTTP - Fetch Session Complete': {
      main: [[{ node: 'CODE - Parse Live Speech Result', type: 'main', index: 0 }]],
    },
    'CODE - Build Live Speech Relay Context': {
      main: [[{ node: 'Respond - Live Speech Start', type: 'main', index: 0 }]],
    },
    'CODE - Parse Live Speech Result': {
      main: [[{ node: 'CODE - Pick Parse Result', type: 'main', index: 0 }]],
    },
    'CODE - Pick Parse Result': {
      main: [[{ node: 'HTTP - SB PATCH session', type: 'main', index: 0 }]],
    },
    'HTTP - SB PATCH session': {
      main: [
        [
          { node: 'Respond - Live Speech Complete', type: 'main', index: 0 },
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
  },
  pinData: {},
  settings: { executionOrder: 'v1' },
  staticData: null,
  tags: [],
  meta: { templateCredsSetupCompleted: true },
};

const outPath = path.join(__dirname, 'Talent Acquisition — Live Speech.json');
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log('Wrote', outPath);

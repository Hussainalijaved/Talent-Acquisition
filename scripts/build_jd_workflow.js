const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const buildJs = fs.readFileSync(path.join(root, 'n8n_code_build_jd_generate_prompt.js'), 'utf8');
const parseJs = fs.readFileSync(path.join(root, 'n8n_code_parse_jd_generate_result.js'), 'utf8');

const workflow = {
  name: 'Talent Acquisition — JD Generate',
  nodes: [
    {
      parameters: {
        httpMethod: 'POST',
        path: 'talent/jd-generate',
        responseMode: 'responseNode',
        options: {
          allowedOrigins: '*',
        },
      },
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'TRG - Webhook JD generate',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [-400, 300],
      webhookId: 'talent-jd-generate',
    },
    {
      parameters: { jsCode: buildJs },
      id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      name: 'CODE - Build JD generate prompt',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-160, 300],
    },
    {
      parameters: {
        method: 'POST',
        url: '=https://api.groq.com/openai/v1/chat/completions',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: '=Bearer {{ $env.GROQ_API_KEY }}' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ $json.groq_jd_request }}',
        options: { timeout: 120000 },
      },
      id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      name: 'HTTP - Groq JD generate',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [80, 300],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      onError: 'continueRegularOutput',
    },
    {
      parameters: { jsCode: parseJs },
      id: 'd4e5f6a7-b8c9-0123-def0-234567890123',
      name: 'CODE - Parse JD generate result',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [320, 300],
    },
    {
      parameters: {
        respondWith: 'json',
        responseBody:
          '={{ { success: $json.success, jd_text: $json.jd_text, title: $json.title, error: $json.error || "" } }}',
        options: {
          responseCode: 200,
          responseHeaders: {
            entries: [
              { name: 'Access-Control-Allow-Origin', value: '*' },
              { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
              { name: 'Access-Control-Allow-Headers', value: 'Content-Type, ngrok-skip-browser-warning' },
            ],
          },
        },
      },
      id: 'e5f6a7b8-c9d0-1234-ef01-345678901234',
      name: 'Respond to Admin',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1,
      position: [560, 300],
    },
  ],
  connections: {
    'TRG - Webhook JD generate': {
      main: [[{ node: 'CODE - Build JD generate prompt', type: 'main', index: 0 }]],
    },
    'CODE - Build JD generate prompt': {
      main: [[{ node: 'HTTP - Groq JD generate', type: 'main', index: 0 }]],
    },
    'HTTP - Groq JD generate': {
      main: [[{ node: 'CODE - Parse JD generate result', type: 'main', index: 0 }]],
    },
    'CODE - Parse JD generate result': {
      main: [[{ node: 'Respond to Admin', type: 'main', index: 0 }]],
    },
  },
  pinData: {},
  settings: { executionOrder: 'v1' },
  staticData: null,
  tags: [],
  triggerCount: 1,
  updatedAt: new Date().toISOString(),
  versionId: 'jd-generate-v1',
};

fs.writeFileSync(
  path.join(root, 'Talent Acquisition — JD Generate.json'),
  JSON.stringify(workflow, null, 2)
);
console.log('Wrote Talent Acquisition — JD Generate.json');

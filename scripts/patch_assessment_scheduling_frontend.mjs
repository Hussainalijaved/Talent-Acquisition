import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const wfPath = path.join(root, 'Talent Acquisition — Assessment + Scheduling (Threaded Mail).json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));

const map = {
  'CODE - Build interviewer mail context': 'n8n_code_build_interviewer_mail_context.js',
  'CODE - Build candidate slot mail': 'n8n_code_build_candidate_slot_mail.js',
  'CODE - Build assessment result mail': 'n8n_code_build_assessment_result_mail.js',
  'CODE - Prep scheduling from PASS': 'n8n_code_prep_scheduling_from_pass.js',
};

for (const node of wf.nodes) {
  const file = map[node.name];
  if (!file) continue;
  node.parameters.jsCode = fs
    .readFileSync(path.join(root, file), 'utf8')
    .trim()
    .replace(/\r?\n/g, '\r\n');
}

const mail = wf.nodes.find((n) => n.name === 'MAIL - Interviewer pitch mail');
if (mail) mail.parameters.message = '={{ $json.mail_body_html }}';

let patchPending = wf.nodes.find((n) => n.name === 'HTTP - PATCH scheduling pending');
if (!patchPending) {
  patchPending = {
    parameters: {
      method: 'PATCH',
      url: "={{ $('CODE - Build interviewer mail context').first().json._scheduling_patch_url }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'apikey',
            value: "={{ $('CFG - Assessment Config').first().json.supabase_key }}",
          },
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
      jsonBody:
        "={{ $('CODE - Build interviewer mail context').first().json._scheduling_patch_body }}",
      options: {},
    },
    id: 'a1b2c3d4-sched-pending-0001',
    name: 'HTTP - PATCH scheduling pending',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [4528, 1240],
    onError: 'continueRegularOutput',
  };
  wf.nodes.push(patchPending);
}

wf.connections['MAIL - Interviewer pitch mail'] = {
  main: [[{ node: 'CODE - Merge Gmail interviewer send', type: 'main', index: 0 }]],
};
wf.connections['HTTP - PATCH interviewer thread (pitch)'] = {
  main: [[{ node: 'HTTP - PATCH scheduling pending', type: 'main', index: 0 }]],
};
wf.connections['HTTP - PATCH scheduling pending'] = { main: [[]] };

// Legacy WAIT scheduling — disabled and disconnected (handled by Scheduling Webhooks workflow)
const legacy = [
  'WAIT - Interviewer availability',
  'WAIT - Candidate slot choice',
  'CODE - Parse interviewer slot',
  'CODE - Parse candidate choice',
  'CODE - Build candidate slot mail',
  'MAIL - Candidate pitch mail',
];
for (const name of legacy) {
  const node = wf.nodes.find((n) => n.name === name);
  if (node) node.disabled = true;
}
wf.connections['MAIL - Candidate pitch mail'] = { main: [[]] };
wf.connections['CODE - Parse interviewer slot'] = { main: [[]] };

fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf8');
console.log('Patched assessment workflow for frontend scheduling');

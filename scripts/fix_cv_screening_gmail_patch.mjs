import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function readJs(name) {
  return fs.readFileSync(path.join(root, name), 'utf8').trim();
}

const files = [
  'Talent Acquisition — CV Screening.json',
  'Talent Acquisition — CV Screening (Threaded Mail).json',
];

const patchUrlExpr =
  "={{ $('CFG - Workflow configuration').first().json.config.supabase_url.replace(/\\/$/, '') + '/rest/v1/assessment_sessions?id=eq.' + encodeURIComponent(String($('CODE - SB map session id').first().json.session_db_id || $('CODE - SB map session id').first().json.id || '')) }}";

const patchBodyExpr = `={{ (() => {
  const mail = $('MAIL - Email outreach agent (shortlist)').first().json || {};
  const mapped = $('CODE - SB map session id').first().json || {};
  const msgId = String(mail.id || mail.messageId || mail.message_id || '').trim();
  const threadId = String(mail.threadId || mail.thread_id || msgId || '').trim();
  const maxQ = Number(mapped.config?.max_questions || 5);
  const phase = Number(mapped.session_phase || 1);
  if (!msgId) {
    throw new Error('MAIL node missing id/messageId. Keys: ' + Object.keys(mail).join(', '));
  }
  if (!threadId || /^pending$/i.test(threadId) || /^draft-/i.test(threadId)) {
    throw new Error('MAIL node missing valid threadId. Got: ' + threadId);
  }
  return {
    gmail_thread_id: threadId,
    gmail_message_id: msgId,
    mail_subject: 'Your application — next step: technical assessment (Phase ' + phase + '/' + maxQ + ')',
    updated_at: new Date().toISOString(),
  };
})() }}`;

for (const file of files) {
  const wfPath = path.join(root, file);
  if (!fs.existsSync(wfPath)) continue;
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));

  const mail = wf.nodes.find((n) => n.name === 'MAIL - Email outreach agent (shortlist)');
  const patch = wf.nodes.find((n) => n.name === 'HTTP - SB PATCH session gmail thread');
  const merge = wf.nodes.find((n) => n.name === 'CODE - Merge Gmail send response');
  const urls = wf.nodes.find((n) => n.name === 'CODE - SB URLs after outreach mail');

  if (!mail || !patch) {
    console.warn('Skip', file, '- nodes missing');
    continue;
  }

  mail.parameters = {
    resource: 'message',
    operation: 'send',
    sendTo: mail.parameters.sendTo,
    subject: mail.parameters.subject,
    emailType: mail.parameters.emailType || 'html',
    message: mail.parameters.message,
    options: { simplify: false },
  };

  patch.parameters.method = 'PATCH';
  patch.parameters.url = patchUrlExpr;
  patch.parameters.jsonBody = patchBodyExpr;
  patch.parameters.sendBody = true;
  patch.parameters.specifyBody = 'json';

  if (merge) merge.parameters.jsCode = readJs('n8n_code_merge_gmail_send_response.js');
  if (urls) urls.parameters.jsCode = readJs('n8n_code_sb_urls_after_outreach_mail.js');

  // MAIL → PATCH directly (no code node in between)
  wf.connections['MAIL - Email outreach agent (shortlist)'] = {
    main: [[{ node: 'HTTP - SB PATCH session gmail thread', type: 'main', index: 0 }]],
  };
  wf.connections['HTTP - SB PATCH session gmail thread'] = {
    main: [[{ node: 'CODE - Merge Gmail send response', type: 'main', index: 0 }]],
  };
  wf.connections['CODE - SB URLs after outreach mail'] = {
    main: [[{ node: 'HTTP - SB candidates shortlisted', type: 'main', index: 0 }]],
  };

  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Fixed:', file);
}

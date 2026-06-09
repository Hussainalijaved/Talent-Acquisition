import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function readJs(name) {
  return fs.readFileSync(path.join(root, name), 'utf8').trim();
}

function patchWorkflow(fileName, outName) {
  const wfPath = path.join(root, fileName);
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));

  const urls = wf.nodes.find((n) => n.name === 'CODE - SB URLs after outreach mail');
  const merge = wf.nodes.find((n) => n.name === 'CODE - Merge Gmail send response');
  if (!urls || !merge) throw new Error(`Nodes missing in ${fileName}`);

  urls.parameters.jsCode = readJs('n8n_code_sb_urls_after_outreach_mail.js');
  merge.parameters.jsCode = readJs('n8n_code_merge_gmail_send_response.js');

  wf.name = outName;
  const out = path.join(root, `${outName}.json`);
  fs.writeFileSync(out, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Written:', out);
}

patchWorkflow(
  'Talent Acquisition — CV Screening.json',
  'Talent Acquisition — CV Screening (Threaded Mail)'
);

// Also update the base file in repo
const base = JSON.parse(
  fs.readFileSync(path.join(root, 'Talent Acquisition — CV Screening.json'), 'utf8')
);
base.nodes.find((n) => n.name === 'CODE - SB URLs after outreach mail').parameters.jsCode =
  readJs('n8n_code_sb_urls_after_outreach_mail.js');
base.nodes.find((n) => n.name === 'CODE - Merge Gmail send response').parameters.jsCode =
  readJs('n8n_code_merge_gmail_send_response.js');
fs.writeFileSync(
  path.join(root, 'Talent Acquisition — CV Screening.json'),
  JSON.stringify(base, null, 2),
  'utf8'
);
console.log('Updated: Talent Acquisition — CV Screening.json');

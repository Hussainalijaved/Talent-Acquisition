import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const code = fs
  .readFileSync(path.join(root, 'n8n_code_sb_prepare_session_insert.js'), 'utf8')
  .trim()
  .replace(/\r?\n/g, '\r\n');

const preferExpr =
  "={{ $('CODE - SB prepare session insert').first().json._session_prefer || 'return=representation' }}";

for (const wfName of [
  'Talent Acquisition — CV Screening.json',
  'Talent Acquisition — CV Screening (Threaded Mail).json',
]) {
  const wfPath = path.join(root, wfName);
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  for (const node of wf.nodes) {
    if (node.name === 'CODE - SB prepare session insert') {
      node.parameters.jsCode = code;
    }
    if (node.name === 'HTTP - SB insert assessment session') {
      const headers = node.parameters.headerParameters.parameters;
      const prefer = headers.find((h) => h.name === 'Prefer');
      if (prefer) prefer.value = preferExpr;
      else headers.push({ name: 'Prefer', value: preferExpr });
    }
  }
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Updated', wfName);
}

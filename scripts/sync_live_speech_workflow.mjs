import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function readJs(name) {
  return fs.readFileSync(path.join(root, name), 'utf8').trim();
}

const file = 'Talent Acquisition — Live Speech.json';
const wfPath = path.join(root, file);
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));

const mapping = [
  ['CODE - Normalize Live Speech Start', 'n8n_code_normalize_live_speech_start.js'],
  ['CODE - Normalize Live Speech Complete', 'n8n_code_normalize_live_speech_complete.js'],
  ['CODE - Build Live Speech Relay Context', 'n8n_code_build_live_speech_relay_context.js'],
  ['CODE - Parse Live Speech Result', 'n8n_code_parse_live_speech_result.js'],
];

for (const [nodeName, jsFile] of mapping) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) {
    console.warn('Node not found, skipping:', nodeName);
    continue;
  }
  node.parameters.jsCode = readJs(jsFile);
  console.log('Patched:', nodeName, '<-', jsFile);
}

fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf8');
console.log('Written:', file);

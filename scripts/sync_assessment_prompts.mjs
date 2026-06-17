import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function readJs(name) {
  return fs.readFileSync(path.join(root, name), 'utf8').trim();
}

function patchNode(wf, nodeName, jsFile) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`Node not found: ${nodeName} in ${wf.name || 'workflow'}`);
  node.parameters.jsCode = readJs(jsFile);
}

const cvFiles = [
  'Talent Acquisition — CV Screening.json',
  'Talent Acquisition — CV Screening (Threaded Mail).json',
];

for (const file of cvFiles) {
  const wfPath = path.join(root, file);
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  patchNode(wf, 'Gemini - CV screening agent (request body)', 'n8n_code_screening_phase1_prompt.js');
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Patched CV screening prompt:', file);
}

const assessmentFiles = [
  'Talent Acquisition — Assessment + Speech + Scheduling.json',
  'Talent Acquisition — Assessment + Scheduling.json',
  'Talent Acquisition — Assessment + Scheduling (Threaded Mail).json',
];

const assessmentNodes = [
  ['CODE - Build LLM context', 'n8n_code_build_llm_context.js'],
  ['CODE - Parse Technical Result', 'n8n_code_parse_technical_result.js'],
  ['CODE - Parse Result', 'n8n_code_parse_assessment_result.js'],
];

for (const file of assessmentFiles) {
  const wfPath = path.join(root, file);
  if (!fs.existsSync(wfPath)) continue;
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  let touched = false;
  for (const [nodeName, jsFile] of assessmentNodes) {
    const node = wf.nodes.find((n) => n.name === nodeName);
    if (!node) continue;
    if (nodeName === 'CODE - Parse Technical Result' && jsFile === 'n8n_code_parse_technical_result.js') {
      // technical result has its own buildFallback - sync parse_assessment fallbacks into technical if shared
      node.parameters.jsCode = readJs(jsFile);
    } else {
      node.parameters.jsCode = readJs(jsFile);
    }
    touched = true;
  }
  if (touched) {
    fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf8');
    console.log('Patched assessment nodes:', file);
  }
}

console.log('Done.');

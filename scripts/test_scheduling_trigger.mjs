/**
 * Diagnose whether assessment PASS triggers interview scheduling.
 *
 * Checks:
 *  1. n8n workflow JSON wiring (Live Speech vs full Assessment+Scheduling)
 *  2. Production PASS sessions — scheduling_status in Supabase
 *  3. Puppeteer — portal does NOT call scheduling webhooks on finish (server-side only)
 *
 * Usage:
 *   node scripts/test_scheduling_trigger.mjs
 *   node scripts/test_scheduling_trigger.mjs --prod
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const useProd = process.argv.includes('--prod');
const SUPABASE_URL = 'https://vnxstyadacgntnsvcvzn.supabase.co';
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZueHN0eWFkYWNnbnRuc3ZjdnpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjAwMjAsImV4cCI6MjA5MzYzNjAyMH0.4rJRI_f6HyQNGYLHaw2ZH6q7060ey8ftUVxzvzWEwD4';

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
}
function ok(name) {
  console.log(`  ok   - ${name}`);
}
function warn(name, detail) {
  console.log(`  warn - ${name}${detail ? ` :: ${detail}` : ''}`);
}

function loadWorkflow(name) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function workflowSchedulingChain(wf, label) {
  console.log(`\n--- Workflow: ${label} ---`);
  if (!wf) {
    fail(`${label} file missing`, 'JSON not found');
    return;
  }

  const names = new Set(wf.nodes.map((n) => n.name));
  const required = [
    'IF - Assessment finished?',
    'CODE - Build assessment result mail',
    'MAIL - Reply candidate (assessment result)',
    'IF - Result PASS?',
    'CODE - Prep scheduling from PASS',
    'CODE - Build interviewer mail context',
  ];

  for (const node of required) {
    if (names.has(node)) ok(`${label} has node "${node}"`);
    else fail(`${label} missing node "${node}"`);
  }

  const mailOut = wf.connections?.['MAIL - Reply candidate (assessment result)']?.main?.[0];
  if (!mailOut?.length) {
    fail(`${label} MAIL wiring`, 'MAIL - Reply candidate has no outgoing connections');
  } else {
    ok(`${label} MAIL wired to ${mailOut.map((c) => c.node).join(', ')}`);
  }

  const passOut = wf.connections?.['IF - Result PASS?']?.main?.[0]?.[0]?.node;
  if (passOut === 'CODE - Prep scheduling from PASS') {
    ok(`${label} PASS branch → Prep scheduling from PASS`);
  } else if (names.has('IF - Result PASS?')) {
    fail(`${label} PASS branch`, `expected Prep scheduling, got ${passOut || 'none'}`);
  }
}

async function queryPassSessions() {
  console.log('\n--- Production PASS sessions (scheduling_status) ---');
  const url =
    `${SUPABASE_URL}/rest/v1/assessment_sessions` +
    '?select=id,candidate_email,result,score,status,scheduling_status,updated_at' +
    '&result=eq.PASS&order=updated_at.desc&limit=10';

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
    },
  });
  if (!res.ok) {
    fail('Supabase query', `HTTP ${res.status}`);
    return;
  }
  const rows = await res.json();
  if (!rows.length) {
    warn('No PASS sessions found', 'cannot verify scheduling_status in prod');
    return;
  }

  let scheduled = 0;
  let stuck = 0;
  for (const row of rows) {
    const st = row.scheduling_status || 'none';
    const good = ['pending', 'slots_proposed', 'candidate_invited', 'confirmed', 'done'].includes(st);
    if (good) scheduled += 1;
    else stuck += 1;
    console.log(
      `  ${row.candidate_email?.slice(0, 28).padEnd(28)} score=${row.score ?? '?'} scheduling=${st} updated=${row.updated_at?.slice(0, 19)}`
    );
  }

  if (stuck === rows.length) {
    fail('All recent PASS sessions', `scheduling_status still none/default (${stuck}/${rows.length})`);
  } else if (stuck > 0) {
    warn('Mixed scheduling state', `${scheduled} progressed, ${stuck} stuck at none`);
  } else {
    ok(`Recent PASS sessions show scheduling progress (${scheduled}/${rows.length})`);
  }
}

function startStaticServer(port) {
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(ROOT, urlPath.replace(/^\//, '').replace(/\.\./g, ''));
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(port, () => resolve(server));
  });
}

async function puppeteerSchedulingProbe(base) {
  console.log('\n--- Puppeteer: portal finish view (network) ---');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const schedulingCalls = [];
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (/scheduling-slots|scheduling-confirmed|Prep scheduling|live-speech-complete/i.test(u)) {
        schedulingCalls.push({ method: req.method(), url: u });
      }
      req.continue();
    });

    await page.goto(`${base}/index.html`, { waitUntil: 'networkidle2', timeout: 60000 });

    // Simulate finished PASS — portal polls Supabase only; should NOT POST scheduling webhooks.
    await page.evaluate(() => {
      sessionStorage.setItem('current_session_id', '00000000-0000-0000-0000-000000000001');
      sessionStorage.setItem('candidate_email', 'scheduling-test@example.com');
    });

    await page.goto(
      `${base}/index.html?session=00000000-0000-0000-0000-000000000001&email=scheduling-test@example.com`,
      { waitUntil: 'networkidle2', timeout: 60000 }
    );
    await new Promise((r) => setTimeout(r, 3000));

    const portalTriggersScheduling = schedulingCalls.some((c) =>
      /scheduling-slots|scheduling-confirmed/i.test(c.url)
    );
    if (portalTriggersScheduling) {
      fail('Portal should not POST scheduling webhooks on finish', JSON.stringify(schedulingCalls));
    } else {
      ok('Portal finish flow does not POST scheduling-slots / scheduling-confirmed (server-side n8n expected)');
    }

    const hasLiveComplete = schedulingCalls.some((c) => /live-speech-complete/i.test(c.url));
    if (hasLiveComplete) {
      warn('live-speech-complete seen during page load', 'relay/n8n only on session.end, not idle load');
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('=== Scheduling trigger diagnosis ===\n');

  workflowSchedulingChain(
    loadWorkflow('Talent Acquisition — Live Speech.json'),
    'Live Speech'
  );
  workflowSchedulingChain(
    loadWorkflow('Talent Acquisition — Assessment + Speech + Scheduling.json'),
    'Assessment + Speech + Scheduling'
  );

  if (useProd) {
    await queryPassSessions();
  } else {
    warn('Skip prod Supabase query', 'run with --prod to check recent PASS sessions');
  }

  let server;
  const base = useProd ? 'https://talent-acquisition-six.vercel.app' : 'http://127.0.0.1:9876';
  if (!useProd) server = await startStaticServer(9876);
  await puppeteerSchedulingProbe(base);
  if (server) server.close();

  console.log(`\n${failures === 0 ? 'DIAGNOSIS COMPLETE (no unexpected failures)' : failures + ' ISSUE(S) FOUND'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

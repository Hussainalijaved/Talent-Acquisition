/**
 * Puppeteer E2E smoke tests — all public portal pages + JS asset loads.
 * Usage: node scripts/e2e-puppeteer.mjs [--base=https://talent-acquisition-six.vercel.app]
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith('--base='))?.slice(7);
const useLocal = args.includes('--local') || !baseArg;

const PAGES = [
  { path: '/index.html', titleIncludes: 'Assessment', checks: ['#root', 'script[src*="live-speech"]'] },
  { path: '/login.html', titleIncludes: 'Login', checks: ['form', 'input'] },
  { path: '/apply.html', titleIncludes: 'Apply', checks: ['body'] },
  { path: '/careers.html', titleIncludes: 'Careers', checks: ['body'] },
  { path: '/recruiter-intake.html', titleIncludes: 'Talent Admin', checks: ['body'] },
  { path: '/dashboard.html', titleIncludes: 'Talent Admin', checks: ['body'] },
  { path: '/candidate-pick.html', titleIncludes: 'interview time', checks: ['body'] },
  { path: '/scheduling-success.html', titleIncludes: 'CONVO', checks: ['body'] },
  { path: '/screening-results.html', titleIncludes: ['Redirecting', 'Talent Admin'], checks: ['body'] },
  { path: '/setup-admin.html', titleIncludes: 'Admin Setup', checks: ['body'] },
  { path: '/interviewer.html', titleIncludes: 'interview dates', checks: ['body'] },
];

const JS_ASSETS = [
  '/live-speech.js',
  '/speech-assessment.js',
  '/auth-config.js',
  '/portal-ui.css',
];

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
}
function ok(name) {
  console.log(`  ok   - ${name}`);
}

function startStaticServer(port) {
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
  };
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
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(port, () => resolve(server));
  });
}

async function testPage(browser, base, pageDef) {
  const url = `${base}${pageDef.path}`;
  const pg = await browser.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  pg.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      // Ignore benign CDN / favicon noise
      if (/favicon|Failed to load resource.*404/i.test(t)) return;
      errors.push(t);
    }
  });

  let res;
  try {
    res = await pg.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch (e) {
    fail(`${pageDef.path} loads`, e.message);
    await pg.close();
    return;
  }

  if (!res || res.status() >= 400) {
    fail(`${pageDef.path} HTTP status`, String(res?.status()));
    await pg.close();
    return;
  }
  ok(`${pageDef.path} HTTP ${res.status()}`);

  const title = await pg.title();
  const expectedTitles = Array.isArray(pageDef.titleIncludes)
    ? pageDef.titleIncludes
    : [pageDef.titleIncludes];
  const titleOk = expectedTitles.some((t) => title.toLowerCase().includes(t.toLowerCase()));
  if (!titleOk) {
    fail(`${pageDef.path} title`, `expected one of ${expectedTitles.join('|')}, got "${title}"`);
  } else {
    ok(`${pageDef.path} title "${title}"`);
  }

  for (const sel of pageDef.checks) {
    const el = await pg.$(sel);
    if (!el) fail(`${pageDef.path} has ${sel}`, 'missing');
    else ok(`${pageDef.path} has ${sel}`);
  }

  if (errors.length) {
    fail(`${pageDef.path} no JS errors`, errors.slice(0, 3).join(' | '));
  } else {
    ok(`${pageDef.path} no critical JS errors`);
  }

  await pg.close();
}

async function testAssets(base) {
  for (const asset of JS_ASSETS) {
    const res = await fetch(`${base}${asset}`);
    if (!res.ok) fail(`asset ${asset}`, `HTTP ${res.status}`);
    else ok(`asset ${asset} (${res.headers.get('content-length') || '?'} bytes)`);
  }
}

async function testIndexAssessmentShell(browser, base) {
  const pg = await browser.newPage();
  await pg.goto(`${base}/index.html`, { waitUntil: 'networkidle2', timeout: 60000 });
  await pg.waitForSelector('#root', { timeout: 30000 });

  const hasLiveSpeech = await pg.evaluate(() => typeof window.TA_LIVE !== 'undefined');
  if (!hasLiveSpeech) fail('index.html exposes TA_LIVE', 'live-speech.js not loaded');
  else ok('index.html exposes window.TA_LIVE');

  const hasSanitize = await pg.evaluate(() => typeof window.TA_LIVE?.sanitizeDisplayTranscript === 'function');
  if (!hasSanitize) fail('TA_LIVE.sanitizeDisplayTranscript', 'missing');
  else ok('TA_LIVE.sanitizeDisplayTranscript exists');

  await pg.close();
}

async function main() {
  let server;
  let base = baseArg || 'http://127.0.0.1:9876';

  if (useLocal) {
    server = await startStaticServer(9876);
    console.log('=== E2E Puppeteer (local static server :9876) ===\n');
  } else {
    console.log(`=== E2E Puppeteer (${base}) ===\n`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    await testAssets(base);
    console.log('');
    for (const p of PAGES) {
      await testPage(browser, base, p);
    }
    console.log('');
    await testIndexAssessmentShell(browser, base);
  } finally {
    await browser.close();
    if (server) server.close();
  }

  console.log(`\n${failures === 0 ? 'ALL E2E PASS' : failures + ' E2E FAILURES'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

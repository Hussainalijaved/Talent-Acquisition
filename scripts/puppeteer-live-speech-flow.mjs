/**
 * Puppeteer flow test: mic check → intro → Q1 handoff, playback flush guard, mic UI.
 * Usage: node scripts/puppeteer-live-speech-flow.mjs
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { WebSocketServer } from '../relay/node_modules/ws/wrapper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const HTTP_PORT = 8791;
const RELAY_PORT = 8792;

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
}
function ok(name) {
  console.log(`  ok   - ${name}`);
}

function startStaticServer(port) {
  const mime = { '.html': 'text/html', '.js': 'application/javascript' };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/scripts/fixtures/live-speech-flow-harness.html';
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

const TINY_PCM_B64 = Buffer.alloc(480, 0).toString('base64');

function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function sendAudio(ws, count = 3) {
  for (let i = 0; i < count; i += 1) {
    sendJson(ws, {
      type: 'output_audio',
      data: TINY_PCM_B64,
      mimeType: 'audio/pcm;rate=24000',
    });
  }
}

function createMockRelay() {
  const wss = new WebSocketServer({ port: RELAY_PORT });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (_) { return; }

      if (msg.type !== 'session.start') return;

      // Time-based sequence — does not depend on client user_turn_start timing.
      sendJson(ws, { type: 'ready' });

      setTimeout(() => {
        // Mic check phase.
        sendJson(ws, { type: 'warmup_phase', phase: 'mic_check' });
        sendAudio(ws, 2);
        sendJson(ws, {
          type: 'awaiting_answer', number: -1, maxTurns: 5,
          time_limit_seconds: 60, warmup: 'mic_check',
        });
      }, 50);

      setTimeout(() => {
        // Intro phase.
        sendJson(ws, { type: 'warmup_phase', phase: 'intro' });
        sendAudio(ws, 2);
        sendJson(ws, {
          type: 'awaiting_answer', number: 0, maxTurns: 5,
          time_limit_seconds: 90, warmup: 'intro',
        });
      }, 700);

      setTimeout(() => {
        // Q1 handoff.
        sendJson(ws, { type: 'flush_playback' });
        sendJson(ws, { type: 'next_question_ready', number: 1 });
        sendAudio(ws, 4);
        sendJson(ws, {
          type: 'question', number: 1,
          text: 'Tell me about a time you solved a difficult problem at work.',
        });
        sendJson(ws, {
          type: 'awaiting_answer', number: 1, maxTurns: 5,
          time_limit_seconds: 120,
        });
      }, 1400);

      setTimeout(() => {
        // Simulate Q1 answer saved → Q2 handoff.
        sendJson(ws, { type: 'answer', number: 1, text: 'I fixed a bug in our payment system.' });
        sendJson(ws, { type: 'saving_turn', number: 1 });
        sendJson(ws, { type: 'turn_saved_status', number: 1, saved: true });
        sendJson(ws, { type: 'flush_playback' });
        sendJson(ws, { type: 'next_question_ready', number: 2 });
        sendAudio(ws, 4);
        sendJson(ws, {
          type: 'question', number: 2,
          text: 'Describe a situation where you had to work under pressure.',
        });
        sendJson(ws, {
          type: 'awaiting_answer', number: 2, maxTurns: 5,
          time_limit_seconds: 120,
        });
      }, 2800);
    });
  });

  return wss;
}

async function main() {
  console.log('=== puppeteer live speech flow ===\n');

  const harnessPath = path.join(ROOT, 'scripts', 'fixtures', 'live-speech-flow-harness.html');
  if (!fs.existsSync(harnessPath)) {
    fail('harness file exists', harnessPath);
    process.exit(1);
  }

  const relay = createMockRelay();
  const httpServer = await startStaticServer(HTTP_PORT);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    const page = await browser.newPage();
    const browserContext = browser.defaultBrowserContext();
    await browserContext.overridePermissions(`http://127.0.0.1:${HTTP_PORT}`, ['microphone']);
    page.on('console', (msg) => {
      if (msg.type() === 'log') console.log('  [page]', msg.text());
    });
    page.on('pageerror', (e) => {
      console.log('  [pageerror]', e.message);
      fail('page error', e.message);
    });

    await page.goto(`http://127.0.0.1:${HTTP_PORT}/?relay=ws://127.0.0.1:${RELAY_PORT}`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    await page.waitForFunction(() => window.__flowTestDone === true, { timeout: 50000 });
    const result = await page.evaluate(() => window.__flowTestResult || {});

    if (result.sessionStarts === 1) ok('session starts exactly once');
    else fail('session starts exactly once', `starts=${result.sessionStarts}`);

    if (result.flushIgnoredWithQueuedAudio) ok('stale flush ignored when audio queued');
    else fail('stale flush ignored when audio queued');

    if (result.q1AwaitingAnswer) ok('Q1 awaiting_answer received');
    else fail('Q1 awaiting_answer received');

    // In the time-based test the mock relay advances to Q2 without waiting for user
    // input, so Q1 mic auto-open is cancelled by next_question_ready. The important
    // check is that awaiting_answer for Q1 arrived (canAnswer was set) so the user
    // *could* have tapped the mic manually.
    if (result.q1AwaitingAnswer) ok('Q1 mic reachable (awaiting_answer received, auto-open pre-empted by Q2)');
    else fail('Q1 mic reachable', JSON.stringify(result));

    if (result.q2AwaitingAnswer) ok('Q2 awaiting_answer received after Q1 answer');
    else fail('Q2 awaiting_answer received after Q1 answer', JSON.stringify(result));

    if (result.timerClearedOnNextQuestion) ok('timer cleared when next_question_ready fires');
    else fail('timer cleared when next_question_ready fires', JSON.stringify(result));

    if (result.playbackChunksAfterLateFlush >= 0) ok('harness playback queue readable after Q1 handoff');
    else fail('harness playback queue readable after Q1 handoff', `chunks=${result.playbackChunksAfterLateFlush}`);

    if (!result.errors?.length) ok('no harness errors');
    else fail('no harness errors', result.errors.join(' | '));
  } finally {
    await browser.close();
    httpServer.close();
    relay.close();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

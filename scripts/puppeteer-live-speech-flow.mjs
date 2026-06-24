/**
 * E2E: live speech mic handoff after Q1 (realistic relay message ordering).
 * Reproduces: audio → question → awaiting_answer (not batched together).
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTTP_PORT = 8791;
const RELAY_PORT = 8792;

const TINY_PCM_B64 = Buffer.from(new Int16Array([0, 0, 0, 0]).buffer).toString('base64');

let failures = 0;
function ok(label) { console.log(`  ok   - ${label}`); }
function fail(label, detail = '') {
  failures += 1;
  console.log(`  FAIL - ${label}${detail ? ` :: ${detail}` : ''}`);
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendAudio(ws, count = 2) {
  for (let i = 0; i < count; i += 1) {
    sendJson(ws, { type: 'output_audio', data: TINY_PCM_B64, mimeType: 'audio/pcm;rate=24000' });
  }
}

function startStaticServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url?.split('?')[0] || '/';
      let filePath = path.join(ROOT, urlPath === '/' ? 'scripts/fixtures/live-speech-flow-harness.html' : urlPath.slice(1));
      if (!fs.existsSync(filePath)) {
        res.writeHead(404); res.end('not found'); return;
      }
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(port, () => resolve(server));
  });
}

function createMockRelay() {
  const wss = new WebSocketServer({ port: RELAY_PORT });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (_) { return; }
      if (msg.type !== 'session.start') return;

      sendJson(ws, { type: 'ready' });

      // Mic check
      setTimeout(() => {
        sendJson(ws, { type: 'warmup_phase', phase: 'mic_check' });
        sendAudio(ws, 2);
        sendJson(ws, {
          type: 'awaiting_answer', number: -1, maxTurns: 5,
          time_limit_seconds: 60, warmup: 'mic_check',
        });
      }, 50);

      // Intro
      setTimeout(() => {
        sendJson(ws, { type: 'warmup_phase', phase: 'intro' });
        sendAudio(ws, 2);
        sendJson(ws, {
          type: 'awaiting_answer', number: 0, maxTurns: 5,
          time_limit_seconds: 90, warmup: 'intro',
        });
      }, 700);

      // Q1 — realistic order: next_question_ready + audio FIRST, question LATER, awaiting_answer LAST
      setTimeout(() => {
        sendJson(ws, { type: 'flush_playback' });
        sendJson(ws, { type: 'next_question_ready', number: 1 });
        sendAudio(ws, 6);
      }, 1400);

      setTimeout(() => {
        sendJson(ws, {
          type: 'question', number: 1,
          text: 'Tell me about a time you solved a difficult problem at work.',
        });
      }, 2200);

      setTimeout(() => {
        sendJson(ws, {
          type: 'awaiting_answer', number: 1, maxTurns: 5,
          time_limit_seconds: 120,
        });
      }, 2600);

      // Q2 handoff after simulated Q1 answer
      setTimeout(() => {
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
      }, 4200);
    });
  });

  return wss;
}

async function main() {
  console.log('=== puppeteer live speech flow ===\n');

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
    await browser.defaultBrowserContext().overridePermissions(`http://127.0.0.1:${HTTP_PORT}`, ['microphone']);
    page.on('pageerror', (e) => fail('page error', e.message));

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

    if (result.q1MicOpened) ok('mic opens after Q1 (realistic audio→question→awaiting order)');
    else fail('mic opens after Q1', JSON.stringify(result));

    if (result.q1MicAfterQuestionOrder) ok('mic opens after question then awaiting_answer');
    else fail('mic opens after question then awaiting_answer', JSON.stringify(result));

    if (result.q2AwaitingAnswer) ok('Q2 awaiting_answer received after Q1 answer');
    else fail('Q2 awaiting_answer received', JSON.stringify(result));

    if (result.timerClearedOnNextQuestion) ok('timer cleared when next_question_ready fires');
    else fail('timer cleared when next_question_ready fires', JSON.stringify(result));

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

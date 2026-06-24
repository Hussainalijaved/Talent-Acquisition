/**
 * E2E: full live-speech flow (mic check -> intro -> Q1..Q5) against a stateful
 * mock relay. Verifies the candidate's mic opens for EVERY question and that
 * each answer advances to the next question (the recurring "stuck at Q2" bug).
 *
 * Realistic ordering: for each question the relay sends audio chunks FIRST,
 * then the `question` text, then `awaiting_answer` — and advances only when the
 * client sends `user_turn_end` (i.e. the candidate actually answered).
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
const TOTAL_Q = 5;

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
function sendAudio(ws, count = 4) {
  for (let i = 0; i < count; i += 1) {
    sendJson(ws, { type: 'output_audio', data: TINY_PCM_B64, mimeType: 'audio/pcm;rate=24000' });
  }
}

function startStaticServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url?.split('?')[0] || '/';
      const filePath = path.join(ROOT, urlPath === '/' ? 'scripts/fixtures/live-speech-flow-harness.html' : urlPath.slice(1));
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
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
    let currentQ = 0; // 0 = warmup, 1..5 = real questions

    const askQuestion = (qNum) => {
      currentQ = qNum;
      sendJson(ws, { type: 'flush_playback' });
      sendJson(ws, { type: 'next_question_ready', number: qNum });
      // Audio first, THEN question text, THEN awaiting_answer (realistic order).
      sendAudio(ws, 5);
      setTimeout(() => {
        sendJson(ws, { type: 'question', number: qNum, text: `Interview question ${qNum}: tell me about a relevant experience.` });
      }, 300);
      setTimeout(() => {
        sendJson(ws, { type: 'awaiting_answer', number: qNum, maxTurns: TOTAL_Q, time_limit_seconds: 120 });
      }, 600);
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (_) { return; }

      if (msg.type === 'session.start') {
        sendJson(ws, { type: 'ready' });
        // Mic check.
        setTimeout(() => {
          sendJson(ws, { type: 'warmup_phase', phase: 'mic_check' });
          sendAudio(ws, 2);
          sendJson(ws, { type: 'awaiting_answer', number: -1, maxTurns: TOTAL_Q, time_limit_seconds: 60, warmup: 'mic_check' });
        }, 50);
        // Intro.
        setTimeout(() => {
          sendJson(ws, { type: 'warmup_phase', phase: 'intro' });
          sendAudio(ws, 2);
          sendJson(ws, { type: 'awaiting_answer', number: 0, maxTurns: TOTAL_Q, time_limit_seconds: 90, warmup: 'intro' });
        }, 900);
        // Q1.
        setTimeout(() => askQuestion(1), 1800);
        return;
      }

      // Candidate finished an answer.
      if (msg.type === 'user_turn_end') {
        if (currentQ >= 1 && currentQ <= TOTAL_Q) {
          const answered = currentQ;
          sendJson(ws, { type: 'answer', number: answered, text: `Answer to question ${answered}.` });
          sendJson(ws, { type: 'saving_turn', number: answered });
          sendJson(ws, { type: 'turn_saved_status', number: answered, saved: true });
          if (answered < TOTAL_Q) {
            setTimeout(() => askQuestion(answered + 1), 400);
          } else {
            currentQ = 0;
            setTimeout(() => {
              sendJson(ws, { type: 'interview_complete', turn: TOTAL_Q, maxTurns: TOTAL_Q });
            }, 400);
          }
        }
      }
    });
  });

  return wss;
}

async function main() {
  console.log('=== puppeteer live speech full flow (Q1..Q5) ===\n');

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

    await page.waitForFunction(() => window.__flowTestDone === true, { timeout: 55000 });
    const r = await page.evaluate(() => window.__flowTestResult || {});

    if (r.sessionStarts === 1) ok('session starts exactly once');
    else fail('session starts exactly once', `starts=${r.sessionStarts}`);

    if (r.flushIgnoredWithQueuedAudio) ok('stale flush ignored when audio queued');
    else fail('stale flush ignored when audio queued');

    if (r.micCheckOpened) ok('mic check mic opened'); else fail('mic check mic opened', JSON.stringify(r));
    if (r.introOpened) ok('intro mic opened'); else fail('intro mic opened', JSON.stringify(r));

    for (let q = 1; q <= TOTAL_Q; q += 1) {
      if (r.awaitingByQ?.[q]) ok(`Q${q} awaiting_answer received`);
      else fail(`Q${q} awaiting_answer received`, JSON.stringify(r.awaitingByQ));

      if (r.micOpenByQ?.[q]) ok(`Q${q} mic opened for candidate`);
      else fail(`Q${q} mic opened for candidate`, JSON.stringify(r.micOpenByQ));

      if (r.answeredByQ?.[q]) ok(`Q${q} answer advanced the interview`);
      else fail(`Q${q} answer advanced the interview`, JSON.stringify(r.answeredByQ));
    }

    if (r.interviewComplete) ok('interview completed after Q5');
    else fail('interview completed after Q5', JSON.stringify(r));

    if (!r.errors?.length) ok('no harness errors');
    else fail('no harness errors', r.errors.join(' | '));
  } finally {
    await browser.close();
    httpServer.close();
    relay.close();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

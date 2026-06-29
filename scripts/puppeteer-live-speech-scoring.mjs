/**
 * Verify whether live speech scoring uses voice (PCM→WAV) or text transcription only.
 *
 * Usage: node scripts/puppeteer-live-speech-scoring.mjs
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchPuppeteer } from './puppeteer-launch.mjs';
import { scoreSingleTurn } from '../relay/lib/score-turns.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
}
function ok(name) {
  console.log(`  ok   - ${name}`);
}
function note(name) {
  console.log(`  note - ${name}`);
}

function startStaticServer(port) {
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript' };
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

function mockGeminiScoreResponse() {
  return JSON.stringify({
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            phase: 6,
            score: 72,
            communication_clarity: 70,
            fluency: 68,
            confidence: 74,
            professionalism: 71,
            english_proficiency: 69,
            answer_relevance: 73,
            feedback: 'Clear structured answer.',
          }),
        }],
      },
    }],
  });
}

async function captureGeminiRequest(fn) {
  let capturedBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(mockGeminiScoreResponse(), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(url, init);
  };
  try {
    const result = await fn();
    return { capturedBody, result };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function geminiParts(body) {
  return body?.contents?.[0]?.parts || [];
}

async function testAudioPrimaryWhenPcmPresent() {
  console.log('\n=== Relay scoreSingleTurn — WITH PCM chunks (voice path) ===');

  const fakePcm = Buffer.alloc(3200, 0).toString('base64');
  const { capturedBody, result } = await captureGeminiRequest(() =>
    scoreSingleTurn({
      apiKey: 'test-key',
      context: { requisition_title: 'Junior Frontend Developer' },
      turn: {
        phase: 6,
        voice_question_number: 1,
        question_text: 'Why are you interested in this role?',
        answer_text: 'I enjoy building user interfaces and collaborating with product teams.',
        answer_pcm_chunks: [fakePcm],
        answer_pcm_sample_rate: 16000,
      },
    })
  );

  if (!capturedBody) {
    fail('Gemini scoring API called with PCM turn');
    return;
  }

  const parts = geminiParts(capturedBody);
  const hasAudio = parts.some((p) => p.inline_data || p.inlineData);
  const textPart = parts.map((p) => p.text || '').join('\n');

  if (hasAudio) ok('Gemini request includes WAV inline_data — voice is scored');
  else fail('expected audio inline_data when answer_pcm_chunks present');

  if (/score the AUDIO above/i.test(textPart)) ok('prompt tells model to score from audio');
  else fail('audio scoring prompt missing');

  if (result.scoring_source === 'audio_primary') ok('scoring_source = audio_primary');
  else fail('scoring_source', String(result.scoring_source));
}

async function testTranscriptOnlyWithoutPcm() {
  console.log('\n=== Relay scoreSingleTurn — transcript only (no PCM) ===');

  const answer =
    'I am interested because I enjoy building user interfaces and collaborating with product teams.';
  const { capturedBody, result } = await captureGeminiRequest(() =>
    scoreSingleTurn({
      apiKey: 'test-key',
      context: { requisition_title: 'Junior Frontend Developer' },
      turn: {
        phase: 6,
        question_text: 'Why are you interested in this role?',
        answer_text: answer,
      },
    })
  );

  if (!capturedBody) {
    fail('Gemini scoring API called for transcript-only turn');
    return;
  }

  const parts = geminiParts(capturedBody);
  const hasAudio = parts.some((p) => p.inline_data || p.inlineData);
  const textPart = parts.map((p) => p.text || '').join('\n');

  if (!hasAudio) ok('no audio in Gemini request when PCM missing');
  else fail('unexpected audio inline_data without PCM chunks');

  if (/score based on the transcript alone/i.test(textPart)) ok('prompt says transcript-only fallback');
  else fail('transcript-only prompt missing');

  if (textPart.includes(answer)) ok('prompt contains answer_text');
  else fail('prompt missing answer_text');

  if (result.scoring_source === 'transcript_only') ok('scoring_source = transcript_only');
  else fail('scoring_source', String(result.scoring_source));
}

async function testEmptyTranscriptScoresZero() {
  console.log('\n=== Empty / placeholder transcript ===');

  const originalFetch = globalThis.fetch;
  let apiCalled = false;
  globalThis.fetch = async (...args) => {
    apiCalled = true;
    return originalFetch(...args);
  };

  try {
    const scored = await scoreSingleTurn({
      apiKey: 'test-key',
      context: { requisition_title: 'Test Role' },
      turn: {
        phase: 6,
        question_text: 'Tell me about yourself?',
        answer_text: '[No spoken response captured]',
      },
    });

    if (apiCalled) fail('Gemini API called for empty transcript');
    else ok('no Gemini call when nothing to score');

    if (scored.score === 0) ok('empty transcript → score 0');
    else fail('empty transcript score', String(scored.score));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testPuppeteerClientPipeline() {
  console.log('\n=== Puppeteer — browser client wiring ===');

  const port = 9876 + Math.floor(Math.random() * 200);
  const server = await startStaticServer(port);
  const base = `http://127.0.0.1:${port}`;

  const browser = await launchPuppeteer({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const tracked = { scoreSpeech: 0 };

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('/api/score-speech')) {
        tracked.scoreSpeech += 1;
        req.respond({ status: 204, body: '' });
        return;
      }
      req.continue();
    });

    await page.goto(`${base}/index.html`, { waitUntil: 'networkidle0', timeout: 30000 });

    const clientFacts = await page.evaluate(async (origin) => {
      const liveSpeech = await fetch(`${origin}/live-speech.js`).then((r) => r.text());
      const speechAssessment = await fetch(`${origin}/speech-assessment.js`).then((r) => r.text());
      return {
        liveSpeechUsesScoreSpeechApi: /score-speech/i.test(liveSpeech),
        liveSpeechStreamsMicToWs: /type:\s*['"]input_audio['"]/.test(liveSpeech),
        hasLiveSessionClass: /class LiveSpeechSession/.test(liveSpeech),
        legacySpeechUsesScoreSpeech: /score-speech/i.test(speechAssessment),
      };
    }, base);

    if (clientFacts.hasLiveSessionClass) ok('LiveSpeechSession present in live-speech.js');
    else fail('LiveSpeechSession missing');

    if (!clientFacts.liveSpeechUsesScoreSpeechApi) {
      ok('Live speech UI does NOT call /api/score-speech (scoring is relay-side)');
    } else fail('live-speech.js still references score-speech');

    if (clientFacts.liveSpeechStreamsMicToWs) {
      ok('mic PCM streamed to relay WebSocket (buffered for voice scoring)');
    } else fail('input_audio WebSocket path missing');

    if (clientFacts.legacySpeechUsesScoreSpeech) {
      note('legacy SpeechView still uses /api/score-speech — separate from LiveSpeechView');
    }

    if (tracked.scoreSpeech === 0) ok('page load did not hit /api/score-speech');
    else fail('unexpected score-speech requests', String(tracked.scoreSpeech));

    const relaySource = fs.readFileSync(path.join(ROOT, 'relay/lib/gemini-live.mjs'), 'utf8');
    if (/answer_pcm_chunks:\s*pcmChunks/.test(relaySource)) {
      ok('relay buffers answer_pcm_chunks on each turn');
    } else fail('relay PCM buffering not found');

    const serverSource = fs.readFileSync(path.join(ROOT, 'relay/server.mjs'), 'utf8');
    if (/includes answer_pcm_chunks for audio scoring/.test(serverSource)) {
      ok('relay server passes PCM chunks into scoreTurnGuaranteed');
    } else fail('relay server scoring wiring missing');
  } finally {
    await browser.close();
    server.close();
  }
}

async function main() {
  console.log('=== Live speech scoring source verification ===');
  await testAudioPrimaryWhenPcmPresent();
  await testTranscriptOnlyWithoutPcm();
  await testEmptyTranscriptScoresZero();
  await testPuppeteerClientPipeline();

  console.log('\n--- Summary ---');
  if (failures === 0) {
    console.log(
      'Live speech (Gemini Live relay): scoring is VOICE-FIRST — PCM→WAV sent to Gemini.\n' +
        'Transcript is supplementary; transcript_only runs only when PCM is missing or audio scoring fails.'
    );
  } else {
    console.log(`${failures} check(s) failed — review output above.`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

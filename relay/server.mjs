import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GeminiLiveBridge } from './lib/gemini-live.mjs';
import { postCompleteWebhook, scoreLiveTurns } from './lib/score-turns.mjs';

const PORT = Number(process.env.PORT || 8080);
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!GEMINI_API_KEY) {
  console.warn('[relay] WARNING: GEMINI_API_KEY not set — live sessions will fail.');
}

function corsOk(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(o));
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'talent-live-speech-relay',
    ws_path: '/live',
    health: '/health',
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    gemini_key: !!GEMINI_API_KEY,
    port: PORT,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/live') {
    socket.destroy();
    return;
  }
  const origin = req.headers.origin || '';
  if (!corsOk(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (clientWs) => {
  let bridge = null;
  let context = null;
  let finishing = false;

  sendJson(clientWs, { type: 'hello', message: 'Send session.start with n8n live-speech-start context' });

  clientWs.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      sendJson(clientWs, { type: 'error', message: 'invalid_json' });
      return;
    }

    try {
      if (msg.type === 'session.start') {
        if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured on relay server');
        context = msg.context || {};
        bridge = new GeminiLiveBridge({
          apiKey: GEMINI_API_KEY,
          context,
          onEvent: (ev) => sendJson(clientWs, ev),
        });
        await bridge.start();
        return;
      }

      if (msg.type === 'user_turn_start') {
        if (!bridge) throw new Error('session not started');
        bridge.startUserTurn();
        return;
      }

      if (msg.type === 'user_turn_end') {
        if (!bridge) throw new Error('session not started');
        bridge.endUserTurn();
        return;
      }

      if (msg.type === 'input_audio') {
        if (!bridge) throw new Error('session not started');
        bridge.sendAudio(msg.data, msg.mimeType || 'audio/pcm;rate=16000');
        return;
      }

      if (msg.type === 'session.end') {
        if (finishing) return;
        finishing = true;
        if (!bridge || !context) throw new Error('session not started');

        bridge.closeGemini();
        const rawTurns = bridge.buildTurnPairs();

        let scored = {
          turns: rawTurns,
          combined_speech_score: 0,
          final_feedback: 'Voice interview completed.',
        };
        try {
          scored = await Promise.race([
            scoreLiveTurns({ apiKey: GEMINI_API_KEY, context, turns: rawTurns }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('score_timeout')), 45000)
            ),
          ]);
        } catch (scoreErr) {
          console.warn('[relay] score fallback:', scoreErr.message);
          scored = {
            turns: rawTurns.map((t) => ({ ...t, score: 0, feedback: 'Scored locally after timeout.' })),
            combined_speech_score: 0,
            final_feedback: 'Voice interview completed. Detailed scoring was delayed.',
          };
        }

        const durationSeconds = Math.round((Date.now() - bridge.startedAt) / 1000);
        const completePayload = {
          session_id: context.session_id,
          email: context.candidate_email || msg.email,
          turns: scored.turns,
          combined_speech_score: scored.combined_speech_score,
          duration_seconds: durationSeconds,
          final_feedback: scored.final_feedback,
          tab_switches: Number(msg.tab_switches || 0),
        };

        let webhookResult = { ok: false, skipped: true };
        try {
          webhookResult = await postCompleteWebhook(context, completePayload);
        } catch (whErr) {
          webhookResult = { ok: false, error: whErr.message };
        }

        sendJson(clientWs, {
          type: 'session.complete',
          ok: true,
          turns: scored.turns.length,
          combined_speech_score: scored.combined_speech_score,
          final_feedback: scored.final_feedback,
          webhook: webhookResult,
          n8n: webhookResult.body || null,
        });
        clientWs.close();
        return;
      }

      sendJson(clientWs, { type: 'error', message: `unknown_message_type:${msg.type}` });
    } catch (err) {
      console.error('[relay] session error:', err);
      sendJson(clientWs, { type: 'error', message: err.message || 'relay_error' });
    }
  });

  clientWs.on('close', () => {
    if (bridge) bridge.closeGemini();
  });
});

server.listen(PORT, () => {
  console.log(`[relay] Talent Live Speech relay on http://0.0.0.0:${PORT}`);
  console.log(`[relay] WebSocket: ws://localhost:${PORT}/live`);
});

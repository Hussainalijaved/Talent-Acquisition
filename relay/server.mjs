import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GeminiLiveBridge } from './lib/gemini-live.mjs';
import {
  directSavePartialTurn,
  directSaveToSupabase,
  postCompleteWebhook,
  postPartialTurnWebhook,
  scoreLiveTurns,
  scoreSingleTurn,
} from './lib/score-turns.mjs';

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
  let webhookFired = false; // guard: fire complete webhook at most once per session

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
        const supabaseUrl = String(
          context.supabase_url || context.config?.supabase_url || ''
        ).trim();
        if (!supabaseUrl) {
          console.error('[relay] WARNING: supabase_url is EMPTY — voice turns will NOT be saved. Set supabase_url in CFG - Live Speech Config.');
        } else {
          console.log('[relay] direct Supabase save configured:', supabaseUrl);
        }
        const webhookUrl = String(context.live_complete_webhook || process.env.LIVE_COMPLETE_WEBHOOK || '').trim();
        if (webhookUrl) console.log('[relay] n8n webhook (secondary):', webhookUrl);
        bridge = new GeminiLiveBridge({
          apiKey: GEMINI_API_KEY,
          context,
          onEvent: (ev) => sendJson(clientWs, ev),
          onTurnSaved: async (turnPair) => {
            let saved = false;
            let saveError = '';
            try {
              const scored = await scoreSingleTurn({
                apiKey: GEMINI_API_KEY,
                context,
                turn: turnPair,
              });
              // PRIMARY: direct Supabase incremental save (survives crashes).
              await directSavePartialTurn(context, scored);
              saved = true;
              // SECONDARY: n8n webhook for notifications (optional).
              postPartialTurnWebhook(context, {
                session_id: context.session_id,
                email: context.candidate_email,
                turns: [scored],
              }).catch((err) => console.warn('[relay] partial n8n webhook:', err.message));
            } catch (err) {
              console.warn('[relay] partial turn save (scored) failed:', err.message);
              // Scoring failed — still persist transcript unscored so answer is never lost.
              try {
                await directSavePartialTurn(context, {
                  ...turnPair,
                  score: null,
                  feedback: 'Saved without scoring (will be re-scored at the end).',
                });
                saved = true;
              } catch (err2) {
                saveError = err2.message || 'partial_save_failed';
                console.error('[relay] partial turn save failed:', saveError);
              }
            }
            sendJson(clientWs, {
              type: 'turn_saved_status',
              number: turnPair.voice_question_number,
              phase: turnPair.phase,
              saved,
              error: saveError || undefined,
            });
          },
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
        const durationSeconds = Math.round((Date.now() - bridge.startedAt) / 1000);

        // ── Score ──────────────────────────────────────────────────────────────
        let scored = {
          turns: rawTurns.map((t) => ({ ...t, score: 0, feedback: '' })),
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
          console.warn('[relay] scoring fallback:', scoreErr.message);
          scored = {
            turns: rawTurns.map((t) => ({ ...t, score: 0, feedback: 'Scored on next run (timeout).' })),
            combined_speech_score: 0,
            final_feedback: 'Voice interview completed. Scoring timed out — will retry.',
          };
        }

        if (webhookFired) {
          sendJson(clientWs, {
            type: 'session.complete', ok: true,
            turns: scored.turns.length,
            combined_speech_score: scored.combined_speech_score,
            final_feedback: scored.final_feedback,
          });
          clientWs.close();
          return;
        }
        webhookFired = true;

        // ── PRIMARY: Direct Supabase save (no n8n dependency) ─────────────────
        let directResult = { ok: false };
        try {
          directResult = await directSaveToSupabase(context, scored.turns, {
            combinedSpeechScore: scored.combined_speech_score,
            finalFeedback:       scored.final_feedback,
            durationSeconds,
          });
          console.log('[relay] direct Supabase save OK:', directResult);
        } catch (dbErr) {
          console.error('[relay] direct Supabase save FAILED:', dbErr.message);
          directResult = { ok: false, error: dbErr.message };
        }

        // ── SECONDARY: n8n webhook (email / notifications only) ───────────────
        const completePayload = {
          session_id:           context.session_id,
          email:                context.candidate_email || msg.email,
          turns:                scored.turns,
          combined_speech_score: scored.combined_speech_score,
          duration_seconds:     durationSeconds,
          final_feedback:       scored.final_feedback,
          tab_switches:         Number(msg.tab_switches || 0),
        };
        let webhookResult = { ok: false, skipped: true };
        try {
          webhookResult = await postCompleteWebhook(context, completePayload);
        } catch (whErr) {
          console.warn('[relay] n8n webhook (secondary):', whErr.message);
          webhookResult = { ok: false, error: whErr.message };
        }

        sendJson(clientWs, {
          type:                 'session.complete',
          ok:                   directResult.ok,
          saved_to_db:          directResult.ok,
          turns:                scored.turns.length,
          combined_speech_score: scored.combined_speech_score,
          final_feedback:       scored.final_feedback,
          db:                   directResult,
          n8n:                  webhookResult.body || null,
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

  clientWs.on('close', async () => {
    if (bridge) bridge.closeGemini();

    // Fallback: client disconnected before session.end (tab close / network drop).
    // Save whatever turns were captured directly to Supabase — no n8n needed.
    if (webhookFired || !context || !bridge) return;
    const rawTurns = bridge.buildTurnPairs();
    if (!rawTurns.length) {
      console.log('[relay] disconnect: no turns captured, skipping fallback save.');
      return;
    }

    webhookFired = true;
    console.log(`[relay] disconnect fallback save — ${rawTurns.length} turn(s)`);
    const durationSeconds = Math.round((Date.now() - bridge.startedAt) / 1000);
    const fallbackTurns = rawTurns.map((t) => ({
      ...t,
      score: t.score ?? 0,
      feedback: t.feedback || 'Saved on disconnect.',
    }));

    // Direct Supabase (primary, reliable)
    directSaveToSupabase(context, fallbackTurns, {
      combinedSpeechScore: 0,
      finalFeedback: 'Interview ended unexpectedly (connection lost). Answers captured.',
      durationSeconds,
    }).catch((err) => {
      console.error('[relay] disconnect direct Supabase save failed:', err.message);
    });

    // n8n webhook (secondary, for notifications)
    const fallbackPayload = {
      session_id:           context.session_id,
      email:                context.candidate_email,
      turns:                fallbackTurns,
      combined_speech_score: 0,
      duration_seconds:     durationSeconds,
      final_feedback:       'Interview ended unexpectedly. Answers saved directly.',
      tab_switches:         0,
    };
    postCompleteWebhook(context, fallbackPayload).catch((err) => {
      console.warn('[relay] disconnect n8n webhook (secondary) failed:', err.message);
    });
  });
});

server.listen(PORT, () => {
  console.log(`[relay] Talent Live Speech relay on http://0.0.0.0:${PORT}`);
  console.log(`[relay] WebSocket: ws://localhost:${PORT}/live`);
});

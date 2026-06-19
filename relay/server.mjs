import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GeminiLiveBridge } from './lib/gemini-live.mjs';
import {
  directSavePartialTurn,
  directSaveToSupabase,
  enrichTurnsFromDb,
  postCompleteWebhook,
  postPartialTurnWebhook,
  scoreTurnsSequential,
  scoreTurnGuaranteed,
  scoreSingleTurn,
  vercelSaveTurn,
  vercelSaveFinal,
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

async function waitForPendingTurnSaves(getCount, maxMs = 90000) {
  const deadline = Date.now() + maxMs;
  while (getCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
  }
  if (getCount() > 0) {
    console.warn(`[relay] session.end proceeding with ${getCount()} in-flight turn save(s)`);
  }
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
    version: '2.0-direct-supabase',
    env_supabase_url: !!process.env.SUPABASE_URL,
    env_live_webhook: String(process.env.LIVE_COMPLETE_WEBHOOK || '').slice(0, 60) || null,
  });
});

// Diagnostic endpoint — POST {supabase_url, supabase_key} to verify DB connectivity.
app.post('/test-db', async (req, res) => {
  const { supabase_url, supabase_key, table = 'assessment_sessions' } = req.body || {};
  const url = String(supabase_url || process.env.SUPABASE_URL || '').trim();
  const key = String(supabase_key || process.env.SUPABASE_KEY || '').trim();
  if (!url || !key) {
    return res.status(400).json({ ok: false, error: 'supabase_url and supabase_key required' });
  }
  try {
    const r = await fetch(
      `${url.replace(/\/+$/, '')}/rest/v1/${table}?select=id&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const text = await r.text();
    res.json({ ok: r.ok, status: r.status, body: text.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
  let pendingTurnSaves = 0;

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
        const supabaseKey = String(
          context.supabase_key || context.config?.supabase_key || ''
        ).trim();
        const webhookUrl = String(context.live_complete_webhook || process.env.LIVE_COMPLETE_WEBHOOK || '').trim();

        // Diagnostic: tell the client exactly what credentials the relay received.
        sendJson(clientWs, {
          type: 'context_received',
          session_id: context.session_id || null,
          has_supabase_url: !!supabaseUrl,
          has_supabase_key: !!supabaseKey,
          supabase_url_preview: supabaseUrl ? supabaseUrl.slice(0, 40) + '…' : null,
          has_n8n_webhook: !!webhookUrl,
          n8n_webhook_preview: webhookUrl ? webhookUrl.slice(0, 60) + '…' : null,
        });

        if (!supabaseUrl || !supabaseKey) {
          console.error('[relay] FATAL: supabase_url or supabase_key is EMPTY — voice turns CANNOT be saved to the database.');
          console.error('[relay]   supabase_url present:', !!supabaseUrl);
          console.error('[relay]   supabase_key present:', !!supabaseKey);
          console.error('[relay]   Set supabase_url + supabase_key in CFG - Live Speech Config (start) in n8n.');
        } else {
          console.log('[relay] direct Supabase save configured:', supabaseUrl);
        }
        if (webhookUrl) console.log('[relay] n8n webhook (secondary):', webhookUrl);
        bridge = new GeminiLiveBridge({
          apiKey: GEMINI_API_KEY,
          context,
          onEvent: (ev) => sendJson(clientWs, ev),
          onTurnSaved: (turnPair) => {
            pendingTurnSaves += 1;
            void (async () => {
              try {
                // 1. Save transcript immediately.
                const unscored = { ...turnPair, score: null };
                let saved = false;
                let saveError = '';
                try {
                  await vercelSaveTurn(context, unscored);
                  saved = true;
                } catch (vercelErr) {
                  console.warn('[relay] Vercel save failed, trying direct Supabase:', vercelErr.message);
                  try {
                    await directSavePartialTurn(context, unscored);
                    saved = true;
                  } catch (dbErr) {
                    saveError = dbErr.message || 'partial_save_failed';
                    console.error('[relay] ALL partial saves failed:', saveError);
                  }
                }
                sendJson(clientWs, {
                  type: 'turn_saved_status',
                  number: turnPair.voice_question_number,
                  phase: turnPair.phase,
                  saved,
                  error: saveError || undefined,
                });

                // 2. Score — guaranteed, never null (API → heuristic → zero).
                const scored = await scoreTurnGuaranteed({
                  apiKey: GEMINI_API_KEY,
                  context,
                  turn: turnPair,
                });
                try {
                  await vercelSaveTurn(context, scored);
                } catch (vercelErr) {
                  await directSavePartialTurn(context, scored).catch((dbErr) => {
                    console.warn('[relay] scored turn patch failed:', dbErr.message);
                  });
                }
                sendJson(clientWs, {
                  type: 'turn_scored',
                  number: turnPair.voice_question_number,
                  phase: turnPair.phase,
                  score: scored.score,
                  feedback: scored.feedback,
                  soft_skills: scored.soft_skills,
                });
              } finally {
                pendingTurnSaves -= 1;
              }
            })();
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
        await waitForPendingTurnSaves(() => pendingTurnSaves);
        const rawTurns = bridge.buildTurnPairs();
        const durationSeconds = Math.round((Date.now() - bridge.startedAt) / 1000);

        // Merge DB scores, then guarantee every unscored turn gets a score.
        let turns = await enrichTurnsFromDb(context, rawTurns);
        const unscored = turns.filter(
          (t) => t.score == null || !Number.isFinite(Number(t.score))
        );
        if (unscored.length > 0) {
          console.log(`[relay] final pass: scoring ${unscored.length} turn(s)`);
          const freshlyScored = await scoreTurnsSequential({
            apiKey: GEMINI_API_KEY,
            context,
            turns: unscored,
            timeoutMs: 35000,
          });
          const byPhase = new Map(freshlyScored.map((t) => [Number(t.phase), t]));
          turns = turns.map((t) => byPhase.get(Number(t.phase)) || t);
        }

        const scored = {
          turns,
          combined_speech_score: 0,
          final_feedback: 'Voice interview completed.',
        };

        const allScores = scored.turns
          .map((t) => Number(t.score))
          .filter((n) => Number.isFinite(n) && n >= 0);
        scored.combined_speech_score = allScores.length
          ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
          : 0;
        if (allScores.length) {
          scored.final_feedback = `Voice interview completed. Average communication score: ${scored.combined_speech_score}/100 across ${allScores.length} question${allScores.length === 1 ? '' : 's'}.`;
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

        // ── PRIMARY: Vercel API save (always reachable from Railway) ──────────
        let finalResult = { ok: false };
        try {
          finalResult = await vercelSaveFinal(context, scored.turns, {
            combinedSpeechScore: scored.combined_speech_score,
            finalFeedback:       scored.final_feedback,
            durationSeconds,
            tabSwitches:         Number(msg.tab_switches || 0),
          });
        } catch (vercelErr) {
          console.warn('[relay] Vercel final save failed, trying direct Supabase:', vercelErr.message);
          // ── FALLBACK: direct Supabase ───────────────────────────────────────
          try {
            finalResult = await directSaveToSupabase(context, scored.turns, {
              combinedSpeechScore: scored.combined_speech_score,
              finalFeedback:       scored.final_feedback,
              durationSeconds,
            });
          } catch (dbErr) {
            console.error('[relay] ALL final saves FAILED:', dbErr.message);
            finalResult = { ok: false, error: dbErr.message };
          }
        }

        // ── SECONDARY: n8n webhook (email / notifications only) ───────────────
        const completePayload = {
          session_id:            context.session_id,
          email:                 context.candidate_email || msg.email,
          turns:                 scored.turns,
          combined_speech_score: scored.combined_speech_score,
          duration_seconds:      durationSeconds,
          final_feedback:        scored.final_feedback,
          tab_switches:          Number(msg.tab_switches || 0),
        };
        postCompleteWebhook(context, completePayload).catch((whErr) => {
          console.warn('[relay] n8n webhook (secondary/optional):', whErr.message);
        });

        sendJson(clientWs, {
          type:                  'session.complete',
          ok:                    finalResult.ok,
          saved_to_db:           finalResult.ok,
          turns:                 scored.turns.length,
          combined_speech_score: scored.combined_speech_score,
          final_feedback:        scored.final_feedback,
          save:                  finalResult,
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
      score: t.score ?? null,
      feedback: t.feedback || 'Saved on disconnect.',
    }));

    // Primary: Vercel API (always reachable).
    vercelSaveFinal(context, fallbackTurns, {
      combinedSpeechScore: 0,
      finalFeedback: 'Interview ended unexpectedly (connection lost). Answers captured.',
      durationSeconds,
    }).catch((vercelErr) => {
      console.warn('[relay] disconnect Vercel save failed, trying direct:', vercelErr.message);
      // Fallback: direct Supabase.
      directSaveToSupabase(context, fallbackTurns, {
        combinedSpeechScore: 0,
        finalFeedback: 'Interview ended unexpectedly (connection lost). Answers captured.',
        durationSeconds,
      }).catch((dbErr) => console.error('[relay] disconnect all saves failed:', dbErr.message));
    });
  });
});

server.listen(PORT, () => {
  console.log(`[relay] Talent Live Speech relay on http://0.0.0.0:${PORT}`);
  console.log(`[relay] WebSocket: ws://localhost:${PORT}/live`);
});

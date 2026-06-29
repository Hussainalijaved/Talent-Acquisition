import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GeminiLiveBridge } from './lib/gemini-live.mjs';
import {
  directSavePartialTurn,
  directSaveToSupabase,
  enrichTurnsFromDb,
  ensureSchedulingWebhook,
  postPartialTurnWebhook,
  scoreAllTurnsOverall,
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

// The speech assessment is fully transcription-free for the candidate: no
// question/answer text is ever shown, and only one overall score is reported
// at the end (never per-question). This strips anything transcript-like before
// it reaches the browser, regardless of what the relay produces internally.
function sendToClient(ws, ev) {
  if (!ev || typeof ev !== 'object') return;
  const type = ev.type;
  // Captions / live transcripts — never surface to the candidate.
  if (type === 'transcript' || type === 'question_partial') return;
  // Per-question scores are not shown; scoring is averaged once at the end.
  if (type === 'turn_scored') return;
  // Question/answer flow events keep their number (for the progress bar) but
  // must not carry any spoken text.
  if (type === 'question' || type === 'answer') {
    const { text, ...rest } = ev;
    sendJson(ws, rest);
    return;
  }
  sendJson(ws, ev);
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

async function saveFinalWithRetry(saveFn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await saveFn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      }
    }
  }
  throw lastErr;
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
const activeSessions = new Set();
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[relay] ${signal} received — closing ${activeSessions.size} live session(s)…`);
  wss.close();
  for (const ws of activeSessions) {
    try {
      sendJson(ws, { type: 'error', message: 'server_restarting' });
      ws.close();
    } catch (_) {}
  }
  server.close(() => {
    console.log('[relay] graceful shutdown complete');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('[relay] shutdown timeout — forcing exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
  activeSessions.add(clientWs);
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
        const rawCtx = msg.context || {};
        context = {
          ...rawCtx,
          config: { ...(rawCtx.config || {}) },
        };
        if (!context.supabase_url && process.env.SUPABASE_URL) {
          context.supabase_url = String(process.env.SUPABASE_URL).trim();
        }
        if (!context.supabase_key && (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
          context.supabase_key = String(
            process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
          ).trim();
        }
        if (context.supabase_url && !context.config.supabase_url) {
          context.config.supabase_url = context.supabase_url;
        }
        if (context.supabase_key && !context.config.supabase_key) {
          context.config.supabase_key = context.supabase_key;
        }
        if (!context.live_complete_webhook && context.config?.live_complete_webhook) {
          context.live_complete_webhook = context.config.live_complete_webhook;
        }
        if (!context.n8n_public_url && context.config?.n8n_public_url) {
          context.n8n_public_url = context.config.n8n_public_url;
        }
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
          onEvent: (ev) => sendToClient(clientWs, ev),
          onTurnSaved: async (turnPair) => {
            // DATA SAVE ONLY — no per-question AI scoring during the interview.
            // Scoring runs ONCE at the end (scoreAllTurnsOverall) for a single
            // overall speech score. This also removes heavy in-interview audio
            // scoring calls that previously competed with the live session and
            // could stall question-to-question progression.
            pendingTurnSaves += 1;
            try {
              // Strip raw PCM chunks before DB save (large array, kept in memory for end scoring).
              const unscoredForDb = { ...turnPair, score: null, answer_pcm_chunks: undefined };
              let saved = false;
              let saveError = '';
              try {
                await vercelSaveTurn(context, unscoredForDb);
                saved = true;
              } catch (vercelErr) {
                console.warn('[relay] Vercel save failed, trying direct Supabase:', vercelErr.message);
                try {
                  await directSavePartialTurn(context, unscoredForDb);
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
                follow_up: !!turnPair.is_follow_up,
              });
            } finally {
              pendingTurnSaves -= 1;
            }
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

      if (msg.type === 'playback_idle') {
        if (!bridge) throw new Error('session not started');
        bridge.handleClientPlaybackIdle(Number(msg.number) || 0);
        return;
      }

      if (msg.type === 'question_audio_missing') {
        if (!bridge) throw new Error('session not started');
        bridge.handleQuestionAudioMissing(Number(msg.number) || 0);
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

        // ── OVERALL SCORING — one multimodal call over ALL answers ───────────
        // Single overall speech score (not per-question). The same overall score
        // is written to every turn so the existing save/average pipeline yields it.
        let turns = await enrichTurnsFromDb(context, rawTurns);
        const overall = await scoreAllTurnsOverall({
          apiKey: GEMINI_API_KEY,
          context,
          turns: rawTurns, // rawTurns carry the buffered PCM audio
          timeoutMs: 60000,
        });
        console.log(`[relay] overall speech score ${overall.combined_speech_score} via ${overall.scoring_source}`);

        turns = turns.map((t) => ({
          ...t,
          score: overall.combined_speech_score,
          soft_skills: overall.soft_skills || t.soft_skills,
          feedback: overall.final_feedback || t.feedback,
          scoring_source: overall.scoring_source,
          answer_pcm_chunks: undefined,
        }));

        const scored = {
          turns,
          combined_speech_score: overall.combined_speech_score,
          final_feedback: overall.final_feedback || 'Voice interview completed.',
        };

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
          finalResult = await saveFinalWithRetry(() =>
            vercelSaveFinal(context, scored.turns, {
              combinedSpeechScore: scored.combined_speech_score,
              finalFeedback:       scored.final_feedback,
              durationSeconds,
              tabSwitches:         Number(msg.tab_switches || 0),
            })
          );
        } catch (vercelErr) {
          console.warn('[relay] Vercel final save failed, trying direct Supabase:', vercelErr.message);
          // ── FALLBACK: direct Supabase ───────────────────────────────────────
          try {
            finalResult = await saveFinalWithRetry(() =>
              directSaveToSupabase(context, scored.turns, {
                combinedSpeechScore: scored.combined_speech_score,
                finalFeedback:       scored.final_feedback,
                durationSeconds,
              })
            );
          } catch (dbErr) {
            console.error('[relay] ALL final saves FAILED:', dbErr.message);
            finalResult = { ok: false, error: dbErr.message };
          }
        }

        const finalScore = finalResult.score ?? finalResult.combined ?? null;
        const finalOutcome = finalResult.result || null;
        const vercelWebhookOk = finalResult.complete_webhook_ok === true;

        const completePayload = {
          session_id:            context.session_id,
          email:                 context.candidate_email || msg.email,
          turns:                 scored.turns,
          combined_speech_score: scored.combined_speech_score,
          duration_seconds:      durationSeconds,
          final_feedback:        scored.final_feedback,
          tab_switches:          Number(msg.tab_switches || 0),
          result:                finalOutcome,
          score:                 finalScore,
          technical_score:       finalResult.technical_score ?? finalResult.techAvg ?? null,
          speech_score:          finalResult.speech_score ?? finalResult.speechAvg ?? scored.combined_speech_score,
        };

        // n8n complete webhook — result mail + scheduling. Retries if Vercel missed it
        // or if PASS but scheduling_status is still stuck at "pending".
        let completeWebhookOk = vercelWebhookOk;
        try {
          completeWebhookOk = await ensureSchedulingWebhook(context, completePayload, {
            vercelReportedOk: vercelWebhookOk,
          });
        } catch (whErr) {
          console.error('[relay] n8n complete webhook ensure FAILED:', whErr.message);
          completeWebhookOk = false;
        }

        sendJson(clientWs, {
          type:                  'session.complete',
          ok:                    finalResult.ok,
          saved_to_db:           finalResult.ok,
          result:                finalOutcome,
          score:                 finalScore,
          technical_score:       finalResult.technical_score ?? finalResult.techAvg ?? null,
          speech_score:          finalResult.speech_score ?? finalResult.speechAvg ?? scored.combined_speech_score,
          turns:                 scored.turns.length,
          combined_speech_score: scored.combined_speech_score,
          final_feedback:        scored.final_feedback,
          save:                  finalResult,
          complete_webhook_ok:   completeWebhookOk,
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
    activeSessions.delete(clientWs);
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

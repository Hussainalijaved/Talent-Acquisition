-- Seed n8n webhook URLs for auto-trigger after live speech complete (Vercel fallback).
-- Replace YOUR-N8N-PUBLIC-URL with your active ngrok or production n8n base (no trailing slash).

INSERT INTO app_config (key, value)
VALUES
  ('n8n_public_url', 'https://YOUR-N8N-PUBLIC-URL'),
  (
    'live_complete_webhook',
    'https://YOUR-N8N-PUBLIC-URL/webhook/talent/live-speech-complete'
  )
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

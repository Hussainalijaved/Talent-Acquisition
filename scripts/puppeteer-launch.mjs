/**
 * Launch Puppeteer with bundled Chrome, falling back to system Chrome/Edge on Windows.
 */
import fs from 'fs';
import puppeteer from 'puppeteer';

function mergeArgs(baseArgs, extraArgs = []) {
  return [...new Set([...(baseArgs || []), ...(extraArgs || [])])];
}

async function tryLaunch(options) {
  return puppeteer.launch(options);
}

/**
 * @param {import('puppeteer').LaunchOptions & { args?: string[] }} options
 */
export async function launchPuppeteer(options = {}) {
  const { args: extraArgs, ...rest } = options;
  const base = {
    headless: true,
    args: mergeArgs(['--no-sandbox', '--disable-setuid-sandbox'], extraArgs),
    ...rest,
  };

  try {
    const bundled = puppeteer.executablePath();
    if (bundled && fs.existsSync(bundled)) {
      return await tryLaunch(base);
    }
  } catch (_) {
    /* bundled path unavailable */
  }

  const fallbacks = [
    { channel: 'chrome', label: 'system Google Chrome' },
    { channel: 'msedge', label: 'system Microsoft Edge' },
  ];

  let lastErr;
  for (const fb of fallbacks) {
    try {
      console.warn(`[puppeteer] Bundled Chrome missing — trying ${fb.label}`);
      return await tryLaunch({ ...base, channel: fb.channel });
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error(
    'No Chrome found. Run: npx puppeteer browsers install chrome'
  );
}

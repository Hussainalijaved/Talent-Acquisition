/**
 * Ensures Puppeteer-managed Chrome exists after npm install.
 * Skips quietly when already present; falls back to a helpful message on failure.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

if (process.env.RAILWAY_ENVIRONMENT || process.env.CI === 'true' || process.env.CI === '1') {
  process.exit(0);
}

function bundledChromeExists() {
  try {
    const execPath = puppeteer.executablePath();
    return execPath && fs.existsSync(execPath);
  } catch (_) {
    return false;
  }
}

if (bundledChromeExists()) {
  console.log('[postinstall] Puppeteer Chrome already installed.');
  process.exit(0);
}

console.log('[postinstall] Downloading Puppeteer Chrome (one-time, ~150MB)…');
try {
  execSync('npx puppeteer browsers install chrome', {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (bundledChromeExists()) {
    console.log('[postinstall] Puppeteer Chrome ready.');
    process.exit(0);
  }
} catch (err) {
  console.warn('[postinstall] Could not download Puppeteer Chrome:', err.message || err);
}

console.warn(
  '[postinstall] E2E tests will use system Chrome/Edge if installed. ' +
  'Or run manually: npx puppeteer browsers install chrome'
);

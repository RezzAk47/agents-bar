// UI screenshots with synthetic data (made-up agents, repos and numbers), light and dark, against the Vite build. Output: shots/*.png
// Usage: npm run build && npm run shots
import { chromium } from '@playwright/test';
import { startPreview } from './lib.mjs';
import fs from 'node:fs';

const out = process.env.SHOTS_DIR ?? 'shots';
fs.mkdirSync(out, { recursive: true });
const { child: server, base } = await startPreview(4392);
let browser;
try { browser = await chromium.launch(); } catch (e) { console.error('bundled chromium missing, trying system Chrome:', e.message); browser = await chromium.launch({ channel: 'chrome' }); }

/** Two animation frames after the fonts are ready: the page has painted what it was told to show. */
const settle = (page) => page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
const s = (o) => '&settings=' + encodeURIComponent(JSON.stringify(o));
const tall = { width: 420, height: 1180 };
const shots = [
  { name: 'running-recent', url: '?fixture=demo', viewport: tall },
  { name: 'tokens', url: '?fixture=demo' + s({ agent_metric: 'tokens' }), viewport: tall },
  { name: 'both', url: '?fixture=demo' + s({ agent_metric: 'both' }), viewport: tall },
  { name: 'today', url: '?fixture=demo', viewport: { width: 420, height: 760 }, act: async (p) => { await p.locator('#h-today').scrollIntoViewIfNeeded(); await p.evaluate(() => document.querySelector('#h-today').scrollIntoView({ block: 'start' })); } },
  { name: 'github', url: '?fixture=demo' + s({ pr_alert: 3 }), viewport: { width: 420, height: 760 }, act: async (p) => { await p.waitForSelector('.repo'); await p.evaluate(() => document.querySelector('#h-github').scrollIntoView({ block: 'start' })); } },
  { name: 'settings', url: '?fixture=demo', viewport: { width: 420, height: 1100 }, act: async (p) => {
    await p.getByRole('button', { name: 'Settings' }).click();
    // The browser preview has no data folder and no notification switch; show the wording a real install would not pin to a path.
    await p.evaluate(() => {
      for (const n of document.querySelectorAll('.note')) {
        if (n.textContent.includes('(in memory)')) n.textContent = 'Settings are saved on this computer. Transcripts are only read, never changed.';
        else if (n.textContent.includes('switched off for this run')) n.remove();
      }
    });
  } },
  { name: 'empty', url: '?fixture=empty&gh=missing', viewport: { width: 420, height: 640 } },
  { name: 'gh-login', url: '?fixture=demo&gh=login', viewport: { width: 420, height: 760 }, act: async (p) => { await p.evaluate(() => document.querySelector('#h-github').scrollIntoView({ block: 'start' })); } },
  { name: 'ocean-compact', url: '?fixture=demo' + s({ theme: 'ocean', layout: 'compact', progress: 'ring' }), viewport: { width: 420, height: 900 } },
  { name: 'grape-solid-bar', url: '?fixture=demo' + s({ theme: 'grape', layout: 'solid', progress: 'bar' }), viewport: { width: 420, height: 1100 } },
];
for (const scheme of ['light', 'dark']) {
  for (const sh of shots) {
    const ctx = await browser.newContext({ viewport: sh.viewport, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce', timezoneId: 'America/Vancouver', locale: 'en-CA' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(base + sh.url);
    await page.waitForSelector('html[data-ready="1"]');
    await page.waitForFunction(() => !document.body.textContent.includes('Loading repositories'), null, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.card.agent, .empty-title', { timeout: 20000 });
    await settle(page);
    if (sh.act) { await sh.act(page); await settle(page); }
    await page.screenshot({ path: `${out}/${sh.name}-${scheme}.png` });
    await ctx.close();
  }
}
await browser.close();
server.kill();
console.log('screenshots written to', out);

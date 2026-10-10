// No horizontal overflow, at any width from 280 to 360, light and dark, in every "agent numbers" mode and layout, with long
// hostile titles and repo names, in Settings, and with the rendering that differs between machines: classic (non-overlay)
// scrollbars that take 15 px of width, and a wide fallback font. A failure names the elements that stick out.
// Usage: node scripts/overflow.mjs     (needs npm run build)
import { chromium } from '@playwright/test';
import { overflowReport, startPreview } from './lib.mjs';

const { child: server, base } = await startPreview(4394);
let browser;
const launch = async (args) => {
  try { return await chromium.launch(args); } catch { return chromium.launch({ channel: 'chrome', ...args }); }
};
// OVERFLOW_BREAK=1 injects a layout bug on purpose: the check has to fail (scripts/overflow-negative.mjs relies on it)
const BREAK = process.env.OVERFLOW_BREAK === '1' ? '.card { min-width: 600px !important; }' : '';
const WIDE_FONT = "html, body, button, input { font-family: 'DejaVu Sans', 'Verdana', monospace !important; font-size: 15px !important; }";
let failed = 0, checked = 0;

const variants = [
  { name: 'default', launchArgs: {}, css: '' },
  // headless Chromium hides scrollbars by default; real Linux and Windows windows show 15 px ones
  { name: 'classic-scrollbars+wide-font', launchArgs: { ignoreDefaultArgs: ['--hide-scrollbars'] }, css: WIDE_FONT },
];
const settings = (o) => '&settings=' + encodeURIComponent(JSON.stringify(o));

for (const v of variants) {
  browser = await launch(v.launchArgs);
  for (const width of (process.env.OVERFLOW_QUICK ? [320] : [280, 300, 320, 360])) for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height: 620 }, colorScheme: scheme, reducedMotion: 'reduce', timezoneId: 'America/Vancouver' });
    const cases = [];
    for (const fixture of ['demo', 'hostile']) for (const metric of ['percent', 'tokens', 'both']) for (const layout of ['cards', 'compact']) {
      cases.push({ label: `${fixture} ${metric} ${layout}`, url: `?fixture=${fixture}${settings({ agent_metric: metric, layout })}` });
    }
    cases.push({ label: 'hostile glass bar', url: `?fixture=hostile${settings({ layout: 'glass', progress: 'bar', agent_metric: 'both' })}` });
    cases.push({ label: 'hostile 20 agents', url: `?fixture=hostile${settings({ max_agents: 20, max_repos: 20 })}` });
    cases.push({ label: 'empty + gh error', url: '?fixture=empty&gh=login' });
    cases.push({ label: 'hostile settings', url: '?fixture=hostile', settings: true });
    for (const c of cases) {
      const page = await ctx.newPage();
      await page.goto(base + c.url);
      await page.waitForSelector('html[data-ready="1"]');
      await page.waitForSelector('.card.agent, .empty-title', { timeout: 20000 });
      if (v.css || BREAK) await page.addStyleTag({ content: v.css + BREAK });
      if (c.settings) await page.getByRole('button', { name: 'Settings' }).click();
      await page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
      // the list is scrolled to the end too: the GitHub rows sit below the cards
      await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = m.scrollHeight; });
      const r = await page.evaluate(overflowReport);
      checked++;
      if (!r.ok) {
        failed++;
        console.error(`FAIL overflow [${v.name}] ${width}px ${scheme} ${c.label}: doc ${r.docScroll}, body ${r.bodyScroll}, main ${r.mainScroll}/${r.mainClient}, window ${r.vw}`);
        for (const w of r.wide) console.error(`     sticks out: ${w.el} left ${w.left} right ${w.right} (width ${w.width}) "${w.text}"`);
        for (const s of r.scrollers) console.error(`     scrolls: ${s}`);
      }
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
}
server.kill();
if (failed) { console.error(`${failed} of ${checked} overflow check(s) failed`); process.exit(1); }
console.log(`ok   no horizontal overflow in ${checked} combinations (widths 280/300/320/360, light/dark, all modes, hostile text, settings, classic scrollbars, wide font)`);

// Browser-level checks of landmarks, keyboard, RTL text, error states and small screens, on the Vite build with synthetic data.
import { chromium } from '@playwright/test';
import { overflowReport, startPreview } from './lib.mjs';

const { child: server, base } = await startPreview(4391);
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'chrome' }); }
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error('FAIL', m); } else console.log('ok  ', m); };
const open = async (ctx, q) => { const p = await ctx.newPage(); p.on('pageerror', (e) => { failed++; console.error('page error', e.message); }); await p.goto(base + q); await p.waitForSelector('html[data-ready="1"]'); await p.waitForSelector('.card.agent, .empty-title', { timeout: 20000 }); return p; };

const ctx = await browser.newContext({ viewport: { width: 420, height: 700 }, reducedMotion: 'reduce', timezoneId: 'America/Vancouver' });
let page = await open(ctx, '?fixture=demo');
ok(await page.locator('main').count() === 1 && await page.locator('header').count() === 1 && await page.locator('footer').count() === 1, 'header, main and footer landmarks');
ok(await page.locator('h1').innerText() === 'Agents', 'h1 is Agents');
ok(await page.locator('[role=img][aria-label]').count() >= 5, 'rings have text labels');
ok(await page.locator('.pill.status').count() >= 6, 'every agent has a state word');
await page.keyboard.press('Tab');
ok((await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')).includes('Show transcript'), 'first Tab reaches the first agent card');
await page.getByRole('button', { name: 'Settings' }).click();
ok(await page.locator('h1').innerText() === 'Settings', 'Settings opens');
await page.getByRole('button', { name: 'Both' }).click();
ok(await page.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed') === 'true', 'a setting can be picked');
await page.keyboard.press('Escape');
ok(await page.locator('h1').innerText() === 'Agents', 'Escape returns from Settings');
ok(await page.locator('.ring').count() >= 6, 'Both shows rings with the numbers');
await page.close();

page = await open(ctx, '?fixture=empty&gh=missing');
ok((await page.locator('.empty-title').innerText()) === 'No agents yet', 'empty state says No agents yet');
ok((await page.locator('.notice.bad').innerText()).includes('not installed'), 'gh missing is explained');
await page.close();
for (const [g, word] of [['login', 'gh auth login'], ['rate', 'rate limit']]) {
  page = await open(ctx, `?fixture=demo&gh=${g}`);
  ok((await page.locator('.notice.bad').innerText()).includes(word), `gh ${g} error is explained`);
  await page.close();
}
const rtl = await ctx.newPage();
await rtl.goto(base + '?fixture=demo'); await rtl.waitForSelector('html[data-ready="1"]');
await rtl.evaluate(() => { document.documentElement.dir = 'rtl'; document.querySelector('.title').textContent = 'بازسازی میان‌افزار احراز هویت'; });
ok(await rtl.evaluate(() => getComputedStyle(document.querySelector('.title')).direction) === 'rtl', 'RTL titles lay out right to left');
ok(await rtl.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal scroll in RTL');
await rtl.close();
const tiny = await browser.newContext({ viewport: { width: 320, height: 300 }, reducedMotion: 'reduce' });
page = await open(tiny, '?fixture=demo');
const rep = await page.evaluate(overflowReport);
ok(rep.ok, `no horizontal scroll at 320x300 (doc ${rep.docScroll}, main ${rep.mainScroll}/${rep.mainClient}, window ${rep.vw}; sticking out: ${JSON.stringify(rep.wide.slice(0, 3))}; scrolling: ${JSON.stringify(rep.scrollers)})`);
ok(await page.locator('footer').isVisible() && await page.evaluate(() => document.querySelector('main').scrollHeight > document.querySelector('main').clientHeight), 'tiny height: footer stays, the list scrolls');
await browser.close();
server.kill();
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('ui smoke passed');

// Privacy check, end to end: transcripts full of CANARY strings (prompts, replies, tool inputs and outputs, later turns, injected
// context, paths) are read by the real Rust scanner (cargo example `scan`); the JSON it hands over and then the rendered page
// must contain no canary at all. What is meant to be shown (agent titles, PROGRESS notes) must be there.
// Usage: node scripts/canary.mjs      (needs: npm run build, cargo, a Chrome for Playwright)
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cargoEnv, repoRoot, startPreview } from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const C = 'CANARY-7e1a';
// Test knobs (the script's own tests use them): CANARY_DROP_NOTE=1 writes transcripts without any PROGRESS line, so the
// "page shows a PROGRESS note" check MUST fail; CANARY_DELAY_MS pauses before the page opens (a slow runner);
// CANARY_REAL_CLOCK=1 gives the page the wall clock instead of the moment the files were written (the old, flaky behaviour).
const DROP_NOTE = process.env.CANARY_DROP_NOTE === '1';
const note = (n, who) => (DROP_NOTE ? `no report here ${who}` : `PROGRESS: ${n}% - ${who} note visible`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-canary-'));
const iso = (s) => new Date(s * 1000).toISOString();
const now = Date.now() / 1000;
const rec = (o) => JSON.stringify(o) + '\n';
const sub = path.join(root, 'claude', '-proj', 'sess', 'subagents');
fs.mkdirSync(sub, { recursive: true });
const cx = path.join(root, 'codex', ...new Date().toISOString().slice(0, 10).split('-'));
fs.mkdirSync(cx, { recursive: true });
const touch = (p) => { const t = new Date((now - 5) * 1000); fs.utimesSync(p, t, t); };

// Claude
const cp = path.join(sub, 'agent-c1.jsonl');
fs.writeFileSync(cp,
  rec({ type: 'user', timestamp: iso(now - 30), cwd: `/${C}/cwd`, message: { role: 'user', content: [{ type: 'text', text: `prompt ${C}-prompt` }] } }) +
  rec({ type: 'assistant', timestamp: iso(now - 20), message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'text', text: `prose ${C}-prose\n${note(40, 'claude')}\nmore ${C}-more` }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${C}-input` } }] } }) +
  rec({ type: 'user', timestamp: iso(now - 10), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `out ${C}-output` }] }, toolUseResult: `${C}-tur` }));
fs.writeFileSync(cp.replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'explorer', description: 'Claude task title visible', prompt: `${C}-metaprompt` }));
touch(cp);
// Codex
const item = (t, ts) => rec({ timestamp: iso(ts), type: 'response_item', payload: t });
const first = `Codex task title visible ${'word '.repeat(60)}${C}-late-in-first-prompt`;
const xp = path.join(cx, 'rollout-x1.jsonl');
fs.writeFileSync(xp,
  rec({ timestamp: iso(now - 40), type: 'event_msg', payload: { type: 'task_started' } }) +
  item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions ${C}-agents` }] }, now - 39) +
  item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>${C}-env</environment_context>` }] }, now - 38) +
  item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: first }] }, now - 37) +
  item({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: `{"cmd":"${C}-args"}` }, now - 30) +
  item({ type: 'function_call_output', call_id: 'c1', output: `${C}-codex-output` }, now - 25) +
  item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply ${C}-reply\n${note(60, 'codex')}` }] }, now - 20) +
  item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `second turn ${C}-turn2` }] }, now - 15) +
  rec({ timestamp: iso(now - 10), type: 'turn_context', payload: { cwd: `/${C}/work`, model: `${C}-model` } }));
touch(xp);

const run = spawnSync('cargo', ['run', '--quiet', '--example', 'scan', '--', path.join(root, 'claude'), path.join(root, 'codex'), String(Math.round(now * 1000))], { cwd: path.join(repoRoot, 'src-tauri'), encoding: 'utf8', maxBuffer: 1 << 28, env: cargoEnv() });
if (run.status !== 0) { console.error(run.stderr); process.exit(1); }
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error('FAIL', m); } else console.log('ok  ', m); };
const payload = run.stdout;
ok(!payload.includes(C), 'the scanner output contains no canary (Claude and Codex)');
for (const need of ['claude note visible', 'codex note visible', 'Codex task title visible', 'Claude task title visible']) ok(payload.includes(need), `the scanner output has what the page shows: ${need}`);
ok(payload.length < 20_000, `the payload is small (${payload.length} bytes)`);

const { child: server, base } = await startPreview(4393);
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'chrome' }); }
const page = await (await browser.newContext()).newPage();
await page.addInitScript(([replies, nowMs]) => { window.__REPLIES__ = replies; if (nowMs) window.__NOW_MS__ = nowMs; }, [JSON.parse(payload), process.env.CANARY_REAL_CLOCK === '1' ? 0 : Math.round(now * 1000)]);
if (process.env.CANARY_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.CANARY_DELAY_MS)));
await page.goto(base + '?fixture=replies&gh=missing&settings=' + encodeURIComponent('{"agent_metric":"both"}'));
await page.waitForSelector('html[data-ready="1"]');
/** Polls until fn() is truthy (up to 20 s): a slow runner may need a few ticks before the page shows what the scanner sent. */
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 200)); } };
const cards = () => page.evaluate(() => [...document.querySelectorAll('.card.agent')].map((c) => c.innerText.replace(/\s+/g, ' ')).join('\n'));
const everything = () => page.evaluate(() => document.documentElement.outerHTML + '\n' + document.body.innerText + '\n' + [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join('\n'));
await until(async () => (await page.locator('.card.agent').count()) >= 2);
const noteShown = await until(async () => { const t = await cards(); return t.includes('claude note visible') && t.includes('codex note visible'); });
const html = await everything();
ok(!html.includes(C), 'the rendered page (DOM text, attributes, labels) contains no canary');
ok(html.includes('Claude task title visible') && html.includes('Codex task title visible'), 'the page shows both agent titles');
ok(noteShown, 'the page shows both PROGRESS notes');
if (!noteShown) console.error('DIAGNOSTICS\n--- agent cards as rendered:\n' + (await cards()) + '\n--- scanner payload:\n' + payload.slice(0, 3000));
await browser.close();
server.kill();
fs.rmSync(root, { recursive: true, force: true });
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('privacy canary passed');

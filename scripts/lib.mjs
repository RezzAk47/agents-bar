// Shared helpers for the node scripts, written to work the same on Windows, Linux and macOS:
// paths come from fileURLToPath (never URL.pathname, which is '/D:/...' on Windows), and child processes are started
// with the node executable itself (never `npx`, which is npx.cmd on Windows and cannot be spawned without a shell).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Starts `vite preview` on a port and waits until it answers. Returns the child (kill it when done) and the base URL. */
export async function startPreview(port) {
  const vite = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: repoRoot, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, base };
}

/** PATH for a cargo child: on macOS and Linux the usual rustup folders are added; on Windows the PATH is left alone. */
export function cargoEnv() {
  if (process.platform === 'win32') return process.env;
  const extra = [`${process.env.HOME}/.cargo/bin`, '/opt/homebrew/opt/rustup/bin'];
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ''].join(path.delimiter) };
}

/** Runs in the page: every element wider than the window, and the scroll widths of the document and the list. */
export function overflowReport() {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const pick = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5)) wide.push({ el: pick(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), text: (el.textContent || '').trim().slice(0, 40) });
  }
  wide.sort((a, b) => b.right - a.right);
  const main = document.querySelector('main');
  const scrollers = [...document.querySelectorAll('body *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowX) && e.clientWidth > 0).map((e) => `${pick(e)} scrollWidth ${e.scrollWidth} > clientWidth ${e.clientWidth}`);
  return {
    vw, docScroll: doc.scrollWidth, bodyScroll: document.body.scrollWidth, mainScroll: main ? main.scrollWidth : 0, mainClient: main ? main.clientWidth : 0,
    ok: doc.scrollWidth <= vw && document.body.scrollWidth <= vw && (!main || main.scrollWidth <= main.clientWidth) && wide.length === 0,
    wide: wide.slice(0, 8), scrollers: scrollers.slice(0, 5),
  };
}

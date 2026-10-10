import { render } from 'preact';
import { App, applyTheme } from './ui/app';
import { Engine } from './ui/engine';
import type { Backend } from './backend/types';
import { memoryBackend } from './backend/memory';
import type { ScanBackend, ScanReply } from './core/agents';
import { defaultSettings } from './core/settings';

const FIXTURE_NOW = Date.UTC(2026, 9, 7, 19, 0, 0); // a fixed "now" for the made-up preview data

async function pickBackend(): Promise<Backend> {
  const inTauri = typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
  if (inTauri) return (await import('./backend/tauri')).tauriBackend();
  // Browser preview: made-up synthetic data and a fake gh, never a real file. ?fixture=demo|empty|crash ; &gh=ok|missing|login|rate ; &settings={json}
  const q = new URLSearchParams(location.search);
  const fixture = q.get('fixture') ?? 'demo';
  if (fixture === 'crash') throw new Error('test: the page failed to start');
  const gh = (['ok', 'missing', 'login', 'rate'] as const).find((g) => g === q.get('gh')) ?? 'ok';
  // 'replies': the page's clock is the moment the transcripts were written (window.__NOW_MS__ from scripts/canary.mjs), not the
  // wall clock, so a slow machine (the scanner example compiles first on CI) cannot turn running agents into stalled ones.
  const injectedNow = (window as unknown as { __NOW_MS__?: number }).__NOW_MS__;
  const b = memoryBackend({ now: fixture === 'replies' ? injectedNow ?? Date.now() : FIXTURE_NOW, gh, empty: fixture === 'empty', hostile: fixture === 'hostile' });
  const raw = q.get('settings');
  if (raw) await b.io.write('settings.json', raw);
  if (fixture === 'replies') {
    // Rust scanner replies injected by scripts/canary.mjs (window.__REPLIES__): the page sees exactly what the app would
    const replies = (window as unknown as { __REPLIES__?: ScanReply[] }).__REPLIES__ ?? [];
    let i = 0;
    const scan: ScanBackend = { scan: async () => replies[Math.min(i++, replies.length - 1)] ?? { files: [], known: [], more: false } };
    b.scan = scan;
  }
  const t0 = Date.now();
  const base = b.now();
  b.now = () => base + (Date.now() - t0);
  return b;
}

/** Last resort: if the page cannot start, say why instead of showing an empty window. Plain DOM, no framework. */
export function showFatal(message: string): void {
  const root = document.getElementById('root') ?? document.body;
  root.textContent = '';
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.className = 'fatal';
  const h = document.createElement('h1'); h.textContent = 'Agents Bar could not start';
  const p = document.createElement('p'); p.textContent = message;
  const q = document.createElement('p'); q.textContent = 'Nothing was changed. Close this window from the tray icon (Quit) and start the app again.';
  box.append(h, p, q);
  root.append(box);
  document.documentElement.dataset.ready = '1';
}

async function main() {
  const backend = await pickBackend();
  const engine = new Engine(backend);
  applyTheme(defaultSettings(), window.matchMedia('(prefers-color-scheme: dark)').matches);
  await engine.init();
  (window as unknown as { __engine: Engine }).__engine = engine;
  backend.onTick(() => void engine.tick());
  render(<App engine={engine} />, document.getElementById('root')!);
  document.documentElement.dataset.ready = '1';
}
window.addEventListener('unhandledrejection', (e) => { if (!document.getElementById('root')?.children.length) showFatal(String((e.reason as Error)?.message ?? e.reason)); });
main().catch((e) => showFatal(String((e as Error)?.message ?? e)));

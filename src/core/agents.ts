// Agents: states, estimates and the incremental scanner on top of transcripts.ts (port of agents_core.py).
import { clean, saneTime } from './text.ts';
import { feed, newState, resultOf, type AnyState, type Kind, type Parsed, type Rec } from './transcripts.ts';

export const LOOKBACK_SECONDS = 24 * 3600;
export const RUNNING_WINDOW = 90; // file touched this recently and no handback = running
export const MIN_FINISHED_FOR_ETA = 2;
export const MAX_ESTIMATE_PCT = 97;
export const LINEAR_UNTIL = 0.8;
export const PENDING_TOOL_WINDOW = 900; // an agent waiting on a tool result (build, tests) stays 'running' this long
export const CLOCK_SKEW = 300;
export const IDLE_GAP = 600;
export const MAX_FILES = 300;
export const SIMILARITY = 0.2;

export type AgentState = 'running' | 'done' | 'stalled';
export type Source = 'Claude' | 'Codex';

export interface Agent {
  agentId: string; kind: string; description: string; state: AgentState; started: number; lastActivity: number;
  toolCalls: number; lastTool: string; pct: number | null; eta: number | null; asOf: number; source: Source; path: string;
  active: number; typical: number | null; rough: boolean; reported: boolean; note: string;
  tokensNew: number | null; tokensCache: number | null;
}

export const agentKey = (a: Agent): string => `${a.source}\u0000${a.path || a.agentId}`;
/** Active working time. A running agent also counts its current quiet stretch (capped). */
export const elapsed = (a: Agent): number => (a.state !== 'running' ? a.active : a.active + Math.min(Math.max(0, a.asOf - a.lastActivity), IDLE_GAP));
export const remaining = (a: Agent): number | null => (a.eta === null ? null : Math.max(0, a.eta - a.asOf));
export const overrun = (a: Agent): boolean => a.state === 'running' && a.typical !== null && elapsed(a) > a.typical;

export function stateOf(p: Pick<Parsed, 'done' | 'last' | 'pending'>, now: number): AgentState {
  if (p.done) return 'done';
  const last = p.last ?? 0;
  if (last > now + CLOCK_SKEW) return 'stalled'; // timestamps from the future: a wrong clock, not live work
  const window = p.pending ? PENDING_TOOL_WINDOW : RUNNING_WINDOW;
  return now - last <= window ? 'running' : 'stalled';
}

/** Percent for elapsed/typical. Straight up to 80%, then it creeps toward 97%. */
export function curvePct(ratio: number): number {
  if (!(ratio > 0)) return 0;
  if (ratio <= LINEAR_UNTIL) return Math.trunc(ratio * 100);
  const room = MAX_ESTIMATE_PCT - LINEAR_UNTIL * 100;
  return Math.min(MAX_ESTIMATE_PCT, Math.trunc(LINEAR_UNTIL * 100 + room * (1 - Math.exp(-(ratio - LINEAR_UNTIL)))));
}

const wordCache = new Map<string, Set<string>>();
function words(text: string): Set<string> {
  let w = wordCache.get(text);
  if (!w) {
    // Python: alnum chars kept, everything else a separator, words of 4+ characters
    w = new Set(text.replace(/[^\p{L}\p{N}]/gu, ' ').toLowerCase().split(/\s+/).filter((x) => Array.from(x).length >= 4));
    if (wordCache.size > 4096) wordCache.clear();
    wordCache.set(text, w);
  }
  return w;
}
export function similar(a: string, b: string): boolean {
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return false;
  let inter = 0;
  for (const x of wa) if (wb.has(x)) inter++;
  return inter / (wa.size + wb.size - inter) >= SIMILARITY;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Active times to compare a running agent against, and whether that guess is rough. */
function history(a: Agent, done: Agent[]): [number[], boolean] {
  const sameTool = done.filter((d) => d.source === a.source);
  const pools: [Agent[], boolean][] = [
    [sameTool.filter((d) => similar(a.description, d.description)), false],
    [sameTool.filter((d) => d.kind === a.kind), false],
    [sameTool, true],
  ];
  for (const [pool, rough] of pools) if (pool.length >= MIN_FINISHED_FOR_ETA) return [pool.map((d) => d.active), rough];
  return [[], false];
}

export function estimate(agents: Agent[], now: number): void {
  const done = agents.filter((a) => a.state === 'done');
  for (const a of agents) {
    if (a.state !== 'running') continue;
    if (a.reported) {
      const e = elapsed(a);
      if (a.pct !== null && a.pct > 0 && e > 0) a.eta = now + (e * (100 - a.pct)) / a.pct;
      continue;
    }
    const [runs, rough] = history(a, done);
    a.rough = rough;
    if (!runs.length) continue;
    const typical = median(runs);
    if (typical <= 0) continue;
    a.typical = typical;
    a.pct = curvePct(elapsed(a) / typical);
    if (!overrun(a)) a.eta = now + (typical - elapsed(a));
  }
}

/** Agents that were running (or looked stalled) at the last scan and are done now. previous === null (first scan) reports nothing. */
export function finishedSince(previous: Map<string, AgentState> | null, agents: Agent[]): Agent[] {
  if (previous === null) return [];
  return agents.filter((a) => a.state === 'done' && (previous.get(agentKey(a)) === 'running' || previous.get(agentKey(a)) === 'stalled'));
}

export function nextDone(agents: Agent[]): number | null {
  const left = agents.filter((a) => a.state === 'running').map(remaining).filter((x): x is number => x !== null);
  return left.length ? Math.min(...left) : null;
}

/** (running count, average estimated percent or null) for the tray. */
export function barState(agents: Agent[]): [number, number | null] {
  const running = agents.filter((a) => a.state === 'running');
  const pcts = running.map((a) => a.pct).filter((p): p is number => p !== null);
  return [running.length, pcts.length ? Math.floor(pcts.reduce((x, y) => x + y, 0) / pcts.length) : null];
}

/** Tray tooltip/title: '3 running · 2 finished' (finished = done today is passed in by the caller). */
export function trayLabel(running: number, finished: number): string {
  const parts: string[] = [];
  if (running) parts.push(`${running} running`);
  if (finished) parts.push(`${finished} finished`);
  return parts.length ? parts.join(' · ') : 'Agents Bar';
}

// ---- the incremental scanner (state per transcript; the file reading is the backend's job) ------------------------

/** What the Rust scanner returns for one file that changed since the last call. */
export interface ScanFile {
  path: string; kind: Kind; mtimeMs: number;
  /** true: start this file's state over (new, truncated or replaced file). */
  reset: boolean;
  /** Slim or full records, complete lines only, in file order. */
  records: Rec[];
  /** The sibling .meta.json (Claude) when it changed; null = none/unreadable. */
  meta?: { agentType?: unknown; description?: unknown } | null;
}
export interface KnownFile { path: string; kind: Kind; mtimeMs: number }
export interface ScanReply { files: ScanFile[]; known: KnownFile[]; more: boolean }
export interface ScanBackend { scan(rediscover: boolean): Promise<ScanReply> }

interface Entry { kind: Kind; state: AnyState; parsed: Parsed | null; mtimeMs: number; meta: { agentType?: unknown; description?: unknown } }

export const MAX_SCAN_ROUNDS = 40; // a cold scan is read in several bounded rounds
export const MAX_SCAN_MS = 1500; // ... and one tick never keeps the page busy longer than this: the rest is read on the next ticks

const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
const stem = (p: string): string => baseName(p).replace(/\.[^.]*$/, '');

export class AgentScanner {
  private entries = new Map<string, Entry>();
  private known: KnownFile[] = [];
  /** True when the last scan() ended with a complete pass (the backend said more = false). Until then states may be wrong:
   * a file read only half way looks stalled or running. */
  complete = false;
  /** Files the backend knows about (for the "Scanning..." note). */
  get knownCount(): number { return this.known.length; }
  private backend: ScanBackend;
  constructor(backend: ScanBackend) { this.backend = backend; }

  /** Agents seen in the last 24 h, running first, newest first. */
  async scan(now: number, rediscover: boolean): Promise<Agent[]> {
    this.complete = false;
    const started = performance.now();
    for (let round = 0; round < MAX_SCAN_ROUNDS && (round === 0 || performance.now() - started < MAX_SCAN_MS); round++) {
      const reply = await this.backend.scan(rediscover && round === 0 ? true : false);
      this.known = reply.known;
      for (const f of reply.files) this.apply(f);
      if (!reply.more) { this.complete = true; break; }
    }
    const live = new Set(this.known.map((k) => k.path));
    for (const p of [...this.entries.keys()]) if (!live.has(p)) this.entries.delete(p);
    return this.agents(now);
  }

  private apply(f: ScanFile): void {
    let e = this.entries.get(f.path);
    if (!e || e.kind !== f.kind || f.reset) {
      e = { kind: f.kind, state: newState(f.kind), parsed: null, mtimeMs: f.mtimeMs, meta: e?.meta ?? {} };
      this.entries.set(f.path, e);
    }
    e.mtimeMs = f.mtimeMs;
    if (f.meta !== undefined) e.meta = f.meta ?? {};
    for (const d of f.records) {
      try { feed(f.kind, e.state, d); } catch { /* one odd record never stops the file */ }
    }
    e.parsed = resultOf(f.kind, e.state);
  }

  private agents(now: number): Agent[] {
    const out: Agent[] = [];
    for (const k of this.known) {
      const e = this.entries.get(k.path);
      if (!e?.parsed || e.parsed.first === null) continue;
      if (now - k.mtimeMs / 1000 > LOOKBACK_SECONDS) continue;
      const p = e.parsed;
      const rep = p.report ? { pct: p.report[0], reported: true, note: p.report[1] } : { pct: null, reported: false, note: '' };
      const common = {
        state: stateOf(p, now), started: p.first!, lastActivity: saneTime(p.last, now), toolCalls: p.tools, lastTool: p.lastTool,
        eta: null, asOf: now, active: p.active, typical: null, rough: false, tokensNew: p.tokNew, tokensCache: p.tokCache, path: k.path, ...rep,
      };
      if (k.kind === 'codex') {
        out.push({ ...common, agentId: stem(k.path).slice(-12), kind: 'codex', description: clean(p.title, 200) || 'Codex session', source: 'Codex' });
      } else {
        const s = stem(k.path);
        out.push({
          ...common, agentId: s.startsWith('agent-') ? s.slice(6) : s, kind: clean(e.meta.agentType, 40) || 'agent',
          description: clean(e.meta.description, 200) || s, source: 'Claude',
        });
      }
    }
    estimate(out, now);
    out.sort((a, b) => Number(a.state !== 'running') - Number(b.state !== 'running') || b.lastActivity - a.lastActivity);
    return out;
  }
}

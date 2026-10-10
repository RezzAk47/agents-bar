// Finish alerts and the Today list (port of agents_history.py + notify_queue.py). No I/O of its own: persistence and the
// notification itself are passed in.
import { agentKey, elapsed, finishedSince, type Agent, type AgentState } from './agents';
import { sameStamp, isConflict, type FileStamp } from './io';
import { clean, clock, fmtDuration, fmtStats, isFiniteNumber, tokenPhrase } from './text';

export const KEEP_SECONDS = 2 * 86400; // an alert is remembered this long
export const MAX_IDS = 2000;
export const MAX_ID_CHARS = 600;
export const MAX_FILE_BYTES = 1 << 20;
export const TODAY_ROWS = 5;
export const TITLE_CHARS = 80;
export const BURST = 3; // more finishes than this in one scan become ONE 'N agents finished' notification
export const MAX_RETRIES = 3;
export const FRESH_FINISH_SECONDS = 900; // a finish is announced only when its last record is this recent (see observe)
export const MAX_WORKERS = 2;
export const MAX_QUEUED = 50;

/** Python's round(): halves go to the even neighbour (2.5 -> 2, 3.5 -> 4). Math.round sends every half up. */
export function pyRound(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** Notification text: one clean line without `<`, `>` or `&` (some Linux notification daemons render markup). */
export const plainText = (value: unknown, limit: number): string => clean(String(clean(value)).replace(/[<>&]/g, ''), limit);

/** Identity that survives restarts (do not point the Mac bars and this app at one notified file: the ids differ in form): source:path@finish-second, so a second turn of the same file alerts again. */
export function agentId(a: Pick<Agent, 'source' | 'path' | 'agentId' | 'lastActivity'>): string {
  const when = isFiniteNumber(a.lastActivity) ? a.lastActivity : 0;
  return `${clean(`${a.source}:${a.path || a.agentId}`, MAX_ID_CHARS - 24)}@${pyRound(when)}`;
}

/** `stat` and `expected` are optional: with them, a save is a compare-and-swap (see NotifiedStore.save). */
export interface Persist {
  read(): Promise<string | null>;
  write(text: string, expected?: FileStamp | null): Promise<void>;
  stat?(): Promise<FileStamp | null>;
}

const SAVE_ATTEMPTS = 5;

/** {agent id: epoch of the alert}. Loading is strict (bad entries dropped, a bad file means empty). */
export class NotifiedStore {
  ids = new Map<string, number>();
  tries = new Map<string, [number, number]>();
  constructor(private persist: Persist | null = null, private clockNow: () => number = () => Date.now() / 1000) {}

  load(text: string | null): void {
    this.ids.clear(); this.tries.clear();
    if (text === null || text.length > MAX_FILE_BYTES) return;
    let data: unknown;
    try { data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return; }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const d = data as Record<string, unknown>;
    const ids = d.ids;
    if (typeof ids !== 'object' || ids === null || Array.isArray(ids)) return;
    const now = this.clockNow();
    for (const [k, v] of Object.entries(ids)) {
      if (k.length > 0 && k.length <= MAX_ID_CHARS && isFiniteNumber(v)) this.ids.set(k, Math.min(v, now)); // a future stamp would never expire
    }
    const tries = d.tries;
    if (typeof tries === 'object' && tries !== null && !Array.isArray(tries)) {
      for (const [k, v] of Object.entries(tries)) {
        if (k.length > 0 && k.length <= MAX_ID_CHARS && Array.isArray(v) && v.length === 2 && v.every(isFiniteNumber) && v[0]! > 0 && v[0]! <= MAX_RETRIES + 1) {
          this.tries.set(k, [Math.trunc(v[0]!), Math.min(v[1]!, now)]);
        }
      }
    }
    this.prune();
  }

  private lastStamp: FileStamp | null | undefined = undefined; // undefined = never looked

  async init(): Promise<void> {
    try {
      const stamp = this.persist?.stat ? await this.persist.stat() : undefined; // stat first: a change after it is caught by the compare
      this.load(this.persist ? await this.persist.read() : null);
      this.lastStamp = stamp;
    } catch { this.load(null); }
  }

  /** Adds what another copy of the app wrote (newer time wins, more failures win); nothing of ours is dropped. */
  private mergeFrom(text: string | null): void {
    const other = new NotifiedStore(null, this.clockNow);
    other.load(text);
    for (const [k, t] of other.ids) if (t > (this.ids.get(k) ?? -Infinity)) this.ids.set(k, t);
    for (const [k, v] of other.tries) { const mine = this.tries.get(k); if (!mine || v[0] > mine[0]) this.tries.set(k, v); }
    this.prune();
  }

  prune(): void {
    const cutoff = this.clockNow() - KEEP_SECONDS;
    for (const [k, t] of this.ids) if (t < cutoff) this.ids.delete(k);
    for (const [k, v] of this.tries) if (v[1] < cutoff || this.ids.has(k)) this.tries.delete(k);
    if (this.tries.size > MAX_IDS) this.tries = new Map([...this.tries].sort((a, b) => b[1][1] - a[1][1]).slice(0, MAX_IDS));
    if (this.ids.size > MAX_IDS) this.ids = new Map([...this.ids].sort((a, b) => b[1] - a[1]).slice(0, MAX_IDS));
  }

  has(key: string): boolean { return this.ids.has(key); }
  add(key: string, now?: number): void { this.ids.set(key, now ?? this.clockNow()); this.prune(); }
  /** Counts one failed delivery; returns the failures so far. */
  failed(key: string): number {
    const n = (this.tries.get(key)?.[0] ?? 0) + 1;
    this.tries.set(key, [n, this.clockNow()]);
    this.prune();
    return n;
  }

  serialize(): string {
    const ids: Record<string, number> = {};
    for (const k of [...this.ids.keys()].sort()) ids[k] = this.ids.get(k)!;
    const body: Record<string, unknown> = { version: 1, ids };
    if (this.tries.size) {
      const tries: Record<string, [number, number]> = {};
      for (const k of [...this.tries.keys()].sort()) tries[k] = this.tries.get(k)!;
      body.tries = tries;
    }
    return `${JSON.stringify(body)}\n`;
  }

  async save(): Promise<boolean> {
    const p = this.persist;
    if (!p) return true;
    // Without stat there is nothing to compare: plain write. With it, the write only lands on the file we last saw; if
    // another copy changed it, its entries are merged in and the write is tried again (a few times).
    if (!p.stat) { try { await p.write(this.serialize()); return true; } catch { return false; } }
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      try {
        const stamp = await p.stat();
        if (this.lastStamp === undefined || !sameStamp(stamp, this.lastStamp)) {
          this.mergeFrom(stamp === null ? null : await p.read());
        }
        await p.write(this.serialize(), stamp);
        this.lastStamp = await p.stat();
        return true;
      } catch (e) {
        if (!isConflict(e)) return false;
        this.lastStamp = undefined; // changed under us: merge again
      }
    }
    return false;
  }
}

/** A short project name: from the Claude project folder name, else the tool for Codex. */
export function projectOf(a: Pick<Agent, 'source' | 'path'>): string {
  if (a.source === 'Codex') return 'Codex';
  const parts = (a.path || '').split(/[\\/]+/).filter(Boolean);
  const at = parts.lastIndexOf('projects');
  if (at < 0 || at + 1 >= parts.length) return '';
  // Claude Code names the folder after the project path with separators turned into '-': C:\Users\Ann\x -> C--Users-Ann-x
  let tokens = parts[at + 1]!.replace(/^[A-Za-z]--/, '').replace(/^-+|-+$/g, '').split('-');
  if (tokens.length >= 2 && (tokens[0] === 'Users' || tokens[0] === 'home')) tokens = tokens.slice(2); // drop 'Users-<name>' / 'home-<name>'
  while (tokens.length && ['Desktop', 'Documents', 'Projects', 'Developer', 'Code'].includes(tokens[0]!)) tokens = tokens.slice(1);
  return clean(tokens.join('-'), 40) || 'home';
}

export function notification(a: Agent): [string, string] {
  const project = projectOf(a);
  const desc = plainText(a.description, 90) || 'an agent';
  const text = `${project ? `${project}: ` : ''}${desc} · took ${fmtDuration(elapsed(a))} · ${fmtStats(a)}`;
  return ['Agent finished', plainText(text, 200)];
}

export function groupNotification(agents: Agent[]): [string, string] {
  const n = agents.length;
  let longest = '';
  for (const a of agents) { const d = plainText(a.description, 90); if (d.length > longest.length) longest = d; }
  return [`${n} agents finished`, longest ? `${longest}, and ${n - 1} more` : ''];
}

// ---- delivery queue (at most MAX_WORKERS deliveries at once) -------------------------------------------------------

export class DeliveryQueue {
  private jobs: [() => Promise<boolean>, ((ok: boolean) => void) | undefined][] = [];
  private active = 0;
  constructor(private workers = MAX_WORKERS, private maxQueued = MAX_QUEUED) {}
  peakActive = 0;

  submit(job: () => Promise<boolean>, done?: (ok: boolean) => void): boolean {
    if (this.jobs.length >= this.maxQueued) { done?.(false); return false; }
    this.jobs.push([job, done]);
    this.pump();
    return true;
  }

  private pump(): void {
    while (this.active < this.workers && this.jobs.length) {
      const [job, done] = this.jobs.shift()!;
      this.active++;
      this.peakActive = Math.max(this.peakActive, this.active);
      void (async () => {
        let ok = false;
        try { ok = (await job()) !== false; } catch { ok = false; }
        try { done?.(ok); } catch { /* a failing callback never stops the queue */ }
        this.active--;
        this.pump();
      })();
    }
  }

  /** Resolves when nothing is running or waiting (tests). */
  async idle(): Promise<void> {
    while (this.active || this.jobs.length) await new Promise((r) => setTimeout(r, 1));
  }
}

export interface WatcherOptions {
  notify: (a: Agent) => Promise<boolean>;
  notifyGroup?: (agents: Agent[]) => Promise<boolean>;
  enabled?: () => boolean;
  store: NotifiedStore;
  queue?: DeliveryQueue;
}

/** Call observe(agents) after every scan: one notification per agent that went running/stalled -> done, never for agents
 * already done at the first scan, never twice for the same finish. A failed delivery is retried on later scans, at most
 * MAX_RETRIES times (saved). More than BURST finishes in one scan go out as ONE notification. */
export class FinishWatcher {
  readonly store: NotifiedStore;
  readonly queue: DeliveryQueue;
  private previous: Map<string, AgentState> | null = null;
  private inflight = new Set<string>();
  private pending = new Map<string, Agent>();
  private saving: Promise<unknown> = Promise.resolve();
  constructor(private o: WatcherOptions) { this.store = o.store; this.queue = o.queue ?? new DeliveryQueue(); }

  observe(agents: Agent[]): Agent[] {
    // A real finish writes its last record just now. A file that only *looks* newly finished because it was read late (a huge
    // transcript caught up over several ticks) has an old last record and is never announced.
    const finished = finishedSince(this.previous, agents).filter((a) => a.asOf - a.lastActivity <= FRESH_FINISH_SECONDS);
    this.previous = new Map(agents.map((a) => [agentKey(a), a.state]));
    let on = false;
    try { on = (this.o.enabled ?? (() => true))(); } catch { on = false; }
    if (!on) { this.pending.clear(); return []; }
    const todo = new Map<string, Agent>();
    for (const [key, a] of [...this.pending]) {
      if (this.store.has(key)) this.pending.delete(key); else todo.set(key, a);
    }
    for (const a of finished) {
      const key = agentId(a);
      if (!this.store.has(key)) todo.set(key, a);
    }
    const items = [...todo].filter(([k]) => !this.inflight.has(k));
    for (const [k] of items) this.inflight.add(k);
    const fired = items.map(([, a]) => a);
    if (items.length > BURST && this.o.notifyGroup) {
      this.send(items, () => this.o.notifyGroup!(fired));
    } else {
      for (const it of items) this.send([it], () => this.o.notify(it[1]));
    }
    return fired;
  }

  private send(items: [string, Agent][], job: () => Promise<boolean>): void {
    this.queue.submit(job, (ok) => this.done(items, ok));
  }

  private done(items: [string, Agent][], ok: boolean): void {
    for (const [key, a] of items) {
      this.inflight.delete(key);
      if (ok) { this.store.add(key); this.pending.delete(key); }
      else if (this.store.failed(key) > MAX_RETRIES) { this.store.add(key); this.pending.delete(key); } // given up: never nag forever
      else this.pending.set(key, a);
    }
    this.saving = this.saving.then(() => this.store.save());
  }

  async flush(): Promise<void> { await this.queue.idle(); await this.saving; }
}

// ---- the Today list ----------------------------------------------------------------------------------------------

const dayOf = (ts: unknown): string | null => {
  if (!isFiniteNumber(ts)) return null;
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Agents that finished on the local day of `now` (epoch seconds), newest first. */
export function today(agents: Agent[], now: number = Date.now() / 1000): Agent[] {
  const day = dayOf(now);
  const rows = agents.filter((a) => a.state === 'done' && day !== null && dayOf(a.lastActivity) === day);
  return rows.sort((a, b) => (isFiniteNumber(b.lastActivity) ? b.lastActivity : 0) - (isFiniteNumber(a.lastActivity) ? a.lastActivity : 0));
}

/** (title, 'duration · tokens (or steps) · HH:MM') for a Today row. */
export function todayRow(a: Agent): [string, string] {
  const tag = a.source === 'Codex' ? 'Codex · ' : '';
  const title = tag + (clean(a.description, TITLE_CHARS) || 'Agent');
  const amount = tokenPhrase(a.tokensNew) || fmtStats(a);
  return [title, `${fmtDuration(elapsed(a))} · ${amount} · ${clock(a.lastActivity)}`];
}

export const capRows = <T,>(rows: T[], cap = TODAY_ROWS): [T[], number] => [rows.slice(0, cap), Math.max(0, rows.length - cap)];

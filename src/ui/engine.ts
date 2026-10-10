// The engine behind the popup: owns the scanner, the finish watcher, the GitHub book and the settings, and publishes one
// snapshot to the UI after every change. No DOM here, so it is tested without a browser.
import { AgentScanner, trayLabel, type Agent } from '../core/agents';
import { FinishWatcher, NotifiedStore, groupNotification, notification, today } from '../core/history';
import { StatusBook, attention, fetchWithStatus, ghErrorText, summary, type Hit, type Repo } from '../core/github';
import { SettingsStore } from '../core/settingsStore';
import { NOTIFIED_FILE } from '../core/settings';
import { errMessage } from '../core/io';
import type { Backend } from '../backend/types';

export const GITHUB_REFRESH_MS = 10 * 60 * 1000;
export const FULL_WALK_EVERY = 10; // a folder walk every 10th tick (3 s each); the other ticks only look at known files

export interface Snapshot {
  ready: boolean;
  agents: Agent[];
  finishedToday: Agent[];
  repos: Repo[];
  login: string;
  ghError: string | null;
  ghLoading: boolean;
  ghUpdated: number | null;
  hits: Hit[];
  attention: { text: string; repo: Repo } | null;
  scanError: string | null;
  /** A pass over the transcripts is still running (a big first start): states are not judged until it is complete. */
  scanning: boolean;
  now: number;
}

export class Engine {
  readonly settings: SettingsStore;
  readonly store: NotifiedStore;
  readonly watcher: FinishWatcher;
  readonly book: StatusBook;
  private scanner: AgentScanner;
  private ticks = 0;
  private busy = false;
  private hadComplete = false;
  private ghBusy = false;
  private ghAt = -Infinity;
  private listeners = new Set<() => void>();
  snap: Snapshot = { ready: false, agents: [], finishedToday: [], repos: [], login: '', ghError: null, ghLoading: false, ghUpdated: null, hits: [], attention: null, scanError: null, scanning: false, now: 0 };

  constructor(readonly backend: Backend, opts: { scanClock?: () => number } = {}) {
    this.settings = new SettingsStore(backend.io);
    this.store = new NotifiedStore({
      read: () => backend.io.read(NOTIFIED_FILE),
      write: (t) => backend.io.write(NOTIFIED_FILE, t),
    }, () => backend.now() / 1000);
    this.scanner = new AgentScanner(backend.scan, opts.scanClock);
    this.book = new StatusBook({ gh: backend.gh ?? { user: async () => '', repoList: async () => { throw new Error('GH_MISSING'); }, runList: async () => { throw new Error('GH_MISSING'); } } });
    this.watcher = new FinishWatcher({
      store: this.store,
      enabled: () => this.settings.settings.notifyFinish,
      notify: async (a) => { const [t, b] = notification(a); return backend.notify(t, b); },
      notifyGroup: async (agents) => { const [t, b] = groupNotification(agents); return backend.notify(t, b); },
    });
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { for (const l of [...this.listeners]) l(); }

  async init(): Promise<void> {
    await this.settings.init();
    await this.store.init();
    this.settings.subscribe(() => { this.recompute(); this.emit(); });
    this.backend.onSlept?.(() => this.onSlept());
    await this.tick();
    void this.refreshGithub(true);
  }

  /** One beat (every 3 s from Rust): re-read changed transcripts. Never overlaps itself and never throws. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.settings.recheck();
      const now = this.backend.now() / 1000;
      const rediscover = this.ticks % FULL_WALK_EVERY === 0;
      this.ticks++;
      const agents = await this.scanner.scan(now, rediscover);
      if (this.scanner.complete) {
        // Only a complete pass may be judged. The first complete pass sets the baseline (everything already done is quiet);
        // later complete passes report real running -> done changes once.
        this.watcher.observe(agents);
        this.snap = { ...this.snap, ready: true, agents, finishedToday: today(agents, now), scanError: null, scanning: false, now };
        this.hadComplete = true;
      } else {
        // A partial pass (the backend has more to read): keep the last complete picture, or none yet, and say so.
        this.snap = this.hadComplete ? { ...this.snap, ready: true, scanError: null, scanning: true, now } : { ...this.snap, ready: true, agents: [], finishedToday: [], scanError: null, scanning: true, now };
      }
      this.recompute();
      if (this.backend.now() - this.ghAt >= GITHUB_REFRESH_MS) void this.refreshGithub(false);
    } catch (e) {
      this.snap = { ...this.snap, ready: true, scanError: errMessage(e) };
    } finally {
      this.busy = false;
      this.emit();
    }
    void this.publishTray();
  }

  private recompute(): void {
    const s = this.settings.settings;
    const hits = attention(this.snap.repos, s.prAlert);
    const sum = summary(hits);
    this.snap = { ...this.snap, hits, attention: sum ? { text: sum[0], repo: sum[1] } : null };
  }

  async publishTray(): Promise<void> {
    const running = this.snap.agents.filter((a) => a.state === 'running').length;
    try { await this.backend.setTrayLabel(trayLabel(running, this.snap.finishedToday.length)); } catch { /* the tray is a bonus */ }
  }

  private ghRun: Promise<void> = Promise.resolve();
  refreshGithub(force: boolean): Promise<void> {
    if (this.ghBusy) return this.ghRun;
    this.ghRun = this.doGithub(force);
    return this.ghRun;
  }

  private async doGithub(force: boolean): Promise<void> {
    if (!force && this.backend.now() - this.ghAt < GITHUB_REFRESH_MS) return;
    this.ghBusy = true;
    this.ghAt = this.backend.now();
    this.snap = { ...this.snap, ghLoading: true };
    this.emit();
    try {
      if (!this.backend.gh) throw new Error('GH_MISSING');
      const [login, repos] = await fetchWithStatus(this.book, this.backend.gh, this.backend.now() / 1000, 50);
      this.snap = { ...this.snap, repos, login, ghError: null, ghUpdated: this.backend.now() };
    } catch (e) {
      this.snap = { ...this.snap, ghError: ghErrorText(e) }; // the last good list stays on screen
    } finally {
      this.ghBusy = false;
      this.snap = { ...this.snap, ghLoading: false };
      this.recompute();
      this.emit();
    }
  }

  /** The computer slept: what was seen before may be stale. Walk the folders again on the next tick and refresh GitHub. */
  onSlept(): void {
    this.ticks = 0;
    this.ghAt = -Infinity;
  }

  async openRepo(r: Repo): Promise<void> {
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/.exec(r.url);
    if (m) await this.backend.openRepo(m[1]!);
  }
}

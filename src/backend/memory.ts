// The browser-preview backend (screenshots, ui-smoke, development): synthetic transcripts and a fake gh, files in memory.
import type { Backend } from './types';
import type { ScanBackend, ScanFile, ScanReply } from '../core/agents';
import { ConflictError, sameStamp, type FileIO, type FileStamp } from '../core/io';
import type { GhBackend } from '../core/github';
import { demoFleet } from '../../tools/synth';
import type { Rec } from '../core/transcripts';

export class MemoryIO implements FileIO {
  files = new Map<string, { text: string; stamp: FileStamp }>();
  private n = 1;
  async read(name: string) { return this.files.get(name)?.text ?? null; }
  async stat(name: string) { return this.files.get(name)?.stamp ?? null; }
  async write(name: string, text: string, expected?: FileStamp | null) {
    const cur = this.files.get(name)?.stamp ?? null;
    if (expected !== undefined && !sameStamp(expected, cur)) throw new ConflictError();
    this.n++;
    this.files.set(name, { text, stamp: { size: text.length, mtimeUs: this.n, ctimeUs: this.n, ino: String(this.n) } });
  }
  async moveAside(name: string, backupName: string) { const f = this.files.get(name); if (f) { this.files.delete(name); this.files.set(backupName, f); } return backupName; }
}

/** Serves a fixed set of transcripts once (everything is "new" on the first call, nothing afterwards). */
export class MemoryScan implements ScanBackend {
  private sent = false;
  constructor(private files: ScanFile[]) {}
  async scan(): Promise<ScanReply> {
    const known = this.files.map((f) => ({ path: f.path, kind: f.kind, mtimeMs: f.mtimeMs }));
    if (this.sent) return { files: [], known, more: false };
    this.sent = true;
    return { files: this.files, known, more: false };
  }
}

/** Titles and names built to break layouts: unbroken words, long numbers, a long project-like path, RTL text. */
export const HOSTILE_TITLE = 'Pneumonoultramicroscopicsilicovolcanoconiosis_refactor_authentication_middleware_1234567890123456789012345678901234567890 \u0645\u06cc\u0627\u0646\u200c\u0627\u0641\u0632\u0627\u0631';

export function demoScanFiles(nowSec: number, hostile = false): ScanFile[] {
  return demoFleet(nowSec).map((a) => {
    const records = a.lines.map((l) => JSON.parse(l) as Rec);
    const last = records[records.length - 1]!;
    const mtimeMs = Date.parse(String(last.timestamp)) || nowSec * 1000;
    return {
      path: a.kind === 'claude' ? `/demo/projects/-demo-app/s1/subagents/${a.name}.jsonl` : `/demo/sessions/2026/10/07/${a.name}.jsonl`,
      kind: a.kind, mtimeMs, reset: true, records,
      ...(a.kind === 'claude' ? { meta: { agentType: hostile ? 'general-purpose-with-a-very-long-agent-type-name' : a.agentType, description: hostile ? HOSTILE_TITLE : a.description } } : {}),
    };
  });
}

const nowIso = (sec: number) => new Date(sec * 1000).toISOString();

export function demoGh(nowSec: number, mode: 'ok' | 'missing' | 'login' | 'rate' = 'ok', hostile = false): GhBackend {
  const repo = (name: string, agoMin: number, issues: number, prs: number, lang: string, stars: number, priv = false) => ({
    name, description: `Synthetic ${name} repository`, primaryLanguage: { name: lang }, stargazerCount: stars, pushedAt: nowIso(nowSec - agoMin * 60),
    url: `https://github.com/demo-user/${name}`, isPrivate: priv, isFork: false, isArchived: false, issues: { totalCount: issues }, pullRequests: { totalCount: prs },
  });
  const long = 'a-repository-with-an-extremely-long-name-that-never-breaks-at-all-1234567890';
  const repos = [repo(hostile ? long : 'agents-bar', 5, 2, 1, 'TypeScript', 12), repo(hostile ? `${long}-2` : 'pos-demo', 90, 0, 5, 'JavaScript', 3), repo('notes-site', 600, 7, 0, 'HTML', 1, true), repo('tiny-cli', 3000, 0, 0, 'Rust', 0)];
  const ci: Record<string, string> = { 'agents-bar': 'success', 'pos-demo': 'failure', [long]: 'success', [`${long}-2`]: 'failure', 'notes-site': 'in_progress', 'tiny-cli': '' };
  const fail = () => { throw new Error(mode === 'missing' ? 'GH_MISSING' : mode === 'login' ? 'GH_NOT_LOGGED_IN' : 'GH_RATE_LIMIT'); };
  return {
    async user() { if (mode !== 'ok') fail(); return 'demo-user\n'; },
    async repoList() { if (mode !== 'ok') fail(); return JSON.stringify(repos); },
    async runList(slug) {
      const c = ci[slug.split('/')[1]!];
      if (c === undefined || c === '') return '[]';
      return JSON.stringify(c === 'in_progress' ? [{ status: 'in_progress', conclusion: null }] : [{ status: 'completed', conclusion: c }]);
    },
  };
}

export interface PreviewOptions { now?: number; gh?: 'ok' | 'missing' | 'login' | 'rate'; empty?: boolean; hostile?: boolean }

export function memoryBackend(o: PreviewOptions = {}): Backend {
  const nowMs = o.now ?? Date.now();
  const nowSec = nowMs / 1000;
  return {
    kind: 'browser', platform: 'linux', io: new MemoryIO(), dataDir: '(in memory)', now: () => nowMs, trayNote: null,
    scan: new MemoryScan(o.empty ? [] : demoScanFiles(nowSec, o.hostile)),
    gh: demoGh(nowSec, o.gh ?? 'ok', o.hostile),
    notify: async () => true, notifyOff: true,
    setTrayLabel: async () => {}, hide: async () => {}, quit: async () => {}, revealTranscript: async () => {}, openRepo: async () => {}, openProfile: async () => {},
    autostart: { isEnabled: async () => false, set: async () => {} },
    onTick: (cb) => { const t = setInterval(cb, 3000); return () => clearInterval(t); },
    onShown: () => () => {},
  };
}

// GitHub through the logged-in `gh` CLI only (port of github_core.py + github_status.py). This file never spawns anything:
// the GhBackend (a Rust command with fixed argv shapes, a timeout and no shell) returns raw text.
import { clean } from "./text";

export const MAX_CI_LOOKUPS = 8; // `gh run list` is called for at most this many repos (the newest pushed)
export const CI_TTL = 300;
export const CI_STALE = 3 * CI_TTL; // when lookups keep failing an old answer is shown this long, then 'status unavailable'
export const NAME_BUDGET = 40;
export const CALL_TIMEOUT = 10; // seconds, enforced by the Rust command
export const TOTAL_BUDGET = 45; // seconds for all CI lookups of one refresh together
export const MAX_COUNT = 10_000_000;
export const CI_VALUES = ['passing', 'failing', 'running', 'none', 'unknown'] as const;
export type Ci = (typeof CI_VALUES)[number];

export const FIELDS = 'name,description,primaryLanguage,stargazerCount,pushedAt,url,isPrivate,isFork,isArchived';
export const EXTRA_FIELDS = `${FIELDS},issues,pullRequests`;

export interface Repo {
  name: string; description: string; language: string; stars: number; pushed: number; url: string;
  private: boolean; fork: boolean; archived: boolean; issues: number | null; prs: number | null; ci: Ci | null;
}

/** The door to gh. Every method returns gh's stdout or throws an Error whose message is a GhErrorCode or plain text. */
export interface GhBackend {
  user(): Promise<string>;
  repoList(fields: string, limit: number): Promise<string>;
  runList(slug: string): Promise<string>;
}

export const GH_MISSING = 'GH_MISSING', GH_NOT_LOGGED_IN = 'GH_NOT_LOGGED_IN', GH_RATE_LIMIT = 'GH_RATE_LIMIT', GH_TIMEOUT = 'GH_TIMEOUT';

/** The short sentence the UI shows for an error from the backend. */
export function ghErrorText(e: unknown): string {
  const m = (e instanceof Error ? e.message : typeof e === 'string' ? e : '') || '';
  if (m.includes(GH_MISSING) || m.includes('gh is not installed')) return 'gh is not installed. Install the GitHub CLI to see your repositories.';
  if (m.includes(GH_NOT_LOGGED_IN) || m.includes('not logged in')) return 'Not logged in to GitHub. Run: gh auth login';
  if (m.includes(GH_RATE_LIMIT)) return 'GitHub rate limit reached. Try again in a few minutes.';
  if (m.includes(GH_TIMEOUT) || m.includes('timed out')) return 'GitHub took too long to answer.';
  const first = clean(m.replace(/^GH_FAILED:?/, ''), 120);
  return first ? `GitHub could not be reached: ${first}` : 'GitHub could not be reached.';
}

const text = (v: unknown, limit?: number): string => clean(typeof v === 'string' ? v : '', limit);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null);
const totalCount = (v: unknown): number | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? num((v as Record<string, unknown>).totalCount) : null);

export function pushedEpoch(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const t = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? 0 : t / 1000;
}

/** `gh repo list --json` output as Repos, most recently pushed first. Odd entries are dropped or blanked; output that is
 * not a JSON list at all throws, so the caller keeps the last good list. */
export function parseRepos(raw: string): Repo[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error('GitHub sent a repository list that could not be read'); }
  if (!Array.isArray(data)) throw new Error('GitHub sent a repository list that could not be read');
  const repos: Repo[] = [];
  for (const r of data) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) continue;
    const o = r as Record<string, unknown>;
    if (!text(o.name)) continue;
    const lang = o.primaryLanguage;
    const stars = o.stargazerCount;
    repos.push({
      name: text(o.name, 100), description: text(o.description, 300),
      language: typeof lang === 'object' && lang !== null && !Array.isArray(lang) ? text((lang as Record<string, unknown>).name, 30) : '',
      stars: typeof stars === 'number' && Number.isInteger(stars) && stars >= 0 ? stars : 0,
      pushed: pushedEpoch(o.pushedAt), url: text(o.url), private: Boolean(o.isPrivate), fork: Boolean(o.isFork), archived: Boolean(o.isArchived),
      issues: totalCount(o.issues), prs: totalCount(o.pullRequests), ci: null,
    });
  }
  return repos.sort((a, b) => b.pushed - a.pushed);
}

const RUNNING = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const FAILING = new Set(['failure', 'timed_out', 'startup_failure']);
// GitHub owner: letters, digits, hyphen; repo: letters, digits, dot, underscore, hyphen. Same pattern the Rust side uses.
// (letters, digits, hyphen, and underscore for Enterprise Managed User logins like name_company; no `--`, no trailing hyphen)
export const OWNER_RE = /^(?!.*--)[A-Za-z0-9][A-Za-z0-9_-]{0,38}(?<!-)$/;
export const REPO_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/;
const SLUG = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9_.-]+)\/?$/;

/** 'owner/name' from a github.com repo URL, or null (also for anything that could be an option or a path trick). */
export function slug(url: unknown): string | null {
  const m = typeof url === 'string' ? SLUG.exec(url) : null;
  if (!m || m[2] === '.' || m[2] === '..' || !OWNER_RE.test(m[1]!) || !REPO_RE.test(m[2]!)) return null;
  return `${m[1]}/${m[2]}`;
}

/** passing | failing | running | none from `gh run list --limit 1 --json status,conclusion`; throws when it is not a JSON list. */
export function parseCi(raw: string): Ci {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error('unreadable run list'); }
  if (!Array.isArray(data)) throw new Error('run list is not a list');
  const run = data.find((r) => typeof r === 'object' && r !== null && !Array.isArray(r)) as Record<string, unknown> | undefined;
  if (!run) return 'none';
  const { status, conclusion } = run;
  if (typeof status !== 'string') return 'none'; // null or a list/dict: no verdict
  if (RUNNING.has(status)) return 'running';
  if (status === 'completed' && typeof conclusion === 'string') {
    if (conclusion === 'success') return 'passing';
    if (FAILING.has(conclusion)) return 'failing';
  }
  return 'none'; // cancelled, skipped, neutral, odd values
}

export interface BookOptions { gh: GhBackend; mono?: () => number; log?: (m: string) => void }

/** CI answers remembered between refreshes: {slug: [when, ci]}. Lookups rotate: with more than MAX_CI_LOOKUPS repos each
 * refresh checks the next window of the newest-first list. */
export class StatusBook {
  cache = new Map<string, [number, Ci]>();
  cursor: string | null = null;
  constructor(private o: BookOptions) {}

  private window(eligible: Repo[]): Repo[] {
    const n = eligible.length;
    if (n <= MAX_CI_LOOKUPS) return [...eligible];
    const slugs = eligible.map((r) => slug(r.url));
    const at = this.cursor === null ? -1 : slugs.indexOf(this.cursor);
    const start = at >= 0 ? (at + 1) % n : 0;
    const picks = Array.from({ length: MAX_CI_LOOKUPS }, (_, i) => (start + i) % n).sort((a, b) => a - b);
    this.cursor = slugs[(start + MAX_CI_LOOKUPS - 1) % n] ?? null;
    return picks.map((i) => eligible[i]!);
  }

  /** Sets repo.ci on the current window of newest-pushed repos. One repo failing leaves the others (and the list) alone. */
  async annotate(repos: Repo[], now: number): Promise<Repo[]> {
    const mono = this.o.mono ?? (() => performance.now() / 1000);
    for (const r of repos) r.ci = null;
    const eligible = [...repos].sort((a, b) => b.pushed - a.pushed).filter((r) => slug(r.url));
    const win = this.window(eligible);
    const inWin = new Set(win);
    const deadline = mono() + TOTAL_BUDGET;
    const keep = new Map<string, [number, Ci]>();
    for (const r of eligible) {
      if (inWin.has(r)) continue;
      const key = slug(r.url)!;
      const hit = this.cache.get(key);
      if (hit && now - hit[0] >= 0 && now - hit[0] < CI_STALE) { r.ci = hit[1]; keep.set(key, hit); }
    }
    for (const r of win) {
      const key = slug(r.url)!;
      let hit = this.cache.get(key) ?? null;
      try {
        if (hit && now - hit[0] >= 0 && now - hit[0] < CI_TTL) r.ci = hit[1];
        else {
          let ci: Ci | null = null;
          if (mono() < deadline) {
            try { ci = parseCi(await this.o.gh.runList(key)); } catch { ci = null; }
          }
          if (ci !== null) hit = [now, ci];
          else if (hit && !(now - hit[0] >= 0 && now - hit[0] < CI_STALE)) hit = null; // too old to trust: forget it
          r.ci = hit ? hit[1] : 'unknown'; // a recent answer, else a quiet 'status unavailable'
        }
      } catch (e) {
        this.o.log?.(`github status for one repo failed: ${String(e)}`);
        r.ci = 'unknown'; hit = null;
      }
      if (hit) keep.set(key, hit);
    }
    this.cache = keep;
    return repos;
  }
}

/** [login, repos] with issue/PR counts and CI results. Only the repo list itself can throw. */
export async function fetchWithStatus(book: StatusBook, gh: GhBackend, now: number, limit = 50): Promise<[string, Repo[]]> {
  let repos: Repo[];
  const who = gh.user().then((s) => s.trim()).catch(() => '');
  try {
    repos = parseRepos(await gh.repoList(EXTRA_FIELDS, limit));
  } catch (e) {
    if (!/unknown json field/i.test(e instanceof Error ? e.message : String(e))) throw e;
    repos = parseRepos(await gh.repoList(FIELDS, limit)); // an older gh: no counts, still the list
  }
  try { await book.annotate(repos, now); } catch { /* status is a bonus: the list is the product */ }
  return [await who, repos];
}

// ---- text ----------------------------------------------------------------------------------------------------

const plural = (n: number, word: string, pl?: string) => `${n.toLocaleString('en-US')} ${n === 1 ? word : pl ?? `${word}s`}`;
const ciOf = (r: Partial<Repo> | null | undefined): Ci | null => (r && (CI_VALUES as readonly unknown[]).includes(r.ci) ? (r.ci as Ci) : null);
const numOf = (v: unknown): number | null => num(v);

export function hasLine(r: Partial<Repo> | null | undefined): boolean {
  return !!r && (numOf(r.issues) !== null || numOf(r.prs) !== null || ciOf(r) !== null);
}

export type Role = 'plain' | 'bad' | 'good' | 'quiet';
/** [(text, role)] for the status line. The CI result is always words. */
export function segments(r: Partial<Repo> | null | undefined): [string, Role][] {
  if (!r) return [];
  const out: [string, Role][] = [];
  const issues = numOf(r.issues), prs = numOf(r.prs), ci = ciOf(r);
  if (issues !== null) out.push([plural(issues, 'issue'), 'plain']);
  if (prs !== null) out.push([plural(prs, 'PR'), 'plain']);
  if (ci === 'failing') out.push(['CI failing', 'bad']);
  else if (ci === 'passing') out.push(['CI passing', 'good']);
  else if (ci === 'running') out.push(['CI running', 'plain']);
  else if (ci === 'none') out.push(['no CI', 'quiet']);
  else if (ci === 'unknown') out.push(['status unavailable', 'quiet']);
  return out;
}
export const line = (r: Partial<Repo> | null | undefined): string => segments(r).map(([t]) => t).join(' · ');

/** The status for a screen reader. */
export function spoken(r: Partial<Repo> | null | undefined): string {
  if (!r) return '';
  const parts: string[] = [];
  const issues = numOf(r.issues), prs = numOf(r.prs), ci = ciOf(r);
  if (issues !== null) parts.push(plural(issues, 'open issue'));
  if (prs !== null) parts.push(plural(prs, 'open pull request'));
  if (ci) parts.push({ failing: 'CI failing', passing: 'CI passing', running: 'CI running', none: 'no CI', unknown: 'status unavailable' }[ci]);
  return parts.join(', ');
}

export type Hit = [Repo, string];
/** [(repo, reason)] for repos with failing CI or more open PRs than prLimit; failing CI first. */
export function attention(repos: Repo[] | null | undefined, prLimit: unknown): Hit[] {
  if (typeof prLimit !== 'number' || !Number.isInteger(prLimit)) return [];
  const hits: Hit[] = [];
  for (const r of repos ?? []) {
    if (typeof r?.name !== 'string' || !r.name.trim()) continue;
    const why: string[] = [];
    if (ciOf(r) === 'failing') why.push('CI failing');
    const prs = numOf(r.prs);
    if (prs !== null && prs > prLimit) why.push(`${prs.toLocaleString('en-US')} open PRs`);
    if (why.length) hits.push([r, why.join(', ')]);
  }
  return hits.sort((a, b) => Number(!a[1].includes('CI failing')) - Number(!b[1].includes('CI failing')));
}

/** 'repo-a, repo-b, +2': names while they fit NAME_BUDGET characters, the rest as +N. */
export function namesText(hits: Hit[]): string {
  const names = hits.map(([r]) => clean(r.name, 30));
  const shown: string[] = [];
  let used = 0;
  for (const nm of names) {
    if (shown.length && used + Array.from(nm).length + 2 > NAME_BUDGET) break;
    shown.push(nm);
    used += Array.from(nm).length + 2;
  }
  const left = names.length - shown.length;
  return shown.join(', ') + (left ? `, +${left}` : '');
}

/** [text, repo to open] for the 'Needs attention' line, or null when everything is fine. */
export function summary(hits: Hit[]): [string, Repo] | null {
  if (!hits.length) return null;
  const [first, why] = hits[0]!;
  if (hits.length === 1) return [clean(`Needs attention · ${clean(first.name, 30)}: ${why}`, 120), first];
  return [clean(`Needs attention · ${namesText(hits)}`, 120), first];
}

export function spokenAttention(hits: Hit[]): string {
  if (!hits.length) return '';
  const parts = hits.slice(0, 10).map(([r, why]) => `${clean(r.name, 60)}: ${why}`).join('; ');
  return `Needs attention: ${parts}${hits.length > 10 ? `; and ${hits.length - 10} more` : ''}`;
}

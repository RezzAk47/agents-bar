import { describe, expect, it } from 'vitest';
import { CI_STALE, CI_TTL, MAX_CI_LOOKUPS, StatusBook, TOTAL_BUDGET, attention, fetchWithStatus, ghErrorText, hasLine, line, namesText, parseCi, parseRepos, slug, spoken, spokenAttention, summary, type GhBackend, type Repo } from '../src/core/github';

const NOW = 1_760_000_000;
const iso = (s: number) => new Date(s * 1000).toISOString();
const raw = (names: string[], extra: Record<string, unknown> = {}) => JSON.stringify(names.map((n, i) => ({ name: n, description: `d ${n}`, primaryLanguage: { name: 'Rust' }, stargazerCount: i, pushedAt: iso(NOW - i * 100), url: `https://github.com/me/${n}`, isPrivate: false, isFork: false, isArchived: false, issues: { totalCount: 1 }, pullRequests: { totalCount: 2 }, ...extra })));
const repo = (name: string, o: Partial<Repo> = {}): Repo => ({ name, description: '', language: '', stars: 0, pushed: NOW, url: `https://github.com/me/${name}`, private: false, fork: false, archived: false, issues: null, prs: null, ci: null, ...o });

function fakeGh(over: Partial<GhBackend> & { ci?: (slug: string) => string | Promise<string> } = {}) {
  const calls: string[][] = [];
  const gh: GhBackend = {
    async user() { calls.push(['user']); return 'me\n'; },
    async repoList(f, l) { calls.push(['repoList', f, String(l)]); return raw(Array.from({ length: 20 }, (_, i) => `r${i}`)); },
    async runList(s) { calls.push(['runList', s]); return over.ci ? over.ci(s) : '[{"status":"completed","conclusion":"success"}]'; },
    ...over,
  };
  return { gh, calls, runs: () => calls.filter((c) => c[0] === 'runList') };
}

describe('parsing', () => {
  it('repos: counts parsed defensively, newest first, odd entries dropped', () => {
    const list = parseRepos(JSON.stringify([
      { name: 'old', pushedAt: iso(NOW - 999), issues: { totalCount: 3 }, pullRequests: { totalCount: 0 } },
      { name: 'new', pushedAt: iso(NOW), issues: { totalCount: 'many' }, pullRequests: { totalCount: -1 }, primaryLanguage: null, stargazerCount: 'x' },
      { name: '' }, null, 5, [], { name: 5 }, { name: 'big', issues: { totalCount: 1e12 }, pullRequests: true },
    ]));
    expect(list.map((r) => r.name)).toEqual(['new', 'old', 'big']);
    expect(list[0]).toMatchObject({ issues: null, prs: null, language: '', stars: 0 });
    expect(list[1]).toMatchObject({ issues: 3, prs: 0 });
    expect(list[2]).toMatchObject({ issues: null, prs: null });
    expect(parseRepos(raw(['a'], { pushedAt: '2026-01-01T00:00:00.123456789Z' }))[0]!.pushed).toBeGreaterThan(0);
  });
  it('a reply that is not a list throws; hostile text is cleaned', () => {
    for (const bad of ['', 'nope', '{}', '5', 'null']) expect(() => parseRepos(bad)).toThrow();
    expect(parseRepos(JSON.stringify([{ name: 'a‮b\nc' }]))[0]!.name).toBe('ab c');
  });
  it('CI result mapping', () => {
    const run = (status: unknown, conclusion: unknown = null) => parseCi(JSON.stringify([{ status, conclusion }]));
    expect(run('completed', 'success')).toBe('passing');
    for (const c of ['failure', 'timed_out', 'startup_failure']) expect(run('completed', c)).toBe('failing');
    for (const s of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) expect(run(s)).toBe('running');
    for (const c of ['cancelled', 'skipped', 'neutral', 'weird', null, 5, [], {}]) expect(run('completed', c)).toBe('none');
    for (const s of [null, 5, [], {}, true]) expect(run(s, 'success')).toBe('none');
    expect(parseCi('[]')).toBe('none');
    expect(parseCi('[5,null]')).toBe('none');
    expect(() => parseCi('{}')).toThrow();
    expect(() => parseCi('nope')).toThrow();
  });
  it('slug from a github url, and nothing that could be an option or a path trick', () => {
    expect(slug('https://github.com/me/tool')).toBe('me/tool');
    expect(slug('https://github.com/me/tool/')).toBe('me/tool');
    for (const bad of ['http://github.com/me/tool', 'https://github.com/me', 'https://github.com/-x/tool', 'https://github.com/me/..', 'https://github.com/me/.', 'https://evil.com/me/tool', 'https://github.com/me/tool/extra', '--repo', '', null, 5, 'https://github.com/me/tool?x=1', 'https://github.com/me/to ol', `https://github.com/${'a'.repeat(40)}/x`]) expect(slug(bad), String(bad)).toBeNull();
  });
});

describe('StatusBook', () => {
  it('capped at 8 lookups, newest first; others get no CI line', async () => {
    const { gh, runs } = fakeGh();
    const repos = parseRepos(raw(Array.from({ length: 20 }, (_, i) => `r${i}`)));
    await new StatusBook({ gh }).annotate(repos, NOW);
    expect(runs()).toHaveLength(MAX_CI_LOOKUPS);
    expect(repos.filter((r) => r.ci === 'passing')).toHaveLength(8);
    expect(repos.filter((r) => r.ci === null)).toHaveLength(12);
    expect(runs().map((c) => c[1])).toEqual(Array.from({ length: 8 }, (_, i) => `me/r${i}`));
  });
  it('windows rotate: every repo is covered, never more than 8 calls per refresh', async () => {
    const { gh, runs } = fakeGh();
    const book = new StatusBook({ gh });
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const before = runs().length;
      const repos = parseRepos(raw(Array.from({ length: 20 }, (_, k) => `r${k}`)));
      await book.annotate(repos, NOW + (i + 1) * (CI_TTL + 1));
      expect(runs().length - before).toBeLessThanOrEqual(8);
      for (const c of runs().slice(before)) seen.add(c[1]!);
    }
    expect(seen.size).toBe(20);
  });
  it('second window starts after the last repo checked; a removed cursor restarts from the newest; <= 8 repos are all checked every time', async () => {
    const { gh, runs } = fakeGh();
    const book = new StatusBook({ gh });
    const mk = () => parseRepos(raw(Array.from({ length: 20 }, (_, k) => `r${k}`)));
    await book.annotate(mk(), NOW);
    const n0 = runs().length;
    await book.annotate(mk(), NOW + CI_TTL + 1);
    expect(runs().slice(n0).map((c) => c[1])).toEqual(Array.from({ length: 8 }, (_, i) => `me/r${8 + i}`));
    book.cursor = 'me/gone';
    const n1 = runs().length;
    await book.annotate(mk(), NOW + 2 * (CI_TTL + 1));
    expect(runs().slice(n1)[0]![1]).toBe('me/r0');
    const small = new StatusBook({ gh: fakeGh().gh });
    const f2 = fakeGh();
    const b2 = new StatusBook({ gh: f2.gh });
    await b2.annotate(parseRepos(raw(['a', 'b', 'c'])), NOW);
    await b2.annotate(parseRepos(raw(['a', 'b', 'c'])), NOW + CI_TTL + 1);
    expect(f2.runs()).toHaveLength(6);
    void small;
  });
  it('an answer is cached for 5 minutes', async () => {
    const f = fakeGh(); const book = new StatusBook({ gh: f.gh });
    const mk = () => parseRepos(raw(['a', 'b']));
    await book.annotate(mk(), NOW);
    await book.annotate(mk(), NOW + CI_TTL - 1);
    expect(f.runs()).toHaveLength(2);
    await book.annotate(mk(), NOW + CI_TTL + 1);
    expect(f.runs()).toHaveLength(4);
  });
  it('one failing repo keeps its last good answer; after 3 TTLs it becomes "status unavailable"; a clock set back does not keep it alive', async () => {
    let fail = false;
    const f = fakeGh({ ci: () => { if (fail) throw new Error('boom'); return '[{"status":"completed","conclusion":"failure"}]'; } });
    const book = new StatusBook({ gh: f.gh });
    const mk = () => parseRepos(raw(['a']));
    let r = mk(); await book.annotate(r, NOW); expect(r[0]!.ci).toBe('failing');
    fail = true;
    r = mk(); await book.annotate(r, NOW + CI_TTL + 1); expect(r[0]!.ci).toBe('failing'); // kept
    r = mk(); await book.annotate(r, NOW + CI_STALE - 1); expect(r[0]!.ci).toBe('failing');
    r = mk(); await book.annotate(r, NOW + CI_STALE + 1); expect(r[0]!.ci).toBe('unknown');
    fail = false;
    r = mk(); await book.annotate(r, NOW + CI_STALE + 2); expect(r[0]!.ci).toBe('failing'); // a good answer comes back
    fail = true;
    r = mk(); await book.annotate(r, NOW - 10_000); expect(r[0]!.ci).toBe('unknown'); // clock set back
  });
  it('one repo raising anything does not stop the others', async () => {
    const f = fakeGh({ ci: (s) => { if (s.endsWith('/a')) throw new Error('x'); return '[{"status":"completed","conclusion":"success"}]'; } });
    const r = parseRepos(raw(['a', 'b']));
    await new StatusBook({ gh: f.gh }).annotate(r, NOW);
    expect(Object.fromEntries(r.map((x) => [x.name, x.ci]))).toEqual({ a: 'unknown', b: 'passing' });
  });
  it('the 45 s budget stops lookups; the rest keep the last answer or show unavailable', async () => {
    let t = 0;
    const f = fakeGh({ ci: () => { t += 20; return '[{"status":"completed","conclusion":"success"}]'; } });
    const r = parseRepos(raw(['a', 'b', 'c', 'd', 'e']));
    await new StatusBook({ gh: f.gh, mono: () => t }).annotate(r, NOW);
    expect(f.runs()).toHaveLength(3); // 0, 20, 40 are inside the budget; 60 is not
    expect(TOTAL_BUDGET).toBe(45);
    expect(r.map((x) => x.ci)).toEqual(['passing', 'passing', 'passing', 'unknown', 'unknown']);
  });
  it('only the repo list can fail a refresh; an old gh without the count fields falls back', async () => {
    const calls: string[] = [];
    const gh: GhBackend = {
      async user() { return 'me'; },
      async repoList(fields) { calls.push(fields); if (fields.includes('issues')) throw new Error('Unknown JSON field: "issues"'); return raw(['a']); },
      async runList() { return '[]'; },
    };
    const [login, repos] = await fetchWithStatus(new StatusBook({ gh }), gh, NOW);
    expect(login).toBe('me');
    expect(repos[0]!.name).toBe('a');
    expect(calls).toHaveLength(2);
    const dead: GhBackend = { user: async () => { throw new Error('x'); }, repoList: async () => { throw new Error('GH_MISSING'); }, runList: async () => '[]' };
    await expect(fetchWithStatus(new StatusBook({ gh: dead }), dead, NOW)).rejects.toThrow('GH_MISSING');
    const noRuns: GhBackend = { ...gh, repoList: async () => raw(['a']), runList: async () => { throw new Error('x'); } };
    expect((await fetchWithStatus(new StatusBook({ gh: noRuns }), noRuns, NOW))[1][0]!.ci).toBe('unknown');
  });
});

describe('error wording', () => {
  it('missing, not logged in, rate limit, timeout, other', () => {
    expect(ghErrorText(new Error('GH_MISSING'))).toMatch(/not installed/);
    expect(ghErrorText(new Error('GH_NOT_LOGGED_IN'))).toMatch(/gh auth login/);
    expect(ghErrorText(new Error('GH_RATE_LIMIT'))).toMatch(/rate limit/);
    expect(ghErrorText(new Error('GH_TIMEOUT'))).toMatch(/too long/);
    expect(ghErrorText('GH_FAILED: some\nthing')).toBe('GitHub could not be reached: some thing');
    expect(ghErrorText(undefined)).toBe('GitHub could not be reached.');
  });
});

describe('status line, attention and wording (vectors from the Mac tests)', () => {
  it('status line words', () => {
    expect(line(repo('a', { issues: 2, prs: 1, ci: 'failing' }))).toBe('2 issues · 1 PR · CI failing');
    expect(line(repo('a', { issues: 1, prs: 3, ci: 'passing' }))).toBe('1 issue · 3 PRs · CI passing');
    expect(line(repo('a', { issues: 0, prs: 0, ci: 'running' }))).toBe('0 issues · 0 PRs · CI running');
    expect(line(repo('a', { ci: 'none' }))).toBe('no CI');
    expect(line(repo('a', { ci: 'unknown' }))).toBe('status unavailable');
    expect(line(repo('a', { issues: 5 }))).toBe('5 issues');
    expect(line(repo('a'))).toBe('');
    expect(hasLine(repo('a'))).toBe(false);
    expect(hasLine(repo('a', { ci: 'none' }))).toBe(true);
    expect(line(repo('a', { issues: 12345 }))).toBe('12,345 issues');
    expect(spoken(repo('a', { issues: 1, prs: 2, ci: 'failing' }))).toBe('1 open issue, 2 open pull requests, CI failing');
  });
  it('hostile values never throw', () => {
    const r = repo('x') as unknown as Record<string, unknown>;
    r.prs = 'lots'; r.ci = 5; r.name = null;
    expect(() => { line(r as never); spoken(r as never); attention([r as never], 3); summary(attention([r as never], 3)); }).not.toThrow();
    expect(attention([repo('a', { prs: 9 })], 'x')).toEqual([]);
    expect(attention(null, 3)).toEqual([]);
  });
  it('failing CI or too many PRs; failing first; threshold configurable', () => {
    const got = attention([repo('fine', { ci: 'passing', prs: 3 }), repo('prs', { ci: 'passing', prs: 4 }), repo('fail', { ci: 'failing', prs: 0 }), repo('edge')], 3);
    expect(got.map(([r, why]) => [r.name, why])).toEqual([['fail', 'CI failing'], ['prs', '4 open PRs']]);
    expect(attention([repo('x', { ci: 'passing', prs: 2 })], 3)).toEqual([]);
    expect(attention([repo('x', { ci: 'passing', prs: 2 })], 1)).toHaveLength(1);
  });
  it('summary names the repos and says which one opens', () => {
    expect(summary([])).toBeNull();
    const r1 = repo('fail', { ci: 'failing' }), r2 = repo('prs', { prs: 9 });
    expect(summary(attention([r1], 3))).toEqual(['Needs attention · fail: CI failing', r1]);
    const [text, target] = summary(attention([r2, r1], 3))!;
    expect(text).toBe('Needs attention · fail, prs');
    expect(target).toBe(r1);
  });
  it('long lists are cut with +N, one huge name is cut, voiceover lists everything', () => {
    const many = attention(Array.from({ length: 6 }, (_, i) => repo(`project-number-${i}`, { ci: 'failing' })), 3);
    const [text] = summary(many)!;
    expect(text).toMatch(/^Needs attention · project-number-0(, project-number-\d)*, \+\d$/);
    expect(text.split('+')[1]).toBe(String(6 - (text.match(/project-number/g) ?? []).length));
    expect(text.length).toBeLessThanOrEqual(120);
    const huge = summary(attention([repo('x'.repeat(500), { ci: 'failing' }), repo('y'.repeat(20), { ci: 'failing' })], 3))![0];
    expect(huge.length).toBeLessThanOrEqual(120);
    expect(huge).toContain('+1');
    expect(spokenAttention(attention([repo('repo-a', { ci: 'failing' }), repo('repo-b', { prs: 9 })], 3))).toBe('Needs attention: repo-a: CI failing; repo-b: 9 open PRs');
    expect(spokenAttention([])).toBe('');
    expect(namesText(attention([repo('a', { ci: 'failing' })], 3))).toBe('a');
  });
});

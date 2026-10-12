import { describe, expect, it } from 'vitest';
import { memoryBackend } from '../src/backend/memory';
import { Engine } from '../src/ui/engine';
import { selectRows, subtitle, ringOf } from '../src/ui/format';
import { barText, type Agent } from '../src/core/agents';
import { REPO_FETCH_LIMIT, allReposText } from '../src/core/github';

const NOW = Date.UTC(2026, 9, 7, 19, 0, 0);
const mk = (o: Partial<Agent> = {}): Agent => ({ agentId: 'a', kind: 'k', description: 'd', state: 'running', started: 0, lastActivity: NOW / 1000, toolCalls: 38, lastTool: 'Bash', pct: 63, eta: NOW / 1000 + 240, asOf: NOW / 1000, source: 'Claude', path: '/p', active: 190, typical: null, rough: false, reported: true, note: 'running the tests', tokensNew: 212_000, tokensCache: 0, ...o });

describe('engine on the synthetic fleet', () => {
  it('finds running/done/stalled agents, sets the tray text, loads GitHub with attention', async () => {
    const b = memoryBackend({ now: NOW });
    const labels: string[] = [], titles: string[] = [];
    b.setTrayLabel = async (l, t) => { labels.push(l); titles.push(t); };
    const e = new Engine(b);
    await e.init();
    await e.refreshGithub(true);
    const states = e.snap.agents.map((a) => a.state);
    expect(states.filter((s) => s === 'running')).toHaveLength(3);
    expect(states).toContain('stalled');
    expect(labels.at(-1)).toMatch(/^3 running \(average \d+%\) · \d finished$/);
    expect(titles.at(-1)).toBe(barText(e.snap.agents));
    expect(titles.at(-1)).toMatch(/^3 · \d+%$/);
    expect(e.snap.repos).toHaveLength(4);
    expect(e.snap.attention?.text).toBe('Needs attention · pos-demo: CI failing, 5 open PRs');
    expect(e.snap.ghError).toBeNull();
  });
  it('gh errors keep the page alive and say why', async () => {
    const e = new Engine(memoryBackend({ now: NOW, gh: 'login' }));
    await e.init(); await e.refreshGithub(true);
    expect(e.snap.ghError).toMatch(/gh auth login/);
    expect(e.snap.agents.length).toBeGreaterThan(0);
  });
});

describe('row text', () => {
  it('percentage look leads with time left, tokens look with steps and tokens', () => {
    expect(subtitle(mk(), 'percent')).toBe('~4m 00s left · running the tests');
    expect(subtitle(mk(), 'tokens')).toBe('38 steps · 212k tokens · 3m 10s · 63% · running the tests');
    expect(ringOf(mk()).text).toBe('63%');
    expect(ringOf(mk({ reported: false })).text).toBe('~63%');
    expect(ringOf(mk({ pct: null })).text).toBe('…');
    expect(subtitle(mk({ state: 'done' }), 'both')).toContain('Finished');
  });
  it('an agent past its usual time says by how much (Mac parity)', () => {
    const slow = mk({ reported: false, note: '', pct: 97, eta: null, active: 700, typical: 240, tokensNew: null });
    expect(subtitle(slow, 'percent')).toBe('7m 40s over usual (~4m 00s) · 38 steps');
    expect(subtitle(mk({ reported: false, note: '', pct: 97, eta: null, active: 4000, typical: 61, tokensNew: null }), 'percent')).toMatch(/^1h 05m over usual \(~1m 01s\) · /);
  });
  it('never "0s over usual": under one second over, or an unknown usual time, says nothing about it', () => {
    const base = { reported: false, note: '', pct: 97, eta: null, tokensNew: null } as const;
    const barely = subtitle(mk({ ...base, active: 240.4, typical: 240 }), 'percent');
    expect(barely).not.toContain('over usual');
    expect(barely).toBe('38 steps · 4m 00s · on Bash');
    expect(subtitle(mk({ ...base, active: 241, typical: 240 }), 'percent')).toBe('1s over usual (~4m 00s) · 38 steps');
    expect(subtitle(mk({ ...base, active: 100, typical: 0 }), 'percent')).not.toContain('over usual');
    expect(subtitle(mk({ ...base, active: 100, typical: -5 }), 'percent')).not.toContain('over usual');
  });
  it('selectRows caps and lets running agents use unused recent slots', () => {
    const run = Array.from({ length: 10 }, (_, i) => mk({ path: `r${i}` }));
    const rec = Array.from({ length: 2 }, (_, i) => mk({ state: 'done', path: `d${i}` }));
    const r = selectRows([...run, ...rec], 8, 12);
    expect(r.running).toHaveLength(10);
    expect(r.recent).toHaveLength(2);
    const r2 = selectRows([...run, ...Array.from({ length: 9 }, (_, i) => mk({ state: 'done', path: `x${i}` }))], 8, 12);
    expect(r2.running.length + r2.recent.length).toBe(12);
    expect(r2.hidden).toBe(7);
  });
});

describe('the GitHub profile link', () => {
  it('reads like the Mac: all repositories, or how many more', () => {
    const gh = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://github.com/demo-user/r${i}` }));
    expect(allReposText('demo-user', gh(4), 4)).toBe('All repositories on github.com/demo-user');
    expect(allReposText('demo-user', gh(12), 8)).toBe('+4 more on github.com/demo-user');
    expect(allReposText('demo-user', gh(1), 1)).toBe('All repositories on github.com/demo-user');
    for (const bad of ['', 'a--b', '-x', 'x-', 'me/tool', 'evil.com', 'me?tab=x', 'm e', 'a'.repeat(40)]) expect(allReposText(bad, gh(3), 3), bad).toBeNull();
  });
  it('a list as long as the fetch limit may be cut by gh: no made-up count', () => {
    const gh = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://github.com/demo-user/r${i}` }));
    expect(REPO_FETCH_LIMIT).toBe(50);
    expect(allReposText('demo-user', gh(50), 8)).toBe('More on github.com/demo-user');
    expect(allReposText('demo-user', gh(49), 8)).toBe('+41 more on github.com/demo-user');
    expect(allReposText('demo-user', gh(5), 3, 5)).toBe('More on github.com/demo-user');
  });
  it('no profile link when nothing listed is on github.com (an Enterprise host) or the list is empty', () => {
    expect(allReposText('me', [{ url: 'https://ghe.example.com/me/tool' }], 1)).toBeNull();
    expect(allReposText('me', [{ url: '' }], 1)).toBeNull();
    expect(allReposText('me', [], 0)).toBeNull();
    expect(allReposText('me', [{ url: 'https://ghe.example.com/me/a' }, { url: 'https://github.com/me/b' }], 2)).toBe('All repositories on github.com/me');
  });
  it('opens only a valid login from gh, through the backend', async () => {
    const b = memoryBackend({ now: NOW });
    const opened: string[] = [];
    b.openProfile = async (l) => { opened.push(l); };
    const e = new Engine(b);
    await e.init(); await e.refreshGithub(true);
    expect(e.snap.login).toBe('demo-user');
    await e.openProfile();
    expect(opened).toEqual(['demo-user']);
    e.snap = { ...e.snap, login: 'evil.com/x' };
    await e.openProfile();
    e.snap = { ...e.snap, login: '' };
    await e.openProfile();
    expect(opened).toEqual(['demo-user']);
  });
});

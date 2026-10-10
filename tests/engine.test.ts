import { describe, expect, it } from 'vitest';
import { memoryBackend } from '../src/backend/memory';
import { Engine } from '../src/ui/engine';
import { selectRows, subtitle, ringOf } from '../src/ui/format';
import type { Agent } from '../src/core/agents';

const NOW = Date.UTC(2026, 9, 7, 19, 0, 0);
const mk = (o: Partial<Agent> = {}): Agent => ({ agentId: 'a', kind: 'k', description: 'd', state: 'running', started: 0, lastActivity: NOW / 1000, toolCalls: 38, lastTool: 'Bash', pct: 63, eta: NOW / 1000 + 240, asOf: NOW / 1000, source: 'Claude', path: '/p', active: 190, typical: null, rough: false, reported: true, note: 'running the tests', tokensNew: 212_000, tokensCache: 0, ...o });

describe('engine on the synthetic fleet', () => {
  it('finds running/done/stalled agents, sets the tray text, loads GitHub with attention', async () => {
    const b = memoryBackend({ now: NOW });
    const labels: string[] = [];
    b.setTrayLabel = async (l) => { labels.push(l); };
    const e = new Engine(b);
    await e.init();
    await e.refreshGithub(true);
    const states = e.snap.agents.map((a) => a.state);
    expect(states.filter((s) => s === 'running')).toHaveLength(3);
    expect(states).toContain('stalled');
    expect(labels.at(-1)).toMatch(/^3 running · \d finished$/);
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

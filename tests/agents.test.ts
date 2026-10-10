import { describe, expect, it } from 'vitest';
import { claudeLines, codexLines } from '../tools/synth';
import { AgentScanner, barState, curvePct, elapsed, estimate, finishedSince, nextDone, overrun, remaining, stateOf, trayLabel, agentKey, type Agent, type KnownFile, type ScanFile, type ScanReply } from '../src/core/agents';
import type { Rec } from '../src/core/transcripts';

const NOW = 1_760_000_000;
const recs = (lines: string[]): Rec[] => lines.map((l) => JSON.parse(l) as Rec);

function agent(over: Partial<Agent> = {}): Agent {
  return { agentId: 'a', kind: 'general', description: 'task', state: 'running', started: NOW - 100, lastActivity: NOW, toolCalls: 1, lastTool: 'Bash', pct: null, eta: null, asOf: NOW, source: 'Claude', path: '/p/agent-a.jsonl', active: 100, typical: null, rough: false, reported: false, note: '', tokensNew: null, tokensCache: null, ...over };
}

describe('state', () => {
  it('running within 90 s, stalled after, 900 s while a tool result is pending, done on handback, future clocks stalled', () => {
    expect(stateOf({ done: false, last: NOW - 89, pending: 0 }, NOW)).toBe('running');
    expect(stateOf({ done: false, last: NOW - 91, pending: 0 }, NOW)).toBe('stalled');
    expect(stateOf({ done: false, last: NOW - 800, pending: 1 }, NOW)).toBe('running');
    expect(stateOf({ done: false, last: NOW - 901, pending: 1 }, NOW)).toBe('stalled');
    expect(stateOf({ done: true, last: NOW - 5000, pending: 0 }, NOW)).toBe('done');
    expect(stateOf({ done: false, last: NOW + 301, pending: 0 }, NOW)).toBe('stalled');
    expect(stateOf({ done: false, last: NOW + 299, pending: 0 }, NOW)).toBe('running');
  });
});

describe('percent estimate', () => {
  it('curve: straight to 80 %, then creeping toward 97 %, never beyond', () => {
    expect(curvePct(0)).toBe(0);
    expect(curvePct(-1)).toBe(0);
    expect(curvePct(NaN)).toBe(0);
    expect(curvePct(0.5)).toBe(50);
    expect(curvePct(0.8)).toBe(80);
    expect(curvePct(1)).toBeGreaterThan(80);
    expect(curvePct(1)).toBeLessThan(97);
    expect(curvePct(100)).toBe(97);
    let prev = 0;
    for (let r = 0; r < 5; r += 0.1) { const p = curvePct(r); expect(p).toBeGreaterThanOrEqual(prev); prev = p; }
  });
  it('needs two finished agents; prefers similar descriptions, then same kind, then the same tool (rough)', () => {
    const done = (d: string, active: number, kind = 'general') => agent({ state: 'done', description: d, active, kind, path: `/p/${d}${active}` });
    const run = agent({ description: 'refactor the authentication middleware', active: 60, lastActivity: NOW, kind: 'general' });
    const list = [run, done('refactor authentication layer middleware', 100), done('refactor authentication middleware again', 140), done('unrelated gardening work', 1000)];
    estimate(list, NOW);
    expect(run.typical).toBe(120); // median of the two similar ones
    expect(run.pct).toBe(50);
    expect(run.rough).toBe(false);
    expect(run.eta).toBe(NOW + 60);
    expect(remaining(run)).toBe(60);
    const lone = agent({ description: 'zzzz', active: 10, path: '/p/lone', kind: 'special' });
    estimate([lone, done('aaaa bbbb', 40), done('cccc dddd', 60)], NOW);
    expect(lone.rough).toBe(true);
    expect(lone.typical).toBe(50);
    const none = agent({ description: 'zzzz', path: '/p/none' });
    estimate([none, done('aaaa bbbb', 40)], NOW);
    expect(none.pct).toBeNull();
    expect(none.typical).toBeNull();
  });
  it('an overrun agent has a percent but no finish time', () => {
    const run = agent({ active: 500, description: 'task words' });
    estimate([run, agent({ state: 'done', active: 100, path: '/x1' }), agent({ state: 'done', active: 100, path: '/x2' })], NOW);
    expect(overrun(run)).toBe(true);
    expect(run.eta).toBeNull();
    expect(run.pct).toBeGreaterThan(80);
    expect(run.pct).toBeLessThanOrEqual(97);
  });
  it("an agent's own PROGRESS beats the estimate and extrapolates its pace", () => {
    const run = agent({ reported: true, pct: 25, active: 100, lastActivity: NOW });
    estimate([run], NOW);
    expect(run.pct).toBe(25);
    expect(run.eta).toBe(NOW + 300);
  });
  it('elapsed counts the current quiet stretch of a running agent, capped', () => {
    expect(elapsed(agent({ active: 100, lastActivity: NOW - 30 }))).toBe(130);
    expect(elapsed(agent({ active: 100, lastActivity: NOW - 5000 }))).toBe(700);
    expect(elapsed(agent({ state: 'done', active: 100, lastActivity: NOW - 5000 }))).toBe(100);
  });
  it('bar state, next done and the tray label', () => {
    const l = [agent({ pct: 60 }), agent({ pct: 41, path: '/b' }), agent({ pct: null, path: '/c' }), agent({ state: 'done', path: '/d' })];
    expect(barState(l)).toEqual([3, 50]);
    expect(barState([])).toEqual([0, null]);
    expect(nextDone([agent({ eta: NOW + 50 }), agent({ eta: NOW + 20, path: '/b' })])).toBe(20);
    expect(nextDone([agent()])).toBeNull();
    expect(trayLabel(3, 2)).toBe('3 running · 2 finished');
    expect(trayLabel(0, 2)).toBe('2 finished');
    expect(trayLabel(1, 0)).toBe('1 running');
    expect(trayLabel(0, 0)).toBe('Agents Bar');
  });
});

describe('finishedSince', () => {
  it('null on the first scan; running or stalled -> done only', () => {
    const a = agent({ state: 'done' });
    expect(finishedSince(null, [a])).toEqual([]);
    expect(finishedSince(new Map([[agentKey(a), 'running' as const]]), [a])).toEqual([a]);
    expect(finishedSince(new Map([[agentKey(a), 'stalled' as const]]), [a])).toEqual([a]);
    expect(finishedSince(new Map([[agentKey(a), 'done' as const]]), [a])).toEqual([]);
    expect(finishedSince(new Map(), [a])).toEqual([]);
  });
});

/** A scripted scan backend: each call returns the next reply. */
function scripted(replies: ScanReply[]) {
  let i = 0;
  const calls: boolean[] = [];
  return { calls, backend: { async scan(r: boolean) { calls.push(r); return replies[Math.min(i++, replies.length - 1)]!; } } };
}
const kf = (path: string, kind: 'claude' | 'codex', t: number): KnownFile => ({ path, kind, mtimeMs: t * 1000 });

describe('AgentScanner (incremental state per file)', () => {
  const path = '/home/u/.claude/projects/-p/s/subagents/agent-abc123.jsonl';
  it('builds agents from complete lines and continues appended data without restarting', async () => {
    const first = claudeLines({ start: NOW - 100, steps: 2, tokens: { input: 10, output: 20 } });
    const more = claudeLines({ start: NOW - 100, steps: 3, tokens: { input: 15, output: 30 } }).slice(first.length);
    const f1: ScanFile = { path, kind: 'claude', mtimeMs: (NOW - 50) * 1000, reset: true, records: recs(first), meta: { agentType: 'explorer', description: 'Look around' } };
    const f2: ScanFile = { path, kind: 'claude', mtimeMs: (NOW - 10) * 1000, reset: false, records: recs(more) };
    const s = scripted([{ files: [f1], known: [kf(path, 'claude', NOW - 50)], more: false }, { files: [f2], known: [kf(path, 'claude', NOW - 10)], more: false }]);
    const sc = new AgentScanner(s.backend);
    const [a] = await sc.scan(NOW, true);
    expect(a).toMatchObject({ agentId: 'abc123', kind: 'explorer', description: 'Look around', source: 'Claude', toolCalls: 2, path });
    expect(a!.tokensNew).toBe(30);
    const [b] = await sc.scan(NOW, false);
    expect(b!.toolCalls).toBe(3);
    expect(b!.kind).toBe('explorer'); // meta kept when the second call sends none
    expect(s.calls).toEqual([true, false]);
  });
  it('a replaced or truncated file (reset) starts over', async () => {
    const f = (reset: boolean, steps: number): ScanFile => ({ path, kind: 'claude', mtimeMs: NOW * 1000, reset, records: recs(claudeLines({ start: NOW - 60, steps })) });
    const known = [kf(path, 'claude', NOW)];
    const sc = new AgentScanner(scripted([{ files: [f(true, 5)], known, more: false }, { files: [f(true, 2)], known, more: false }]).backend);
    expect((await sc.scan(NOW, true))[0]!.toolCalls).toBe(5);
    expect((await sc.scan(NOW, true))[0]!.toolCalls).toBe(2);
  });
  it('drops files that left the known list, honours the 24 h lookback, sorts running first', async () => {
    const p2 = '/x/.claude/projects/-p/s/subagents/agent-old.jsonl', p3 = '/x/.claude/projects/-p/s/subagents/agent-done.jsonl';
    const mk = (p: string, ago: number, extra = {}): ScanFile => ({ path: p, kind: 'claude', mtimeMs: (NOW - ago) * 1000, reset: true, records: recs(claudeLines({ start: NOW - ago - 30, steps: 1, ...extra })) });
    const files = [mk(path, 5), mk(p2, 90000), mk(p3, 4000, { handback: true })];
    const known = [kf(path, 'claude', NOW - 5), kf(p2, 'claude', NOW - 90000), kf(p3, 'claude', NOW - 4000)];
    const sc = new AgentScanner(scripted([{ files, known, more: false }, { files: [], known: [known[0]!], more: false }]).backend);
    const got = await sc.scan(NOW, true);
    expect(got.map((a) => a.agentId)).toEqual(['abc123', 'done']); // old one is outside the lookback
    expect(got[0]!.state).toBe('running');
    expect(got[1]!.state).toBe('done');
    expect((await sc.scan(NOW, false)).map((a) => a.agentId)).toEqual(['abc123']);
  });
  it('reads a cold scan in several rounds (more = true) up to a bounded number', async () => {
    const mk = (n: number): ScanFile => ({ path: `/r/agent-${n}.jsonl`, kind: 'claude', mtimeMs: NOW * 1000, reset: true, records: recs(claudeLines({ start: NOW - 20, steps: 1 })) });
    const known = [0, 1, 2].map((n) => kf(`/r/agent-${n}.jsonl`, 'claude', NOW));
    const s = scripted([{ files: [mk(0)], known, more: true }, { files: [mk(1)], known, more: true }, { files: [mk(2)], known, more: false }]);
    const got = await new AgentScanner(s.backend).scan(NOW, true);
    expect(got).toHaveLength(3);
    expect(s.calls).toEqual([true, false, false]);
    const forever = scripted([{ files: [], known: [], more: true }]);
    await new AgentScanner(forever.backend).scan(NOW, true);
    expect(forever.calls.length).toBeLessThanOrEqual(40);
  });
  it('Codex: id from the file name, title as description, clamps a future last-activity', async () => {
    const cp = '/home/u/.codex/sessions/2026/10/07/rollout-2026-10-07T10-00-00-0123456789abcdef.jsonl';
    const records = recs(codexLines({ start: NOW + 99999, steps: 2, title: 'Fix the flaky test' }));
    const sc = new AgentScanner(scripted([{ files: [{ path: cp, kind: 'codex', mtimeMs: NOW * 1000, reset: true, records }], known: [kf(cp, 'codex', NOW)], more: false }]).backend);
    const [a] = await sc.scan(NOW, true);
    expect(a).toMatchObject({ agentId: '0123456789abcdef'.slice(-12), kind: 'codex', description: 'Fix the flaky test', source: 'Codex', state: 'stalled' });
    expect(a!.lastActivity).toBe(NOW);
  });
});

describe('one tick never keeps the page busy for long', () => {
  it('stops reading rounds after the time budget and reports an incomplete pass', async () => {
    // a fake clock: every read "takes" 400 ms, so the 1500 ms budget allows exactly four rounds, on any machine
    let calls = 0, t = 0;
    const slow = { async scan() { calls++; t += 400; return { files: [], known: [], more: true }; } };
    const sc = new AgentScanner(slow, () => t);
    await sc.scan(NOW, true);
    expect(calls).toBe(4);
    expect(sc.complete).toBe(false);
  });
});

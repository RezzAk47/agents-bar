import { describe, expect, it } from 'vitest';
import { agentKey, type Agent } from '../src/core/agents';
import { BURST, DeliveryQueue, FinishWatcher, MAX_ID_CHARS, MAX_IDS, MAX_RETRIES, NotifiedStore, agentId, capRows, groupNotification, notification, projectOf, today, todayRow, type Persist } from '../src/core/history';

const NOW = 1_760_000_000;
let n = 0;
function agent(over: Partial<Agent> = {}): Agent {
  n++;
  return { agentId: `a${n}`, kind: 'general', description: 'Refactor auth', state: 'running', started: NOW - 200, lastActivity: NOW, toolCalls: 38, lastTool: 'Bash', pct: null, eta: null, asOf: NOW, source: 'Claude', path: `/home/u/.claude/projects/-Users-me-Desktop-Projects-shop/s/subagents/agent-a${n}.jsonl`, active: 200, typical: null, rough: false, reported: false, note: '', tokensNew: 212_345, tokensCache: 5, ...over };
}
const done = (a: Agent, last = NOW + 10): Agent => ({ ...a, state: 'done', lastActivity: last });

function memory(initial: string | null = null): Persist & { text: string | null; writes: number } {
  const p = { text: initial, writes: 0, async read() { return p.text; }, async write(t: string) { p.text = t; p.writes++; } };
  return p;
}
const mk = (opts: { ok?: () => boolean; persist?: ReturnType<typeof memory>; enabled?: () => boolean; group?: boolean } = {}) => {
  const clock = { t: NOW };
  const persist = opts.persist ?? memory();
  const store = new NotifiedStore(persist, () => clock.t);
  const sent: string[] = [];
  const groups: number[] = [];
  const w = new FinishWatcher({
    store, enabled: opts.enabled,
    notify: async (a) => { sent.push(a.agentId); return opts.ok ? opts.ok() : true; },
    notifyGroup: opts.group === false ? undefined : async (l) => { groups.push(l.length); return opts.ok ? opts.ok() : true; },
  });
  return { w, store, sent, groups, persist, clock };
};

describe('finish watcher', () => {
  it('running -> done notifies once across rescans; nothing for agents done at the first scan', async () => {
    const a = agent();
    const x = mk();
    x.w.observe([done(agent())]); // first scan: already done -> silent
    x.w.observe([a]);
    expect(x.w.observe([done(a)])).toHaveLength(1);
    x.w.observe([done(a)]);
    await x.w.flush();
    expect(x.sent).toEqual([a.agentId]);
  });
  it('stalled -> done counts', async () => {
    const x = mk(); const a = agent({ state: 'stalled' });
    x.w.observe([a]); x.w.observe([done(a)]); await x.w.flush();
    expect(x.sent).toEqual([a.agentId]);
  });
  it('alert id is source:path@finish-second', () => {
    const a = agent({ agentId: 'dup', path: '/p/agent-dup.jsonl', lastActivity: 1000.4 });
    expect(agentId(a)).toBe('Claude:/p/agent-dup.jsonl@1000');
    expect(agentId({ ...a, source: 'Codex' })).toBe('Codex:/p/agent-dup.jsonl@1000');
    expect(agentId({ ...a, lastActivity: NaN })).toBe('Claude:/p/agent-dup.jsonl@0');
    expect(agentId({ ...a, path: 'x'.repeat(2000) }).length).toBeLessThanOrEqual(MAX_ID_CHARS);
  });
  it('two agents with the same id but other paths are two alerts; a second finish of the same file alerts again', async () => {
    const x = mk(); const a = agent({ agentId: 'same' }), b = agent({ agentId: 'same' });
    x.w.observe([a, b]); x.w.observe([done(a), done(b)]); await x.w.flush();
    expect(x.sent).toHaveLength(2);
    x.w.observe([{ ...a, state: 'running' }]); x.w.observe([done(a, NOW + 500)]); await x.w.flush();
    expect(x.sent).toHaveLength(3);
  });
  it('is not repeated after a restart (persisted)', async () => {
    const persist = memory(); const a = agent();
    const x = mk({ persist }); x.w.observe([a]); x.w.observe([done(a)]); await x.w.flush();
    const y = mk({ persist }); await y.store.init();
    y.w.observe([a]); y.w.observe([done(a)]); await y.w.flush();
    expect(y.sent).toEqual([]);
  });
  it('the setting off means silence and nothing is remembered', async () => {
    let on = false; const a = agent();
    const x = mk({ enabled: () => on });
    x.w.observe([a]); x.w.observe([done(a)]); await x.w.flush();
    expect(x.sent).toEqual([]);
    on = true; x.w.observe([done(a)]); await x.w.flush();
    expect(x.sent).toEqual([]); // the finish was seen while off: not replayed later
  });
  it('more than 3 finishes in one scan become ONE group notification', async () => {
    const x = mk(); const list = Array.from({ length: BURST + 1 }, () => agent());
    x.w.observe(list); x.w.observe(list.map((a) => done(a))); await x.w.flush();
    expect(x.groups).toEqual([BURST + 1]);
    expect(x.sent).toEqual([]);
    for (const a of list) expect(x.store.has(agentId(done(a)))).toBe(true);
    expect(groupNotification(list)[0]).toBe('4 agents finished');
  });
  it('exactly 3 are sent one by one', async () => {
    const x = mk(); const list = [agent(), agent(), agent()];
    x.w.observe(list); x.w.observe(list.map((a) => done(a))); await x.w.flush();
    expect(x.sent).toHaveLength(3);
    expect(x.groups).toEqual([]);
  });
  it('delivery must succeed: a failure is retried on later scans, at most 3 times, then given up (saved)', async () => {
    const persist = memory(); const a = agent(); let attempts = 0;
    const x = mk({ ok: () => { attempts++; return false; }, persist });
    x.w.observe([a]); x.w.observe([done(a)]); await x.w.flush();
    expect(attempts).toBe(1);
    expect(x.store.has(agentId(done(a)))).toBe(false);
    for (let i = 0; i < 10; i++) { x.w.observe([done(a)]); await x.w.flush(); }
    expect(attempts).toBe(MAX_RETRIES + 1);
    expect(x.store.has(agentId(done(a)))).toBe(true);
    expect(JSON.parse(persist.text!).ids).toBeTruthy();
  });
  it('a notifier that throws does not break the scan', async () => {
    const a = agent(); const store = new NotifiedStore(null, () => NOW);
    const w = new FinishWatcher({ store, notify: async () => { throw new Error('boom'); } });
    w.observe([a]);
    expect(() => w.observe([done(a)])).not.toThrow();
    await w.flush();
  });
  it('a retry that succeeds clears the failure count', async () => {
    const a = agent(); let ok = false;
    const x = mk({ ok: () => ok });
    x.w.observe([a]); x.w.observe([done(a)]); await x.w.flush();
    ok = true; x.w.observe([done(a)]); await x.w.flush();
    expect(x.store.has(agentId(done(a)))).toBe(true);
    expect(x.store.tries.size).toBe(0);
  });
  it('in-flight finishes are not submitted twice', async () => {
    const x = mk(); const a = agent();
    x.w.observe([a]); x.w.observe([done(a)]); x.w.observe([done(a)]);
    await x.w.flush();
    expect(x.sent).toHaveLength(1);
  });
  it('agentKey stays stable', () => { const a = agent(); expect(agentKey(a)).toBe(agentKey({ ...a, state: 'done' })); });
});

describe('delivery queue', () => {
  it('runs at most 2 jobs at once, everything finishes; extra jobs beyond the queue limit are refused as failed', async () => {
    const q = new DeliveryQueue(2, 5);
    let running = 0, peak = 0, finished = 0;
    for (let i = 0; i < 7; i++) q.submit(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return true; }, () => { finished++; });
    const refused: boolean[] = [];
    q.submit(async () => true, (ok) => refused.push(ok));
    await q.idle();
    expect(peak).toBe(2);
    expect(q.peakActive).toBe(2);
    expect(finished).toBe(7);
    expect(refused).toEqual([false]);
  });
});

describe('notified.json store', () => {
  it('strict load: bad entries dropped, a bad file means empty, future stamps clamped, size capped', () => {
    const s = new NotifiedStore(null, () => NOW);
    for (const bad of ['', 'not json', '[]', '5', '{"ids":5}', '{"ids":[]}', 'x'.repeat(2 << 20)]) { s.load(bad); expect(s.ids.size).toBe(0); }
    s.load(JSON.stringify({ ids: { good: NOW - 5, '': 1, bad: 'x', nan: null, future: NOW + 99999, ['k'.repeat(MAX_ID_CHARS + 1)]: 1 }, tries: { good2: [2, NOW - 1], bad: [9, 1], bad2: 'x' } }));
    expect([...s.ids.keys()].sort()).toEqual(['future', 'good']);
    expect(s.ids.get('future')).toBe(NOW);
    expect([...s.tries.keys()]).toEqual(['good2']);
  });
  it('entries older than two days are pruned; the list is capped', () => {
    const s = new NotifiedStore(null, () => NOW);
    s.load(JSON.stringify({ ids: { old: NOW - 3 * 86400, fresh: NOW - 100 } }));
    expect([...s.ids.keys()]).toEqual(['fresh']);
    for (let i = 0; i < MAX_IDS + 50; i++) s.ids.set(`k${i}`, NOW - i);
    s.prune();
    expect(s.ids.size).toBe(MAX_IDS);
    expect(s.ids.has('k0')).toBe(true);
    expect(s.ids.has(`k${MAX_IDS + 40}`)).toBe(false);
  });
  it('round-trips through its own serialisation and tolerates a BOM', () => {
    const s = new NotifiedStore(null, () => NOW);
    s.add('a@1', NOW - 5); s.failed('b@2');
    const t = new NotifiedStore(null, () => NOW);
    t.load('\ufeff' + s.serialize());
    expect([...t.ids]).toEqual([['a@1', NOW - 5]]);
    expect(t.tries.get('b@2')![0]).toBe(1);
  });
  it('an unwritable store never raises', async () => {
    const s = new NotifiedStore({ read: async () => { throw new Error('x'); }, write: async () => { throw new Error('y'); } }, () => NOW);
    await s.init();
    expect(await s.save()).toBe(false);
  });
});

describe('notification text and Today', () => {
  it('has the project, title, duration and stats; hostile text is cleaned and bounded', () => {
    const [title, body] = notification(done(agent({ description: 'Fix\u202E the\nbug', path: '/home/u/.claude/projects/-Users-me-Desktop-Projects-shop/s/subagents/agent-x.jsonl' })));
    expect(title).toBe('Agent finished');
    expect(body).toBe('shop: Fix the bug · took 3m 20s · 38 steps · 212k tokens');
    expect(notification(agent({ description: 'z'.repeat(1000) }))[1].length).toBeLessThanOrEqual(200);
    expect(notification(agent({ description: '' }))[1]).toContain('an agent');
  });
  it('project names', () => {
    expect(projectOf(agent({ source: 'Codex' }))).toBe('Codex');
    expect(projectOf(agent({ path: '/h/.claude/projects/-Users-me-Documents-my-app/s/subagents/a.jsonl' }))).toBe('my-app');
    expect(projectOf(agent({ path: '/h/.claude/projects/-Users-me/s/subagents/a.jsonl' }))).toBe('home');
    expect(projectOf(agent({ path: '/nothing/here.jsonl' }))).toBe('');
    expect(projectOf(agent({ path: 'C:\\Users\\me\\.claude\\projects\\C--code-site\\s\\subagents\\a.jsonl' }))).toBe('C--code-site');
  });
  it('Today is this local day, only done, newest first', () => {
    const noon = new Date(2026, 9, 7, 12, 0, 0).getTime() / 1000;
    const rows = [done(agent(), noon - 600), done(agent(), noon - 100), agent({ lastActivity: noon }), done(agent(), noon - 2 * 86400)];
    const t = today(rows, noon);
    expect(t.map((a) => a.lastActivity)).toEqual([noon - 100, noon - 600]);
    expect(today([], noon)).toEqual([]);
    expect(today(rows, NaN)).toEqual([]);
  });
  it('rows use tokens when known else steps, tag Codex, and cap with a +N note', () => {
    const base = new Date(2026, 9, 7, 14, 43).getTime() / 1000;
    expect(todayRow(done(agent({ description: 'Write notes' }), base))).toEqual(['Write notes', '3m 20s · 212k tokens · 14:43']);
    expect(todayRow(done(agent({ source: 'Codex', tokensNew: null, description: 'X' }), base))).toEqual(['Codex · X', '3m 20s · 38 steps · 14:43']);
    expect(capRows([1, 2, 3, 4, 5, 6, 7])).toEqual([[1, 2, 3, 4, 5], 2]);
    expect(capRows([1])).toEqual([[1], 0]);
  });
});

// Tests for the findings of the independent review (Mac parity details, cold start, notification text, owners, sleep).
import { describe, expect, it } from 'vitest';
import { memoryBackend, MemoryScan, demoScanFiles } from '../src/backend/memory';
import { agentKey, type Agent, type ScanBackend, type ScanReply } from '../src/core/agents';
import { OWNER_RE, slug } from '../src/core/github';
import { agentId, groupNotification, notification, plainText, pyRound } from '../src/core/history';
import { clean } from '../src/core/text';
import { digitValue, feedClaude, feedCodex, findReport, newClaude, newCodex, parseDigits, parseText, parseTs, pyTruthy } from '../src/core/transcripts';
import { Engine } from '../src/ui/engine';
import { claudeLines } from '../tools/synth';

describe('PROGRESS lines (Mac parity)', () => {
  it('(a) digits of any script are numbers, like Python \\d', () => {
    expect(findReport('PROGRESS: ۴۵% - persian')).toEqual([45, 'persian']);
    expect(findReport('PROGRESS: ٦٠% - arabic-indic')).toEqual([60, 'arabic-indic']);
    expect(findReport('PROGRESS: ９９% - fullwidth')).toEqual([99, 'fullwidth']);
    expect(findReport('PROGRESS: 𝟕𝟕% - math bold')).toEqual([77, 'math bold']);
    expect([digitValue('٠'), digitValue('٩'), digitValue('7'), digitValue('𝟗')]).toEqual([0, 9, 7, 9]);
    expect(parseDigits('۱۲۳')).toBe(123);
    expect(findReport('PROGRESS: 1234% - four digits')).toBeNull();
  });
  it('(b) a lone \\r, U+2028 or U+0085 does not start a line; \\n does', () => {
    expect(findReport('x\rPROGRESS: 40% - a')).toBeNull();
    expect(findReport('x PROGRESS: 40% - a')).toBeNull();
    expect(findReport('x\u0085PROGRESS: 40% - a')).toBeNull();
    expect(findReport('x\nPROGRESS: 40% - a')).toEqual([40, 'a']);
    expect(findReport('PROGRESS: 40% - a\r\nlater')).toEqual([40, 'a']);
  });
  it('a long prefix of prefix characters still counts, other text before the marker does not', () => {
    expect(findReport(' '.repeat(2000) + 'PROGRESS: 12% - x')).toEqual([12, 'x']);
    expect(findReport('> '.repeat(500) + 'PROGRESS: 13% - x')).toEqual([13, 'x']);
    expect(findReport('note PROGRESS: 13% - x')).toBeNull();
  });
});

describe('text and times (Mac parity)', () => {
  it('(c) U+0085 is a space for clean()', () => expect(clean('a\u0085b')).toBe('a b'));
  it('(d) impossible dates and times are rejected, not rolled over; hour-only offsets are fine', () => {
    for (const bad of ['2026-02-30T10:00:00Z', '2026-02-29T10:00:00Z', '2026-04-31T10:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T23:60:00Z', '2026-01-01T23:59:60Z', '2026-00-10T00:00:00Z', '2026-13-10T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01T10:00:00+24:00', '2026-01-01T10:00:00+01:60']) expect(parseTs(bad), bad).toBeNull();
    expect(parseTs('2024-02-29T00:00:00Z')).toBe(Date.UTC(2024, 1, 29) / 1000);
    expect(parseTs('2026-01-01T00:00:00-08')).toBe(Date.UTC(2026, 0, 1, 8) / 1000);
    expect(parseTs('2026-01-01T00:00:00+0530')).toBe(Date.UTC(2025, 11, 31, 18, 30) / 1000);
    expect(parseTs('2026-01-01T00:00:00,5Z')).toBe(Date.UTC(2026, 0, 1) / 1000 + 0.5);
  });
  it('(g) a non-string Codex tool name is a name (shell), an empty one falls back to the action type', () => {
    const st = newCodex();
    feedCodex(st, { type: 'response_item', payload: { type: 'function_call', name: 5, action: { type: 'exec' } } });
    expect(st.lastTool).toBe('shell');
    feedCodex(st, { type: 'response_item', payload: { type: 'function_call', name: [], action: { type: 'exec' } } });
    expect(st.lastTool).toBe('exec');
    feedCodex(st, { type: 'response_item', payload: { type: 'function_call', name: 0, action: { type: 'run' } } });
    expect(st.lastTool).toBe('run');
    expect([null, 0, false, '', [], {}, 'x', 5, [1], { a: 1 }].map(pyTruthy)).toEqual([false, false, false, false, false, false, true, true, true, true]);
  });
  it('(i) the alert id rounds like Python: halves go to even', () => {
    expect([0.5, 1.5, 2.5, 3.5, -0.5, 2.4, 2.6].map(pyRound)).toEqual([0, 2, 2, 4, 0, 2, 3]);
    const a = { source: 'Claude' as const, path: '/p', agentId: 'a', lastActivity: 1000.5 };
    expect(agentId(a)).toBe('Claude:/p@1000');
    expect(agentId({ ...a, lastActivity: 1001.5 })).toBe('Claude:/p@1002');
  });
});

describe('deeply nested lines (C)', () => {
  it('a record that is nested thousands deep never loses the file', () => {
    const deep = `{"type":"assistant","x":${'['.repeat(5000)}${']'.repeat(5000)}}\n`;
    const ok = (i: number) => `{"type":"assistant","timestamp":"2026-10-08T01:00:0${i}Z","message":{"id":"m${i}","content":[{"type":"tool_use","id":"t${i}","name":"Bash"}]}}\n`;
    expect(parseText('claude', ok(1) + deep + ok(2)).tools).toBe(2);
    const deeper = `{"a":`.repeat(200_000) + '1' + '}'.repeat(200_000) + '\n';
    expect(() => parseText('claude', ok(1) + deeper + ok(2))).not.toThrow();
    expect(parseText('claude', ok(1) + deeper + ok(2)).tools).toBe(2);
  });
});

describe('notification text (13)', () => {
  const a: Agent = { agentId: 'a', kind: 'k', description: '<b>Fix</b> <a href="x">the</a> R&D bug', state: 'done', started: 0, lastActivity: 100, toolCalls: 3, lastTool: '', pct: null, eta: null, asOf: 100, source: 'Claude', path: '/h/.claude/projects/-Users-me-proj/s/subagents/a.jsonl', active: 60, typical: null, rough: false, reported: false, note: '', tokensNew: 5, tokensCache: null };
  it('titles and bodies carry no markup characters', () => {
    const [t, body] = notification(a);
    expect(t).toBe('Agent finished');
    expect(body).not.toMatch(/[<>&]/);
    expect(body).toContain('bFix/b');
    expect(groupNotification([a, { ...a, description: 'x&y<z>' }])[1]).not.toMatch(/[<>&]/);
    expect(plainText('a<b>&c\n‮d', 50)).toBe('abc d');
  });
});

describe('GitHub owners (10)', () => {
  it('EMU logins with an underscore are valid; hyphen rules hold', () => {
    for (const ok of ['name_company', 'a_b', 'abc-def', 'A1', 'x'.repeat(39)]) expect(OWNER_RE.test(ok), ok).toBe(true);
    for (const bad of ['-a', '_a', 'a--b', 'a-', 'a.b', 'a/b', 'a b', '@a', '', 'x'.repeat(40)]) expect(OWNER_RE.test(bad), bad).toBe(false);
    expect(slug('https://github.com/name_company/repo')).toBe('name_company/repo');
    expect(slug('https://github.com/a--b/repo')).toBeNull();
    expect(slug('https://github.com/me/-flag')).toBeNull();
  });
});

describe('a big cold start is not judged until it is complete (1)', () => {
  const NOW = Date.UTC(2026, 9, 7, 19, 0, 0);
  /** A scan backend that reports a partial pass `partial` times, then a complete one; `later` is served after that. */
  function partialThen(files: ReturnType<typeof demoScanFiles>, partial: number, later: ScanReply[] = []): ScanBackend {
    let i = 0, cursor = 0;
    const known = files.map((f) => ({ path: f.path, kind: f.kind, mtimeMs: f.mtimeMs }));
    return {
      async scan(): Promise<ScanReply> {
        i++;
        if (i <= partial) {
          // each partial call delivers one more file: the rest are unknown states for now
          const f = files.slice(cursor, cursor + 1); cursor += 1;
          return { files: f, known, more: true };
        }
        if (i === partial + 1) { const f = files.slice(cursor); cursor = files.length; return { files: f, known, more: false }; }
        return later[i - partial - 2] ?? { files: [], known, more: false };
      },
    };
  }
  const mk = (partial: number, later: ScanReply[] = [], scanClock: () => number = () => 0) => {
    const b = memoryBackend({ now: NOW });
    b.scan = partialThen(demoScanFiles(NOW / 1000), partial, later);
    const sent: string[] = [];
    b.notify = async (t, body) => { sent.push(`${t}|${body}`); return true; };
    b.notifyOff = false;
    return { e: new Engine(b, { scanClock }), sent };
  };

  it('no alert and no wrong states while the first pass is partial; the first complete pass is the baseline (no alerts for what is already done)', async () => {
    // AgentScanner reads up to 40 rounds per tick; 85 partial rounds mean the pass completes in the third tick
    const { e, sent } = mk(85, [], () => 0); // frozen clock: the 1.5 s budget never cuts a tick short on a slow runner
    await e.init(); // first tick: 40 rounds, still partial
    expect(e.snap.scanning).toBe(true);
    expect(e.snap.agents).toEqual([]);
    await e.tick(); expect(e.snap.scanning).toBe(true); expect(e.snap.agents).toEqual([]);
    await e.tick(); // the complete pass
    expect(e.snap.scanning).toBe(false);
    expect(e.snap.agents.length).toBeGreaterThan(5);
    await e.watcher.flush();
    expect(sent).toEqual([]); // the demo has finished agents; none is announced after a cold start
    await e.tick(); await e.watcher.flush();
    expect(sent).toEqual([]);
  });

  it('the per-tick time budget is the only thing that bounds a tick: a slow machine (clock jumps) leaves the pass partial, deterministically', async () => {
    // Regression for a flaky CI failure: the budget used the real clock, so a slow Windows runner stopped after fewer than 40 rounds.
    let t = 0;
    const b = memoryBackend({ now: NOW });
    b.scan = partialThen(demoScanFiles(NOW / 1000), 5);
    const e = new Engine(b, { scanClock: () => (t += 2000) });
    await e.init(); // one round per tick: every read "takes" 2 s
    expect(e.snap.scanning).toBe(true);
    for (let i = 0; i < 5; i++) await e.tick();
    expect(e.snap.scanning).toBe(false);
  });

  it('a real finish after the baseline is announced once', async () => {
    const files = demoScanFiles(NOW / 1000);
    const running = files.find((f) => f.path.endsWith('agent-run2.jsonl'))!;
    const handback = JSON.parse(claudeLines({ start: NOW / 1000, steps: 1, handback: true }).at(-1)!) as Record<string, unknown>;
    handback.timestamp = new Date(NOW + 2000).toISOString();
    const known = files.map((f) => ({ path: f.path, kind: f.kind, mtimeMs: f.mtimeMs }));
    const { e, sent } = mk(2, [{ files: [{ ...running, reset: false, mtimeMs: NOW + 2000, records: [handback] }], known, more: false }]);
    await e.init();
    await e.tick(); await e.tick(); // partial, partial, then complete (init's tick was the first)
    expect(e.snap.scanning).toBe(false);
    await e.tick(); await e.watcher.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Review the diff for bugs');
    await e.tick(); await e.watcher.flush();
    expect(sent).toHaveLength(1);
    void agentKey;
  });

  it('after a complete pass, a later partial pass keeps the last complete picture and says it is scanning', async () => {
    const b = memoryBackend({ now: NOW });
    const files = demoScanFiles(NOW / 1000);
    const known = files.map((f) => ({ path: f.path, kind: f.kind, mtimeMs: f.mtimeMs }));
    let n = 0;
    b.scan = { async scan() { n++; return n === 1 ? { files, known, more: false } : { files: [], known, more: true }; } };
    const e = new Engine(b);
    await e.init();
    const before = e.snap.agents.length;
    expect(before).toBeGreaterThan(5);
    await e.tick();
    expect(e.snap.scanning).toBe(true);
    expect(e.snap.agents).toHaveLength(before);
    void MemoryScan;
  });
});

describe('sleep (13)', () => {
  it('waking from sleep forces a folder walk and a GitHub refresh on the next tick', async () => {
    const b = memoryBackend({ now: Date.UTC(2026, 9, 7, 19, 0, 0) });
    const walks: boolean[] = [];
    const inner = b.scan;
    b.scan = { scan: (r) => { walks.push(r); return inner.scan(r); } };
    let wake: (() => void) | null = null;
    b.onSlept = (cb) => { wake = cb; return () => {}; };
    const e = new Engine(b);
    await e.init();
    await e.tick(); await e.tick();
    expect(walks).toEqual([true, false, false]);
    wake!();
    await e.tick();
    expect(walks.at(-1)).toBe(true);
  });
});

describe('feeds that must not throw on odd shapes', () => {
  it('claude and codex states accept anything', () => {
    for (const bad of [{}, { type: 'assistant' }, { type: 'user', message: { content: [null] } }]) { feedClaude(newClaude(), bad); feedCodex(newCodex(), bad); }
  });
});

describe('a finish must be fresh (defence for late-read files)', () => {
  it('an agent that flips to done with an old last record is not announced', async () => {
    const { FinishWatcher, NotifiedStore } = await import('../src/core/history');
    const mkA = (state: Agent['state'], last: number): Agent => ({ agentId: 'a', kind: 'k', description: 'd', state, started: 0, lastActivity: last, toolCalls: 1, lastTool: '', pct: null, eta: null, asOf: 100_000, source: 'Claude', path: '/p', active: 1, typical: null, rough: false, reported: false, note: '', tokensNew: null, tokensCache: null });
    const sent: string[] = [];
    const w = new FinishWatcher({ store: new NotifiedStore(null, () => 100_000), notify: async (a) => { sent.push(a.agentId); return true; } });
    w.observe([mkA('running', 99_990)]);
    w.observe([mkA('done', 50_000)]); // finished long ago, only now read to its end
    await w.flush();
    expect(sent).toEqual([]);
    w.observe([mkA('running', 99_990)]);
    w.observe([mkA('done', 99_995)]);
    await w.flush();
    expect(sent).toEqual(['a']);
  });
});

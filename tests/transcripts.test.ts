import { describe, expect, it } from 'vitest';
import { claudeLines, codexLines } from '../tools/synth';
import { findReport, parseText, parseTs } from '../src/core/transcripts';

const HOSTILE: unknown[] = [true, false, -5, 2.5, NaN, Infinity, '12', null, [1], { a: 1 }, 10 ** 40, 10 ** 12 + 1];
const T0 = 1_760_000_000;
const rec = (o: unknown) => JSON.stringify(o) + '\n';
const ts = (s: number) => new Date(s * 1000).toISOString();
const asst = (s: number, msg: Record<string, unknown>, extra: Record<string, unknown> = {}) => rec({ type: 'assistant', timestamp: ts(s), message: { content: [{ type: 'text', text: 'hi' }], ...msg }, ...extra });

describe('parseTs', () => {
  it('reads ISO times, any number of fraction digits, and treats a bare time as UTC', () => {
    expect(parseTs('2026-01-01T00:00:00Z')).toBe(Date.UTC(2026, 0, 1) / 1000);
    expect(parseTs('2026-01-01T00:00:00.123456789Z')).toBeCloseTo(Date.UTC(2026, 0, 1) / 1000 + 0.123, 3);
    expect(parseTs('2026-01-01T00:00:00')).toBe(Date.UTC(2026, 0, 1) / 1000);
    expect(parseTs('2026-01-01T01:00:00+01:00')).toBe(Date.UTC(2026, 0, 1) / 1000);
    for (const bad of [null, 5, 'nope', '', {}, [], '2026-13-45T99:99:99Z', 'x'.repeat(100)]) expect(parseTs(bad)).toBeNull();
  });
});

describe('PROGRESS reports', () => {
  it('uppercase at line start only, last one wins, 100 shows as 99', () => {
    expect(findReport('PROGRESS: 40% - running tests')).toEqual([40, 'running tests']);
    expect(findReport('x\nPROGRESS: 10%\nmore\n  > PROGRESS : 55 % — second')).toEqual([55, 'second']);
    expect(findReport('PROGRESS: 100% - done')).toEqual([99, 'done']);
    expect(findReport('Progress: 100% of tests pass')).toBeNull();
    expect(findReport('we made PROGRESS: 40% today')).toBeNull();
    expect(findReport(5)).toBeNull();
    expect(findReport('PROGRESS: 40% - ' + 'y'.repeat(200))![1].length).toBe(48);
    expect(findReport('PROGRESS: 40% - a\u202Eb\nc')![1]).toBe('ab');
  });
});

describe('Claude records', () => {
  it('counts tool calls, tracks pending results and the handback', () => {
    const p = parseText('claude', claudeLines({ start: T0, steps: 4, handback: true }).join(''));
    expect(p.tools).toBe(4);
    expect(p.done).toBe(true);
    expect(p.pending).toBe(0);
    expect(p.lastTool).toBe('Bash');
    const q = parseText('claude', claudeLines({ start: T0, steps: 2, pendingTail: true }).join(''));
    expect(q.pending).toBe(1);
    expect(q.done).toBe(false);
  });
  it('a resumed agent is not done any more', () => {
    const lines = claudeLines({ start: T0, steps: 1, handback: true }).join('') + claudeLines({ start: T0 + 100, steps: 1 }).slice(1).join('');
    expect(parseText('claude', lines).done).toBe(false);
  });
  it('active time caps idle gaps at 600 s', () => {
    const p = parseText('claude', asst(T0, {}) + asst(T0 + 5000, {}) + asst(T0 + 5010, {}));
    expect(p.active).toBe(610);
    expect(p.first).toBe(T0);
    expect(p.last).toBe(T0 + 5010);
  });
  it('tokens: streamed chunks of one message.id count once (max of each field), new and cache kept apart', () => {
    const u = (i: number, o: number, cc = 0, cr = 0) => ({ usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr } });
    const text =
      asst(T0, { id: 'm1', ...u(10, 1, 5, 0) }) + asst(T0 + 1, { id: 'm1', ...u(10, 7, 5, 3) }) + asst(T0 + 2, { id: 'm1', ...u(10, 4, 5, 3) }) + // max kept
      asst(T0 + 3, { id: 'm2', ...u(2, 3, 0, 4) });
    const p = parseText('claude', text);
    expect([p.tokNew, p.tokCache]).toEqual([10 + 7 + 2 + 3, 5 + 3 + 4]);
  });
  it('tokens: falls back to requestId, a record without usage or id adds nothing wrong', () => {
    const p = parseText('claude', asst(T0, { usage: { input_tokens: 5, output_tokens: 5 } }, { requestId: 'r1' }) + asst(T0 + 1, { usage: { input_tokens: 5, output_tokens: 9 } }, { requestId: 'r1' }));
    expect(p.tokNew).toBe(14);
    expect(parseText('claude', asst(T0, {})).tokNew).toBeNull();
  });
  it('tokens: hostile counts are ignored, never NaN or negative', () => {
    for (const bad of HOSTILE) {
      const p = parseText('claude', asst(T0, { id: 'm', usage: { input_tokens: bad, output_tokens: 4 } }));
      expect(p.tokNew, String(bad)).toBe(4);
    }
    const all = parseText('claude', asst(T0, { id: 'm', usage: { input_tokens: 'x', output_tokens: null } }));
    expect(all.tokNew).toBeNull();
  });
  it('odd records never throw and never stop the file', () => {
    const text = '[]\n"str"\n5\nnull\n{"type":"assistant","message":5}\n{"type":"assistant","message":{"content":"x"}}\n{"type":"user","message":{"content":[5,null,{"type":"tool_result","tool_use_id":[1]}]}}\n' + asst(T0, {});
    expect(() => parseText('claude', text)).not.toThrow();
    expect(parseText('claude', text).first).toBe(T0);
  });
  it('a half-written last line is left alone (not valid JSON yet)', () => {
    const p = parseText('claude', asst(T0, {}) + '{"type":"assistant","timest');
    expect(p.first).toBe(T0);
    expect(p.tools).toBe(0);
  });
  it('a PROGRESS line is picked up from assistant text', () => {
    expect(parseText('claude', claudeLines({ start: T0, report: 'PROGRESS: 30% - tests' }).join('')).report).toEqual([30, 'tests']);
  });
});

describe('Codex records', () => {
  it('title skips injected context, counts calls, done on task_complete or turn_aborted', () => {
    const p = parseText('codex', codexLines({ start: T0, steps: 3, title: 'Fix the checkout test', complete: true }).join(''));
    expect(p.title).toBe('Fix the checkout test');
    expect(p.tools).toBe(3);
    expect(p.done).toBe(true);
    expect(p.lastTool).toBe('shell');
    expect(parseText('codex', codexLines({ start: T0, aborted: true }).join('')).done).toBe(true);
    expect(parseText('codex', codexLines({ start: T0 }).join('')).done).toBe(false);
  });
  it('tokens: the latest total wins; cached input is cache, not new', () => {
    const p = parseText('codex', codexLines({ start: T0, steps: 4, tokens: { input: 1000, cached: 600, output: 50 } }).join(''));
    expect([p.tokNew, p.tokCache]).toEqual([400 + 50, 600]);
    expect(parseText('codex', codexLines({ start: T0 }).join('')).tokNew).toBeNull();
  });
  it('pending tool call and report', () => {
    const p = parseText('codex', codexLines({ start: T0, steps: 2, pendingTail: true, report: 'PROGRESS: 70% - almost' }).join(''));
    expect(p.pending).toBe(1);
    expect(p.report).toEqual([70, 'almost']);
  });
  it('hostile payloads do not throw', () => {
    const lines = [{ type: 'event_msg', payload: 5 }, { type: 'response_item', payload: { type: 'function_call', call_id: [1], name: 5, action: 3 } }, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 'x' } } } }, { timestamp: ts(T0), type: 'x' }];
    expect(() => parseText('codex', lines.map(rec).join(''))).not.toThrow();
  });
});

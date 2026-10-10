// Writes the committed fixtures tests/fixtures/transcripts/*.jsonl (synthetic, invented text). Run: node scripts/make-fixtures.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeLines, codexLines } from '../tools/synth.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'transcripts') + path.sep;
fs.mkdirSync(dir, { recursive: true });
const T = 1_760_000_000;
const w = (name: string, lines: string[]) => fs.writeFileSync(dir + name, lines.join(''));
const rec = (o: unknown) => JSON.stringify(o) + '\n';
const iso = (s: number) => new Date(s * 1000).toISOString();

w('claude-streaming.jsonl', claudeLines({ start: T, steps: 6, chunks: 3, tokens: { input: 600, output: 3000, cacheCreate: 40_000, cacheRead: 90_000 }, handback: true }));
w('claude-progress.jsonl', claudeLines({ start: T, steps: 4, report: 'PROGRESS: 40% - running the suite', pendingTail: true }));
w('claude-resumed.jsonl', [...claudeLines({ start: T, steps: 2, handback: true }), ...claudeLines({ start: T + 500, steps: 2 }).slice(1)]);
w('claude-hostile.jsonl', [
  '[]\n', '"str"\n', '5\n', 'null\n', 'not json at all\n', '\n',
  rec({ type: 'assistant', timestamp: iso(T), message: 5 }),
  rec({ type: 'assistant', timestamp: iso(T + 1), message: { content: 'x', usage: { input_tokens: 'x', output_tokens: -4 } } }),
  rec({ type: 'assistant', timestamp: 'nope', message: { id: 'm1', usage: { input_tokens: 1e40, output_tokens: 7, cache_read_input_tokens: 2.5 }, content: [5, null, { type: 'text', text: 'Progress: 100% fine\nPROGRESS: 150% - capped‮' }, { type: 'tool_use', id: ['x'], name: 9 }] } }),
  rec({ type: 'user', timestamp: iso(T + 2), message: { content: [5, { type: 'tool_result', tool_use_id: [1] }, { type: 'tool_result', tool_use_id: 'unknown' }] } }),
  rec({ type: 'assistant', timestamp: iso(T + 3), requestId: 'r9', message: { usage: { input_tokens: 3, output_tokens: 4 }, content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } }),
  rec({ type: 'assistant', timestamp: iso(T + 4), requestId: 'r9', message: { usage: { input_tokens: 3, output_tokens: 9 }, content: [] } }),
]);
// a line nested 5000 deep sits between two records: the Mac bar's Python raises RecursionError there and loses the whole
// agent; this scanner skips just that line (serde_json refuses it, the page never sees it)
const tool = (i: number) => rec({ type: 'assistant', timestamp: iso(T + i), message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash' }] } });
w('claude-deepnest.jsonl', [tool(1), `{"type":"assistant","x":${'['.repeat(5000)}${']'.repeat(5000)}}\n`, tool(2)]);
w('codex-basic.jsonl', codexLines({ start: T, steps: 5, title: 'Fix the checkout test', complete: true }));
w('codex-tokens.jsonl', codexLines({ start: T, steps: 4, tokens: { input: 1000, cached: 600, output: 50 }, report: 'a line\nPROGRESS: 70% - almost there\n', pendingTail: true }));
w('codex-hostile.jsonl', [
  rec({ type: 'event_msg', payload: 5 }),
  rec({ timestamp: iso(T), type: 'response_item', payload: { type: 'function_call', call_id: [1], name: 5, action: 3 } }),
  rec({ timestamp: iso(T + 1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for x' }, { type: 'input_text', text: 'blah <INSTRUCTIONS> blah' }, { type: 'input_text', text: '  Real prompt ‮ with   spaces  ' }] } }),
  rec({ timestamp: iso(T + 2), type: 'response_item', payload: { type: 'local_shell_call', call_id: 'c1', action: { type: 'exec' } } }),
  rec({ timestamp: iso(T + 3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 'x' } } } }),
  rec({ timestamp: iso(T + 4), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 120, output_tokens: 5, cache_write_input_tokens: 7 } } } }),
  rec({ timestamp: iso(T + 5), type: 'event_msg', payload: { type: 'turn_aborted' } }),
]);
console.log('fixtures written to', dir);

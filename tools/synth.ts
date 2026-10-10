// Synthetic transcript generators (erasable TypeScript only, so Node can run it directly). Nothing here is real data:
// every text is invented. Used by the vitest suites, the screenshots, the perf run and the manual run.

export interface ClaudeSpec {
  start: number; // epoch seconds of the first record
  steps?: number; // tool calls
  gap?: number; // seconds between records
  tokens?: { input: number; output: number; cacheCreate?: number; cacheRead?: number };
  chunks?: number; // each API response is written as this many streamed records (same message.id)
  report?: string; // text of a PROGRESS line placed in the last assistant text
  handback?: boolean;
  pendingTail?: boolean; // the last tool call has no result yet
  tool?: string;
}

const iso = (sec: number) => new Date(sec * 1000).toISOString();

/** JSONL lines (each ends with a newline) of a Claude Code subagent transcript. */
export function claudeLines(spec: ClaudeSpec): string[] {
  const out: string[] = [];
  const gap = spec.gap ?? 5;
  const steps = spec.steps ?? 3;
  const chunks = Math.max(1, spec.chunks ?? 1);
  let t = spec.start;
  out.push(JSON.stringify({ type: 'user', timestamp: iso(t), message: { role: 'user', content: [{ type: 'text', text: 'synthetic prompt' }] } }) + '\n');
  const tk = spec.tokens;
  for (let i = 0; i < steps; i++) {
    t += gap;
    const id = `toolu_${spec.start}_${i}`;
    const last = i === steps - 1;
    const content: unknown[] = [];
    if (last && spec.report) content.push({ type: 'text', text: `Working on it.\n${spec.report}\nmore text` });
    content.push({ type: 'tool_use', id, name: spec.tool ?? 'Bash', input: { command: 'echo synthetic' } });
    for (let c = 1; c <= chunks; c++) {
      const share = c / chunks;
      const usage = tk ? {
        input_tokens: Math.round((tk.input / steps) * share), output_tokens: Math.round((tk.output / steps) * share),
        cache_creation_input_tokens: Math.round(((tk.cacheCreate ?? 0) / steps) * share), cache_read_input_tokens: Math.round(((tk.cacheRead ?? 0) / steps) * share),
      } : undefined;
      out.push(JSON.stringify({ type: 'assistant', timestamp: iso(t), requestId: `req_${spec.start}_${i}`, message: { id: `msg_${spec.start}_${i}`, role: 'assistant', ...(usage ? { usage } : {}), content: c === chunks ? content : [] } }) + '\n');
    }
    if (!(last && spec.pendingTail)) {
      t += gap;
      out.push(JSON.stringify({ type: 'user', timestamp: iso(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'synthetic output' }] } }) + '\n');
    }
  }
  if (spec.handback) {
    t += gap;
    out.push(JSON.stringify({ type: 'assistant', timestamp: iso(t), message: { id: `msg_${spec.start}_end`, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${spec.start}_end`, name: 'SubagentHandback', input: { message: 'synthetic report' } }] } }) + '\n');
  }
  return out;
}

export interface CodexSpec {
  start: number; steps?: number; gap?: number; title?: string; complete?: boolean; aborted?: boolean;
  tokens?: { input: number; output: number; cached?: number }; report?: string; pendingTail?: boolean;
}

/** JSONL lines of a Codex rollout file. */
export function codexLines(spec: CodexSpec): string[] {
  const out: string[] = [];
  const gap = spec.gap ?? 5;
  const steps = spec.steps ?? 3;
  let t = spec.start;
  const rec = (type: string, payload: unknown) => out.push(JSON.stringify({ timestamp: iso(t), type, payload }) + '\n');
  rec('event_msg', { type: 'task_started' });
  rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] });
  rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: spec.title ?? 'Synthetic codex task' }] });
  for (let i = 0; i < steps; i++) {
    t += gap;
    const callId = `call_${spec.start}_${i}`;
    rec('response_item', { type: 'function_call', name: 'shell', call_id: callId, arguments: '{}' });
    if (!(i === steps - 1 && spec.pendingTail)) { t += gap; rec('response_item', { type: 'function_call_output', call_id: callId, output: 'ok' }); }
    if (spec.tokens) {
      const f = (i + 1) / steps;
      rec('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: Math.round(spec.tokens.input * f), cached_input_tokens: Math.round((spec.tokens.cached ?? 0) * f), output_tokens: Math.round(spec.tokens.output * f) } } });
    }
  }
  if (spec.report) { t += gap; rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: spec.report }] }); }
  if (spec.complete) { t += gap; rec('event_msg', { type: 'task_complete' }); }
  if (spec.aborted) { t += gap; rec('event_msg', { type: 'turn_aborted' }); }
  return out;
}

/** The synthetic fleet used by the screenshots and the demo: names, kinds and timings are invented. */
export interface DemoAgent { kind: 'claude' | 'codex'; name: string; agentType?: string; description?: string; lines: string[] }

export function demoFleet(now: number): DemoAgent[] {
  const min = 60;
  const done = (n: string, desc: string, endAgo: number, dur: number, steps: number, tok: ClaudeSpec['tokens']): DemoAgent => ({
    kind: 'claude', name: n, agentType: 'general-purpose', description: desc,
    lines: claudeLines({ start: now - endAgo - dur, steps, gap: dur / (steps * 2 + 1), tokens: tok, handback: true }),
  });
  return [
    { kind: 'claude', name: 'agent-run1', agentType: 'general-purpose', description: 'Refactor auth middleware', lines: claudeLines({ start: now - 190, steps: 38, gap: 2.5, tokens: { input: 40_000, output: 172_000, cacheCreate: 900_000, cacheRead: 2_200_000 }, report: 'PROGRESS: 63% - running the tests' }) },
    { kind: 'claude', name: 'agent-run2', agentType: 'general-purpose', description: 'Review the diff for bugs', lines: claudeLines({ start: now - 80, steps: 5, gap: 8, tokens: { input: 300, output: 650 } }) },
    { kind: 'codex', name: 'rollout-2026-10-07T10-00-00-aaaa1111', lines: codexLines({ start: now - 400, steps: 52, gap: 3.5, title: 'Fix flaky checkout test' }) },
    done('agent-done1', 'Write release notes for v2.4 and check every link in the changelog', 3600, 20 * min, 31, { input: 200_000, output: 1_200_000 }),
    done('agent-done2', 'Pipeline: review, tests', 2600, 20 * min, 80, { input: 400, output: 800 }),
    { kind: 'codex', name: 'rollout-2026-10-07T09-00-00-bbbb2222', lines: codexLines({ start: now - 1900, steps: 9, gap: 9, title: 'Codex job with no token counts', complete: true }) },
    { kind: 'claude', name: 'agent-stall1', agentType: 'general-purpose', description: 'Stalled one', lines: claudeLines({ start: now - 1400, steps: 12, gap: 20, tokens: { input: 1000, output: 4300 } }) },
  ];
}

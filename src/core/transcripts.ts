// Record parsing for Claude Code subagent transcripts and Codex rollout files (port of agents_core.py feed/result functions).
// The input is one decoded JSON record at a time. The Rust scanner hands over "slim" records (same shape, only the fields
// used here), and the full records give exactly the same result: tests/fixtures run through both.
import { clean, count } from './text.ts';

export const IDLE_GAP = 600; // a quiet stretch longer than this only counts as this much active time
export const MAX_REPORTED_PCT = 99; // 100% only counts once the agent has actually handed back
export const NOTE_CHARS = 48;
export const MAX_REMEMBERED = 50000; // response ids remembered for de-duplication per transcript

// An agent can report its own progress with a line starting "PROGRESS: 40% - running tests".
// Uppercase and at the start of a line only, so prose like "Progress: 100% of tests pass" is ignored.
// Lines are split on "\n" only (a lone \r, U+2028 or U+0085 never starts a line), and the number may be written with any
// Unicode decimal digits (Persian, Arabic-Indic ...), exactly as the Mac code's Python \d accepts.
const REPORT_LINE = /^[ \t>*_`-]*PROGRESS[ \t]*:[ \t]*(\p{Nd}{1,3})[ \t]*%[ \t]*[-\u2013\u2014:\u00b7|]?[ \t]*([^\n]*)$/u;
const ND = /^\p{Nd}$/u;

/** The value of one Unicode decimal digit: digits come in runs of ten starting at a zero. */
export function digitValue(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp >= 48 && cp <= 57) return cp - 48;
  let start = cp;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

export function parseDigits(s: string): number {
  let n = 0;
  for (const ch of s) n = n * 10 + digitValue(ch);
  return n;
}

export type Report = [pct: number, note: string];

/** Last self-reported (percent, note) in a block of agent text, or null. */
export function findReport(text: unknown): Report | null {
  if (typeof text !== 'string' || !text.includes('PROGRESS')) return null;
  let found: Report | null = null;
  for (const line of text.split('\n')) {
    const m = REPORT_LINE.exec(line);
    if (m) found = [Math.min(MAX_REPORTED_PCT, parseDigits(m[1]!)), clean(m[2], NOTE_CHARS)];
  }
  return found;
}

/** Date.UTC with years 0 to 99 meaning those years, not 1900 + year. */
function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  const dt = new Date(Date.UTC(2000, mo, d, h, mi, s));
  dt.setUTCFullYear(y, mo, d);
  return dt;
}

/** Epoch seconds from an ISO 8601 timestamp, or null. Strict: an impossible date (2026-02-30), hour 24 or minute 60 is no
 * time at all (not rolled over to the next day), a zone is `Z`, `+hh`, `+hhmm` or `+hh:mm`, and a time with no zone is UTC. */
export function parseTs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:[.,](\d+))?)?(?:(Z)|([+-])(\d\d)(?::?(\d\d))?)?)?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, se] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return null;
  const days = utc(y, mo, 0).getUTCDate();
  if (d > days) return null;
  let off = 0;
  if (m[9]) {
    const oh = Number(m[10]), om = Number(m[11] ?? 0);
    if (oh > 23 || om > 59) return null;
    off = (m[9] === '-' ? -1 : 1) * (oh * 3600 + om * 60);
  }
  const frac = m[7] ? Number(`0.${m[7].slice(0, 6)}`) : 0;
  const t = utc(y, mo - 1, d, h, mi, se).getTime() / 1000 - off + frac;
  return Number.isFinite(t) ? t : null;
}

/** Python truthiness of a JSON value (the Mac code's `a or b`): "" 0 false null [] {} are falsy. */
export const pyTruthy = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0) || (isRec(v) && Object.keys(v).length === 0));

export type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Clocked { first: number | null; last: number | null; active: number }

function tick(s: Clocked, d: Rec): void {
  const t = parseTs(d.timestamp);
  if (t === null) return;
  if (s.last !== null) s.active += Math.min(Math.max(0, t - s.last), IDLE_GAP);
  s.first = s.first === null ? t : s.first;
  s.last = s.last === null ? t : Math.max(s.last, t);
}

// ---- Claude Code ------------------------------------------------------------------------------------------------

export interface ClaudeState extends Clocked {
  tools: number; lastTool: string; handedBack: boolean; report: Report | null; pending: Set<string>;
  resp: Map<string, [number, number, number, number]>; tok: [number, number, number, number]; tokSeen: boolean;
}

export const newClaude = (): ClaudeState => ({
  first: null, last: null, active: 0, tools: 0, lastTool: '', handedBack: false, report: null, pending: new Set(),
  resp: new Map(), tok: [0, 0, 0, 0], tokSeen: false,
});

/** Adds one assistant record's message.usage. Claude Code writes one record per streamed chunk of a response, each
 * repeating the same message.id; per id the largest value of each field is kept and the totals move by the difference. */
function tallyClaude(s: ClaudeState, d: Rec, message: Rec): void {
  const usage = message.usage;
  if (!isRec(usage)) return;
  const vals = [count(usage.input_tokens), count(usage.output_tokens), count(usage.cache_creation_input_tokens), count(usage.cache_read_input_tokens)];
  if (vals.every((v) => v === null)) return;
  const idOf = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const rid = idOf(message.id) ?? idOf(d.requestId);
  const old: [number, number, number, number] = (rid && s.resp.get(rid)) || [0, 0, 0, 0];
  const next = old.map((o, i) => Math.max(o, vals[i] ?? 0)) as [number, number, number, number];
  s.tok = s.tok.map((t, i) => t + next[i]! - old[i]!) as [number, number, number, number];
  s.tokSeen = true;
  if (rid) {
    if (s.resp.size >= MAX_REMEMBERED) s.resp.clear(); // bounded memory: only a later repeat of a forgotten id is lost
    s.resp.set(rid, next);
  }
}

export function feedClaude(s: ClaudeState, d: Rec): void {
  tick(s, d);
  const type = d.type;
  if (type !== 'assistant' && type !== 'user') return;
  const message = isRec(d.message) ? d.message : null;
  if (type === 'assistant' && message) tallyClaude(s, d, message);
  const content = message?.content;
  if (!Array.isArray(content)) return;
  if (type === 'user') {
    for (const b of content) if (isRec(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') s.pending.delete(b.tool_use_id);
    return;
  }
  for (const b of content) {
    if (!isRec(b)) continue;
    if (b.type === 'text') {
      s.report = findReport(b.text) ?? s.report;
      s.handedBack = false; // it kept talking after a handback: it was resumed
    } else if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === 'SubagentHandback') s.handedBack = true;
      else {
        s.handedBack = false; // work after a handback means a resumed agent
        s.tools += 1;
        s.lastTool = name;
        if (typeof b.id === 'string') s.pending.add(b.id);
      }
    }
  }
}

export interface Parsed {
  tokNew: number | null; tokCache: number | null; first: number | null; last: number | null; active: number; tools: number;
  lastTool: string; done: boolean; report: Report | null; pending: number; title?: string;
}

export function resultClaude(s: ClaudeState): Parsed {
  const [i, o, cc, cr] = s.tok;
  return {
    tokNew: s.tokSeen ? i + o : null, tokCache: s.tokSeen ? cc + cr : null, first: s.first, last: s.last, active: s.active,
    tools: s.tools, lastTool: s.lastTool, done: s.handedBack, report: s.report, pending: s.pending.size,
  };
}

// ---- Codex ------------------------------------------------------------------------------------------------------

export interface CodexState extends Clocked {
  tools: number; lastTool: string; status: string | null; title: string; report: Report | null; pending: Set<string>;
  tok: [number, number] | null;
}

export const newCodex = (): CodexState => ({
  first: null, last: null, active: 0, tools: 0, lastTool: '', status: null, title: '', report: null, pending: new Set(), tok: null,
});

const CODEX_TOOLS = new Set(['custom_tool_call', 'function_call', 'local_shell_call']);
const CODEX_OUTPUTS = new Set(['custom_tool_call_output', 'function_call_output', 'local_shell_call_output']);

/** Codex puts AGENTS.md and environment context in as user messages; they are not the prompt. */
const injected = (text: string) => text.startsWith('<') || text.startsWith('# AGENTS.md') || text.includes('<INSTRUCTIONS>');

/** (new, cache) from a token_count event's running total. Codex counts cached input inside input_tokens, so
 * new = input - cached + output; reasoning tokens are already part of output_tokens. */
function codexTokens(info: unknown): [number, number] | null {
  const total = isRec(info) ? info.total_token_usage : null;
  if (!isRec(total)) return null;
  const inp = count(total.input_tokens), out = count(total.output_tokens);
  if (inp === null && out === null) return null;
  const cached = count(total.cached_input_tokens) ?? 0, written = count(total.cache_write_input_tokens) ?? 0;
  return [Math.max(0, (inp ?? 0) - cached) + (out ?? 0), cached + written];
}

export function feedCodex(s: CodexState, d: Rec): void {
  tick(s, d);
  const payload = isRec(d.payload) ? d.payload : {};
  const kind = payload.type;
  if (d.type === 'event_msg') {
    if (kind === 'task_started' || kind === 'task_complete' || kind === 'turn_aborted') s.status = kind;
    else if (kind === 'token_count') s.tok = codexTokens(payload.info) ?? s.tok;
  } else if (d.type === 'response_item') {
    if (typeof kind === 'string' && CODEX_OUTPUTS.has(kind)) {
      if (typeof payload.call_id === 'string') s.pending.delete(payload.call_id);
    } else if (typeof kind === 'string' && CODEX_TOOLS.has(kind)) {
      if (typeof payload.call_id === 'string') s.pending.add(payload.call_id);
      s.tools += 1;
      const action = payload.action;
      const name = pyTruthy(payload.name) ? payload.name : isRec(action) ? action.type : null;
      s.lastTool = typeof name === 'string' && name ? name : 'shell';
    } else if (kind === 'message' && payload.role === 'assistant') {
      const blocks = Array.isArray(payload.content) ? payload.content : [];
      for (const b of blocks) if (isRec(b)) s.report = findReport(b.text) ?? s.report;
    } else if (kind === 'message' && payload.role === 'user' && !s.title) {
      const blocks = Array.isArray(payload.content) ? payload.content : [];
      for (const b of blocks) {
        const raw = isRec(b) ? b.text : null;
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (text && !injected(text)) { s.title = clean(text, 80); break; }
      }
    }
  }
}

export function resultCodex(s: CodexState): Parsed {
  const tok = s.tok ?? [null, null];
  return {
    tokNew: tok[0], tokCache: tok[1], first: s.first, last: s.last, active: s.active, tools: s.tools, lastTool: s.lastTool,
    done: s.status === 'task_complete' || s.status === 'turn_aborted', title: s.title, report: s.report, pending: s.pending.size,
  };
}

export type Kind = 'claude' | 'codex';
export type AnyState = ClaudeState | CodexState;

export const newState = (kind: Kind): AnyState => (kind === 'claude' ? newClaude() : newCodex());
export const feed = (kind: Kind, s: AnyState, d: Rec): void => (kind === 'claude' ? feedClaude(s as ClaudeState, d) : feedCodex(s as CodexState, d));
export const resultOf = (kind: Kind, s: AnyState): Parsed => (kind === 'claude' ? resultClaude(s as ClaudeState) : resultCodex(s as CodexState));

/** Parses whole text (one JSON record per line, as a transcript file is) the way the scanner does: a bad line is skipped,
 * a last line without a newline that does not parse yet is left. Used by tests and the demo backend. */
export function parseText(kind: Kind, text: string): Parsed {
  const s = newState(kind);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d: unknown;
    try { d = JSON.parse(line); } catch { continue; }
    if (isRec(d)) feed(kind, s, d);
  }
  return resultOf(kind, s);
}

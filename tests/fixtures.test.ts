import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseText, type Kind } from '../src/core/transcripts';

// The same fixtures go through the Rust slimmer (src-tauri/src/scanner.rs `slim_golden` writes tests/fixtures/slim) and the
// TypeScript parser. The parser must give the same answer for the full record and for the slimmed one.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures') + path.sep;
const names = fs.readdirSync(dir + 'transcripts').filter((n) => n.endsWith('.jsonl')).sort();
const kindOf = (n: string): Kind => (n.startsWith('codex') ? 'codex' : 'claude');
const full = (n: string) => parseText(kindOf(n), fs.readFileSync(`${dir}transcripts/${n}`, 'utf8'));
const slim = (n: string) => parseText(kindOf(n), fs.readFileSync(`${dir}slim/${n}`, 'utf8'));

describe('full and slimmed records parse identically', () => {
  it('has the fixtures', () => expect(names.length).toBeGreaterThanOrEqual(8));
  for (const n of names) it(n, () => expect(slim(n)).toEqual(full(n)));
});

describe('fixture expectations', () => {
  it('streaming chunks are counted once; new and cache tokens apart; handback = done', () => {
    const p = full('claude-streaming.jsonl');
    expect(p).toMatchObject({ tools: 6, done: true, tokNew: 3600, tokCache: 130_002, pending: 0 });
  });
  it('progress fixture: reported 40 %, one tool call waiting', () => {
    expect(full('claude-progress.jsonl')).toMatchObject({ report: [40, 'running the suite'], pending: 1, done: false });
  });
  it('a resumed agent is not done', () => expect(full('claude-resumed.jsonl').done).toBe(false));
  it('hostile Claude records: bad tokens ignored, 150 % capped at 99, bidi removed, request id fallback keeps the max', () => {
    const p = full('claude-hostile.jsonl');
    expect(p.report).toEqual([99, 'capped']);
    expect(p.tokNew).toBe(7 + 9 + 3); // m1: 7 (input 1e40 ignored); r9: input 3 + output max(4, 9)
    expect(p.tools).toBe(2); // the tool_use with a bad name still counts as a step
  });
  it('a line nested 5000 deep is skipped: both records around it count', () => expect(full('claude-deepnest.jsonl')).toMatchObject({ tools: 2 }));
  it('codex fixtures', () => {
    expect(full('codex-basic.jsonl')).toMatchObject({ title: 'Fix the checkout test', done: true, tools: 5 });
    expect(full('codex-tokens.jsonl')).toMatchObject({ tokNew: 450, tokCache: 600, report: [70, 'almost there'], pending: 1 });
    const h = full('codex-hostile.jsonl');
    expect(h).toMatchObject({ title: 'Real prompt with spaces', done: true, tokNew: 5, tokCache: 127, tools: 2 });
  });
});

describe('fixtures are byte-exact LF files', () => {
  /** Every tracked fixture file (they are compared byte for byte by the Rust tests and offsets depend on exact line ends). */
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  it('contain no carriage return (a CRLF checkout would change offsets and line splitting)', () => {
    const files = walk(dir);
    expect(files.length).toBeGreaterThanOrEqual(16);
    for (const f of files) expect(fs.readFileSync(f).includes(0x0d), `${f} has a CR`).toBe(false);
  });
  it('.gitattributes pins fixtures and text files to LF', () => {
    const ga = fs.readFileSync(path.join(dir, '..', '..', '.gitattributes'), 'utf8');
    expect(ga).toContain('* text=auto eol=lf');
    expect(ga).toContain('tests/fixtures/** text eol=lf');
  });
});

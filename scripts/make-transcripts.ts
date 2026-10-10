// Writes a synthetic transcript tree (invented text only) for the manual run and the perf run.
// Usage: node scripts/make-transcripts.ts <outDir> [claudeCount] [codexCount] [stepsPerFile]
import fs from 'node:fs';
import path from 'node:path';
import { claudeLines, codexLines, demoFleet } from '../tools/synth.ts';

const [out, nc = '0', nx = '0', ns = '40'] = process.argv.slice(2);
if (!out) { console.error('usage: make-transcripts.ts <outDir> [claudeCount] [codexCount] [steps]'); process.exit(2); }
const now = Date.now() / 1000;
const claudeRoot = path.join(out, 'claude'), codexRoot = path.join(out, 'codex');
const sub = path.join(claudeRoot, '-synthetic-project', 'session-1', 'subagents');
fs.mkdirSync(sub, { recursive: true });
const day = new Date().toISOString().slice(0, 10).split('-');
const cdir = path.join(codexRoot, ...day);
fs.mkdirSync(cdir, { recursive: true });
const put = (file: string, lines: string[], ageSec: number) => {
  fs.writeFileSync(file, lines.join(''));
  const t = new Date((now - ageSec) * 1000);
  fs.utimesSync(file, t, t);
};
if (Number(nc) === 0 && Number(nx) === 0) {
  // the demo fleet, with a fresh mtime that matches its last record
  for (const a of demoFleet(now)) {
    const file = a.kind === 'claude' ? path.join(sub, `${a.name}.jsonl`) : path.join(cdir, `${a.name}.jsonl`);
    const lastTs = Date.parse(JSON.parse(a.lines[a.lines.length - 1]!.trim()).timestamp) / 1000;
    put(file, a.lines, now - lastTs);
    if (a.kind === 'claude') fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: a.agentType, description: a.description }));
  }
} else {
  for (let i = 0; i < Number(nc); i++) {
    const age = 30 + i * 120;
    put(path.join(sub, `agent-p${i}.jsonl`), claudeLines({ start: now - age - 600, steps: Number(ns), gap: 5, chunks: 2, tokens: { input: 5000, output: 20000, cacheCreate: 100000, cacheRead: 400000 }, handback: i % 3 === 0 }), age);
    fs.writeFileSync(path.join(sub, `agent-p${i}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `Synthetic task number ${i}` }));
  }
  for (let i = 0; i < Number(nx); i++) {
    const age = 40 + i * 150;
    put(path.join(cdir, `rollout-p${i}.jsonl`), codexLines({ start: now - age - 600, steps: Number(ns), gap: 5, title: `Synthetic codex task ${i}`, complete: i % 2 === 0, tokens: { input: 90000, output: 8000, cached: 60000 } }), age);
  }
}
console.log(JSON.stringify({ claudeDir: claudeRoot, codexDir: codexRoot }));

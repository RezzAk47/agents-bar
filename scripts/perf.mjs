// TypeScript-side cost of the 300-transcript scan: feeds the Rust cold reply (cargo test --release perf_300, PERF_OUT=file) through AgentScanner.
// Usage: node scripts/perf.mjs <reply.json>
import fs from 'node:fs';
import { AgentScanner } from '../src/core/agents.ts';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/perf.mjs <reply.json>'); process.exit(2); }
const reply = JSON.parse(fs.readFileSync(file, 'utf8'));
let sent = false;
const backend = { async scan() { if (sent) return { files: [], known: reply.known, more: false }; sent = true; return reply; } };
const sc = new AgentScanner(backend);
const now = Date.now() / 1000;
let t = performance.now();
const agents = await sc.scan(now, true);
console.log(`TS cold feed: ${(performance.now() - t).toFixed(0)} ms for ${reply.files.length} files, ${agents.length} agents`);
t = performance.now();
for (let i = 0; i < 20; i++) await sc.scan(now, false);
console.log(`TS warm rescan (no new records): ${((performance.now() - t) / 20).toFixed(2)} ms per scan incl. estimate and sort`);
console.log(`heap used after: ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);

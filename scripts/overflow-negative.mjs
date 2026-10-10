// The overflow check must be able to FAIL: with a deliberately broken layout it has to exit non-zero and name the element.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot } from './lib.mjs';

const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'overflow.mjs')], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, OVERFLOW_BREAK: '1', OVERFLOW_QUICK: '1' }, maxBuffer: 1 << 26 });
const out = `${run.stdout}\n${run.stderr}`;
if (run.status === 0 || !out.includes('FAIL overflow') || !out.includes('sticks out: ')) { console.error('the overflow check did NOT fail on a broken layout:\n' + out.slice(-1200)); process.exit(1); }
console.log('ok   the overflow check fails on a broken layout and names the element that sticks out');

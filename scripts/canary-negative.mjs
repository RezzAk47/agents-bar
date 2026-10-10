// The privacy check must be able to FAIL: with the PROGRESS lines left out of the transcripts, scripts/canary.mjs has to exit
// non-zero and name the missing note. Usage: node scripts/canary-negative.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot } from './lib.mjs';

const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'canary.mjs')], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, CANARY_DROP_NOTE: '1' }, maxBuffer: 1 << 26 });
const out = `${run.stdout}\n${run.stderr}`;
const failedAsExpected = run.status !== 0 && out.includes('FAIL the page shows both PROGRESS notes') && out.includes('FAIL the scanner output has what the page shows: claude note visible') && out.includes('DIAGNOSTICS');
if (!failedAsExpected) { console.error('the canary check did NOT fail with the notes removed: it cannot be trusted\n' + out.slice(-1500)); process.exit(1); }
console.log('ok   the canary check fails when the PROGRESS notes are missing (and prints diagnostics)');

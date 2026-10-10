// The CI workflow cannot be run here, so its hardening is checked as text: timeouts, one run per branch, read-only token,
// and every action pinned to a full commit SHA.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const yml = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const toml = fs.readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('CI workflow hardening', () => {
  it('every job has a timeout', () => {
    const jobs = [...yml.matchAll(/^  ([a-z-]+):\n    (?:name:.*\n    )?runs-on:/gm)].length;
    expect(jobs).toBe(2);
    expect([...yml.matchAll(/^    timeout-minutes: 30$/gm)].length).toBe(jobs);
  });
  it('duplicate runs of one branch cancel each other', () => {
    expect(yml).toMatch(/^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.head_ref \|\| github\.ref_name \}\}\n  cancel-in-progress: true/m);
  });
  it('the token is read-only', () => expect(yml).toMatch(/^permissions:\n  contents: read$/m));
  it('every action is pinned to a full commit SHA', () => {
    const uses = [...yml.matchAll(/uses: ([^\s]+)@([^\s]+)/g)];
    expect(uses.length).toBeGreaterThan(5);
    const unpinned = uses.filter((u) => !/^[0-9a-f]{40}$/.test(u[2]));
    expect(unpinned).toEqual([]);
  });
  it('checkouts do not keep the token, cargo uses the lock file', () => {
    const checkouts = [...yml.matchAll(/uses: actions\/checkout@[0-9a-f]{40} # v4\n(?:\s+with:\n\s+persist-credentials: false)?/g)];
    expect(checkouts.length).toBeGreaterThanOrEqual(2);
    for (const c of checkouts) expect(c[0]).toContain('persist-credentials: false');
    const cargo = [...yml.matchAll(/run: cargo (\w+)([^\n]*)/g)];
    expect(cargo.length).toBeGreaterThanOrEqual(2);
    for (const c of cargo) expect(c[0], c[0]).toContain('--locked');
  });
  it('the privacy canary runs in CI', () => expect(yml).toContain('npm run privacy'));
  it('the Rust version in Cargo.toml, README and CI agree', () => {
    expect(toml).toMatch(/rust-version = "1\.90"/);
    expect(readme).toMatch(/1\.90/);
    expect(readme).not.toMatch(/1\.80/);
    expect(yml).toContain('1.90');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileStamp } from '../src/core/io';

export function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentsbar-test-')); }

/** A file stat as whole microseconds (the same shape the Rust side sends). */
export function statOf(file: string): FileStamp | null {
  try { const s = fs.statSync(file, { bigint: true }); return { size: Number(s.size), mtimeUs: Number(s.mtimeNs / 1000n), ctimeUs: Number(s.ctimeNs / 1000n), ino: String(s.ino) }; } catch { return null; }
}

export function bumpMtime(file: string, secs = 5): void {
  const t = new Date(Date.now() + secs * 1000);
  fs.utimesSync(file, t, t);
}

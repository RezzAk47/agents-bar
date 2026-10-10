import type { FileIO } from '../core/io';
import type { ScanBackend } from '../core/agents';
import type { GhBackend } from '../core/github';

export type Platform = 'macos' | 'windows' | 'linux';

/** Everything the app needs from the operating system. The Tauri build and the browser preview each provide one. */
export interface Backend {
  kind: 'tauri' | 'browser';
  platform: Platform;
  io: FileIO;
  dataDir: string;
  /** Incremental transcript reader (Rust in the app, synthetic data in the preview). */
  scan: ScanBackend;
  /** null when gh cannot be used at all in this backend. */
  gh: GhBackend | null;
  /** Resolves true only when the OS accepted the notification. With AGENTSBAR_NO_NOTIFICATIONS it sends nothing and resolves true, so finishes are still recorded. */
  notify: (title: string, body: string) => Promise<boolean>;
  /** True when notifications are switched off for this run (AGENTSBAR_NO_NOTIFICATIONS). */
  notifyOff: boolean;
  now: () => number; // ms
  setTrayLabel(label: string): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
  /** Shows a transcript in the file manager. The Rust side only accepts paths its own scanner found. */
  revealTranscript(path: string): Promise<void>;
  /** The Rust side builds https://github.com/<owner>/<repo> from the validated names and opens it. */
  openRepo(slug: string): Promise<void>;
  autostart: { isEnabled(): Promise<boolean>; set(on: boolean): Promise<void> } | null;
  onTick(cb: () => void): () => void;
  /** The computer woke from sleep (Rust sends it from its tick thread). Optional: the browser preview has none. */
  onSlept?(cb: () => void): () => void;
  onShown(cb: () => void): () => void;
  trayNote: string | null;
}

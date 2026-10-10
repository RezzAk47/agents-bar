// The desktop backend: a handful of Rust commands. Rust owns every file read (bounded, incremental) and every gh call.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import type { Backend, Platform } from './types';
import { ConflictError, errMessage, isConflict, type FileStamp } from '../core/io';
import type { ScanReply } from '../core/agents';

interface AppInfo { platform: Platform; dataDir: string; noNotifications: boolean; trayNote: string | null }

const text = (cmd: string, args?: Record<string, unknown>) => invoke<string>(cmd, args).catch((e) => { throw new Error(errMessage(e)); });

function subscribe(event: string, cb: () => void): () => void {
  let off: (() => void) | null = null;
  let dead = false;
  void listen(event, cb).then((u) => { if (dead) u(); else off = u; });
  return () => { dead = true; off?.(); };
}

export async function tauriBackend(): Promise<Backend> {
  const info = await invoke<AppInfo>('app_info');
  return {
    kind: 'tauri', platform: info.platform, dataDir: info.dataDir, now: Date.now, trayNote: info.trayNote,
    io: {
      read: (name) => invoke<string | null>('fs_read', { name }).catch((e) => { throw new Error(errMessage(e)); }),
      stat: (name) => invoke<FileStamp | null>('fs_stat', { name }).catch((e) => { throw new Error(errMessage(e)); }),
      write: (name, body, expected) => invoke<void>('fs_write', { name, text: body, check: expected !== undefined, expected: expected ?? null })
        .catch((e) => { throw isConflict(e) ? new ConflictError(errMessage(e)) : new Error(errMessage(e)); }),
      moveAside: (name, backupName) => invoke<string>('fs_move_aside', { name, backupName }),
    },
    scan: { scan: (rediscover) => invoke<ScanReply>('scan_transcripts', { rediscover }).catch((e) => { throw new Error(errMessage(e)); }) },
    gh: {
      user: () => text('gh_user'),
      repoList: (fields, limit) => text('gh_repo_list', { fields, limit }),
      runList: (slug) => text('gh_run_list', { slug }),
    },
    notifyOff: info.noNotifications,
    // Sent from Rust, which reports a real failure (denied, no daemon) so the retries are driven by what actually happened.
    notify: (title, body) => invoke<void>('notify', { title, body }).then(() => true, () => false),
    setTrayLabel: (label) => invoke<void>('set_tray_label', { label }),
    hide: () => invoke<void>('hide_popup'),
    quit: () => invoke<void>('quit_app'),
    revealTranscript: (path) => invoke<void>('reveal_transcript', { path }).catch((e) => { throw new Error(errMessage(e)); }),
    openRepo: (slug) => invoke<void>('open_repo', { slug }).catch((e) => { throw new Error(errMessage(e)); }),
    autostart: { isEnabled: () => isEnabled(), set: (on) => (on ? enable() : disable()) },
    onTick: (cb) => subscribe('tick', cb),
    onSlept: (cb) => subscribe('slept', cb),
    onShown: (cb) => subscribe('popup-shown', cb),
  };
}

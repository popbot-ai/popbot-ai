/**
 * Per-chat PTY lifecycle. We hold one persistent shell per chat (rooted
 * in its slot worktree) so the user's shell state — cwd, env, in-flight
 * commands — survives focus changes and panel toggles. The PTY is
 * disposed only when the chat itself closes.
 *
 * The renderer's xterm instance comes and goes (re-mounts on focus),
 * so we keep a rolling output buffer here and replay it whenever a
 * fresh xterm attaches via `attach()`.
 */
import { homedir } from 'node:os';
import { spawn, type IPty } from 'node-pty';
import type { WebContents } from 'electron';
import { IpcChannel } from '@shared/ipc';
import { getSetting } from '../persistence/settings';

/** Cap on the rolling per-chat buffer. ~1MB of bytes; xterm's own
 *  scrollback covers anything past the replay window. */
const BUFFER_CAP_BYTES = 1024 * 1024;

interface Entry {
  pty: IPty;
  /** Rolling tail of recent stdout, replayed on attach. */
  buffer: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Main-side readers of this pty's output (besides the renderer). */
  listeners: Set<(data: string) => void>;
  /** Main-side readers of resizes — a mirror terminal must track them. */
  resizeListeners: Set<(cols: number, rows: number) => void>;
}

/** Which shell family the in-app terminal runs — decides how a command
 *  main writes into it has to be quoted. */
export type ShellKind = 'posix' | 'powershell' | 'cmd';

const sessions = new Map<string, Entry>();
let webContents: WebContents | null = null;

/**
 * The shell to spawn for the in-app terminal, per platform.
 *
 *  - Windows: user-selectable via Preferences → External apps
 *    (`apps.windowsShell`): PowerShell (default), Command Prompt (cmd),
 *    or PowerShell 7 (pwsh). No `-l` — that's a POSIX login-shell flag
 *    PowerShell/cmd don't understand.
 *  - macOS / Linux: the user's login shell (`$SHELL`, default zsh),
 *    started as a login shell so it sources the user's rc/profile.
 *
 * `POPBOT_TERMINAL_SHELL` (absolute path to any shell binary) overrides
 * everything, on any platform.
 */
function resolveShell(): { file: string; args: string[]; kind: ShellKind } {
  const override = process.env.POPBOT_TERMINAL_SHELL;
  if (override) return { file: override, args: [], kind: process.platform === 'win32' ? 'powershell' : 'posix' };
  if (process.platform === 'win32') {
    const choice = getSetting<{ windowsShell?: string }>('apps')?.windowsShell || 'powershell';
    switch (choice) {
      case 'cmd':
        return { file: process.env.ComSpec || 'cmd.exe', args: [], kind: 'cmd' };
      case 'pwsh':
        return { file: 'pwsh.exe', args: ['-NoLogo'], kind: 'powershell' };
      case 'powershell':
      default:
        return { file: 'powershell.exe', args: ['-NoLogo'], kind: 'powershell' };
    }
  }
  return {
    file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    args: ['-l'],
    kind: 'posix',
  };
}

export function shellKind(): ShellKind {
  return resolveShell().kind;
}

/** Quote one argument for a command line typed into the in-app shell. */
export function quoteForShell(text: string, kind: ShellKind = shellKind()): string {
  switch (kind) {
    case 'powershell':
      return `'${text.replace(/'/g, "''")}'`;
    case 'cmd':
      // cmd has no multi-line arguments; node CLIs parse `""` as a quote.
      return `"${text.replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`;
    case 'posix':
    default:
      return `'${text.replace(/'/g, "'\\''")}'`;
  }
}

export function attachWebContents(wc: WebContents): void {
  webContents = wc;
}

function broadcast(chatId: string, data: string): void {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.send(IpcChannel.TermData, { chatId, data });
}

/**
 * Open or reattach to the chat's PTY. When `cwd` differs from the
 * existing entry's, we tear it down and start fresh — usually a sign
 * the slot worktree got reassigned.
 */
export function open(chatId: string, cwdWanted: string, cols = 100, rows = 30): { ok: true; buffer: string } {
  // A chat with no folder of its own (a no-repo cloud chat) gets home.
  const cwd = cwdWanted && cwdWanted !== '~' ? cwdWanted : homedir();
  let entry = sessions.get(chatId);
  if (entry && entry.cwd !== cwd) {
    dispose(chatId);
    entry = undefined;
  }
  if (!entry) {
    const { file: shell, args: shellArgs } = resolveShell();
    const pty = spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>,
    });
    entry = { pty, buffer: '', cwd, cols, rows, listeners: new Set(), resizeListeners: new Set() };
    pty.onData((data: string) => {
      entry!.buffer += data;
      // Truncate from the front when we exceed the cap.
      if (entry!.buffer.length > BUFFER_CAP_BYTES) {
        entry!.buffer = entry!.buffer.slice(entry!.buffer.length - BUFFER_CAP_BYTES);
      }
      broadcast(chatId, data);
      for (const fn of entry!.listeners) {
        try { fn(data); } catch { /* a reader's bug must not break the terminal */ }
      }
    });
    pty.onExit(() => {
      sessions.delete(chatId);
      broadcast(chatId, '\r\n[process exited]\r\n');
    });
    sessions.set(chatId, entry);
  }
  return { ok: true, buffer: entry.buffer };
}

export function has(chatId: string): boolean {
  return sessions.has(chatId);
}

/** Read the chat's terminal output from main (e.g. to spot a session id
 *  the CLI prints). Returns the unsubscribe; the pty's disposal ends it. */
export function onOutput(chatId: string, fn: (data: string) => void): () => void {
  const e = sessions.get(chatId);
  if (!e) return () => undefined;
  e.listeners.add(fn);
  return () => { e.listeners.delete(fn); };
}

export function write(chatId: string, data: string): void {
  const e = sessions.get(chatId);
  if (!e) return;
  e.pty.write(data);
}

export function resize(chatId: string, cols: number, rows: number): void {
  const e = sessions.get(chatId);
  if (!e) return;
  if (e.cols === cols && e.rows === rows) return;
  e.cols = cols;
  e.rows = rows;
  try { e.pty.resize(cols, rows); } catch { /* pty may have just exited */ }
  for (const fn of e.resizeListeners) {
    try { fn(cols, rows); } catch { /* a reader's bug must not break the terminal */ }
  }
}

/** The pty's current size, for a mirror terminal to start from. */
export function size(chatId: string): { cols: number; rows: number } | null {
  const e = sessions.get(chatId);
  return e ? { cols: e.cols, rows: e.rows } : null;
}

/** The output already produced, for a mirror that starts late. */
export function replayBuffer(chatId: string): string {
  return sessions.get(chatId)?.buffer ?? '';
}

export function onResize(chatId: string, fn: (cols: number, rows: number) => void): () => void {
  const e = sessions.get(chatId);
  if (!e) return () => undefined;
  e.resizeListeners.add(fn);
  return () => { e.resizeListeners.delete(fn); };
}

export function dispose(chatId: string): void {
  const e = sessions.get(chatId);
  if (!e) return;
  try { e.pty.kill(); } catch { /* already gone */ }
  sessions.delete(chatId);
}

export function disposeAll(): void {
  for (const id of [...sessions.keys()]) dispose(id);
}

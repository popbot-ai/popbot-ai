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
import { spawn, type IPty } from 'node-pty';
import type { WebContents } from 'electron';
import { IpcChannel } from '@shared/ipc';

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
}

const sessions = new Map<string, Entry>();
let webContents: WebContents | null = null;

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
export function open(chatId: string, cwd: string, cols = 100, rows = 30): { ok: true; buffer: string } {
  let entry = sessions.get(chatId);
  if (entry && entry.cwd !== cwd) {
    dispose(chatId);
    entry = undefined;
  }
  if (!entry) {
    const shell = process.env.SHELL || '/bin/zsh';
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>,
    });
    entry = { pty, buffer: '', cwd, cols, rows };
    pty.onData((data: string) => {
      entry!.buffer += data;
      // Truncate from the front when we exceed the cap.
      if (entry!.buffer.length > BUFFER_CAP_BYTES) {
        entry!.buffer = entry!.buffer.slice(entry!.buffer.length - BUFFER_CAP_BYTES);
      }
      broadcast(chatId, data);
    });
    pty.onExit(() => {
      sessions.delete(chatId);
      broadcast(chatId, '\r\n[process exited]\r\n');
    });
    sessions.set(chatId, entry);
  }
  return { ok: true, buffer: entry.buffer };
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

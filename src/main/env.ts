/**
 * PATH fix for packaged Electron apps on macOS and Linux.
 *
 * When the app is launched from the desktop (Finder/Dock on macOS, a
 * `.desktop` launcher on Linux) it inherits a minimal PATH that omits the
 * dirs where dev tools usually live — Homebrew (`/opt/homebrew/bin`,
 * `/usr/local/bin`) on macOS, and `~/.local/bin` / `/snap/bin` / Linuxbrew on
 * Linux. That breaks `execFile('git'|'p4'|'gh'|'claude', …)` and any other tool
 * we shell out to that lives outside the system bin dirs.
 *
 * We ask the user's login shell what PATH it sets, and merge that into
 * `process.env.PATH` once at startup. Synchronous on purpose: must happen
 * before any IPC handler registers or fires execFile.
 *
 * In dev (`npm run dev`) PATH is already inherited from the launching shell, so
 * this is a no-op. Windows is skipped: GUI processes inherit the system/registry
 * PATH there correctly.
 */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { homedir } from 'node:os';
import { app } from 'electron';

export function fixShellPath(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  if (!app.isPackaged) return;

  // Default to the platform's usual interactive shell when $SHELL is unset (it
  // often is under a desktop launcher): zsh on macOS, bash on Linux.
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  let shellPath: string;
  try {
    // -i forces an interactive shell (sources .zshrc/.bashrc), -l a login shell
    // (sources .zprofile/.bash_profile). Combined, this reproduces what a
    // Terminal session sees.
    shellPath = execFileSync(shell, ['-ilc', 'echo "$PATH"'], {
      encoding: 'utf8',
      timeout: 3000,
      // Own session: keep the interactive `-i` shell from doing job-control on
      // our controlling terminal and SIGTTOU-suspending the app (see
      // resolveCli.ts). Cast — Node's execFileSync type omits `detached`.
      detached: true,
    } as ExecFileSyncOptionsWithStringEncoding).trim();
  } catch {
    // Shell init failed (rare — bad rc file, missing shell). Fall back to the
    // common per-platform tool prefixes so git / gh / p4 keep working.
    shellPath =
      process.platform === 'darwin'
        ? '/opt/homebrew/bin:/usr/local/bin'
        : `${homedir()}/.local/bin:/usr/local/bin:/snap/bin`;
  }

  if (!shellPath) return;
  const current = process.env.PATH || '';
  const seen = new Set(current.split(':'));
  const additions = shellPath.split(':').filter((p) => p && !seen.has(p));
  if (additions.length === 0) return;
  process.env.PATH = [current, ...additions].filter(Boolean).join(':');
}

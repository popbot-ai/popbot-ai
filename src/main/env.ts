/**
 * macOS-only PATH fix for packaged Electron apps.
 *
 * When the app is launched from Finder/Dock, it inherits launchd's
 * minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — Homebrew binaries
 * (`/opt/homebrew/bin`, `/usr/local/bin`) are missing. That breaks
 * `execFile('gh', ...)` in reviews, plus any other tool we shell out
 * to that lives outside the system bin dirs.
 *
 * We ask the user's login shell what PATH it sets, and merge that into
 * `process.env.PATH` once at startup. Synchronous on purpose: must
 * happen before any IPC handler registers or fires execFile.
 *
 * In dev (`npm run dev`) PATH is already inherited from the launching
 * shell, so this is a no-op.
 */
import { execFileSync } from 'node:child_process';
import { app } from 'electron';

export function fixShellPath(): void {
  if (process.platform !== 'darwin') return;
  if (!app.isPackaged) return;

  const shell = process.env.SHELL || '/bin/zsh';
  let shellPath: string;
  try {
    // -i forces an interactive shell (sources .zshrc/.bashrc), -l a
    // login shell (sources .zprofile/.bash_profile). Combined, this
    // reproduces what a Terminal.app session sees.
    shellPath = execFileSync(shell, ['-ilc', 'echo "$PATH"'], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
  } catch {
    // Shell init failed (rare — bad rc file, etc). Fall back to common
    // Homebrew prefixes so gh / git keep working for most users.
    shellPath = '/opt/homebrew/bin:/usr/local/bin';
  }

  if (!shellPath) return;
  const current = process.env.PATH || '';
  const seen = new Set(current.split(':'));
  const additions = shellPath.split(':').filter((p) => p && !seen.has(p));
  if (additions.length === 0) return;
  process.env.PATH = [current, ...additions].filter(Boolean).join(':');
}

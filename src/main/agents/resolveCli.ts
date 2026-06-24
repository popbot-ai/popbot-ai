/**
 * Cross-platform "where is this CLI on PATH" resolver, shared by the
 * claude/codex startup probes.
 *
 *  - Windows: `where.exe <name>` lists every match on PATH. We prefer a
 *    real `.exe` (the agent SDKs can spawn it directly) over a `.cmd` /
 *    `.ps1` npm shim, which needs a shell to launch.
 *  - macOS / Linux: ask the user's login shell (`$SHELL -ilc 'command
 *    -v'`). Going through the login shell — rather than `which` against
 *    our own `process.env.PATH` — picks up PATH entries set in the
 *    user's rc/profile that a packaged GUI launch (with launchd's
 *    minimal PATH) would otherwise miss. `command -v` is POSIX and
 *    works under bash, zsh, and fish.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function resolveCliPath(name: string): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileP('where.exe', [name], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const matches = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (matches.length === 0) throw new Error(`${name} not found on PATH`);
    // Prefer a native executable over a .cmd/.ps1 shim so the agent SDK
    // can spawn it without going through cmd.exe.
    const exe = matches.find((m) => m.toLowerCase().endsWith('.exe'));
    return exe ?? matches[0];
  }
  const shell = process.env.SHELL || '/bin/zsh';
  const { stdout } = await execFileP(shell, ['-ilc', `command -v ${name}`], {
    timeout: 5000,
    encoding: 'utf8',
  });
  const binaryPath = stdout.trim().split('\n').pop()?.trim() || '';
  if (!binaryPath) throw new Error(`${name} not found on user shell PATH`);
  return binaryPath;
}

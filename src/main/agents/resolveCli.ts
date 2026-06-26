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
 *
 * In BOTH cases we exclude the project's own `node_modules/.bin`. npm
 * prepends it to PATH when running scripts, and some agent SDKs ship a
 * runnable CLI shim there (e.g. `@openai/codex-sdk` → `node_modules/.bin/
 * codex`). Without this filter the probe would treat that dev-dependency
 * as a user-installed agent and report it "online" even when the user
 * hasn't installed the CLI — falsely satisfying the readiness gate.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter } from 'node:path';

const execFileP = promisify(execFile);

/** True for a PATH entry / resolved path inside any `node_modules/.bin`.
 *  Exported for unit tests — it's the guard that stops the agent probe
 *  false-positiving on an SDK-bundled CLI shim. */
export function isNodeModulesBin(p: string): boolean {
  // Anchored to path-segment boundaries so a directory merely *named*
  // like it (e.g. `/work/mynode_modules/.bin`) isn't caught — only a real
  // `…/node_modules/.bin[/…]` segment matches.
  return /(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)/i.test(p);
}

/** process.env.PATH with the project's node_modules/.bin entries removed. */
function userPath(): string {
  return (process.env.PATH || '')
    .split(delimiter)
    .filter((p) => p && !isNodeModulesBin(p))
    .join(delimiter);
}

export async function resolveCliPath(name: string): Promise<string> {
  const env = { ...process.env, PATH: userPath() };
  if (process.platform === 'win32') {
    const { stdout } = await execFileP('where.exe', [name], {
      timeout: 5000,
      encoding: 'utf8',
      env,
    });
    const matches = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((m) => !isNodeModulesBin(m));
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
    env,
  });
  const binaryPath = stdout.trim().split('\n').pop()?.trim() || '';
  if (!binaryPath || isNodeModulesBin(binaryPath)) {
    throw new Error(`${name} not found on user shell PATH`);
  }
  return binaryPath;
}

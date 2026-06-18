/**
 * Startup probe — run `claude --version` once at app boot to verify
 * the Claude CLI is on PATH (PATH was already widened by env.ts's
 * fixShellPath). If the probe fails, fire an URGENT notification so
 * the user knows immediately why their chats won't run, instead of
 * silently sitting at status 'run' forever.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { notify } from '../notifications/dispatcher';
import { dlog } from '../diagLog';

const execFileP = promisify(execFile);

export interface ClaudeProbeResult {
  ok: boolean;
  version?: string;
  /** Absolute path to the discovered binary. Cached and handed to the
   *  Claude SDK via `pathToClaudeCodeExecutable` so packaged builds
   *  use the user's installed `claude` instead of a bundled native
   *  binary the SDK can't locate post-Vite-bundling. */
  binaryPath?: string;
  pathUsed?: string;
  error?: string;
}

let cachedBinaryPath: string | null = null;

export function getClaudeBinaryPath(): string | null {
  return cachedBinaryPath;
}

export async function probeClaude(): Promise<ClaudeProbeResult> {
  try {
    // Resolve the absolute path via the user's actual login shell —
    // not via `which` against process.env.PATH, because (a) fixShellPath's
    // patched PATH may have missed paths from non-interactive shells and
    // (b) users on non-bash/zsh shells have their own resolution rules.
    // `command -v` is POSIX and works under bash, zsh, and fish.
    const shell = process.env.SHELL || '/bin/zsh';
    const { stdout: shellOut } = await execFileP(shell, ['-ilc', 'command -v claude'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const binaryPath = shellOut.trim().split('\n').pop()?.trim() || '';
    if (!binaryPath) throw new Error('claude not found on user shell PATH');
    // Verify the resolved binary actually runs.
    const { stdout: verOut } = await execFileP(binaryPath, ['--version'], {
      timeout: 5000,
      env: process.env,
    });
    cachedBinaryPath = binaryPath;
    return { ok: true, version: verOut.trim(), binaryPath, pathUsed: process.env.PATH };
  } catch (err) {
    cachedBinaryPath = null;
    return {
      ok: false,
      pathUsed: process.env.PATH,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run the probe and surface a loud notification if claude isn't on PATH.
 * Called once at app ready. Notifications use dedupKey so repeated app
 * starts within an hour don't double-notify.
 */
export async function probeClaudeAndNotify(): Promise<void> {
  const r = await probeClaude();
  dlog('claude.probe', { ...r });
  if (r.ok) return;
  notify({
    kind: 'system',
    urgency: 'high',
    source: 'PopBot',
    title: 'Claude CLI not found',
    summary:
      'PopBot can\'t spawn agents — the `claude` binary isn\'t on PATH. ' +
      'Install Claude Code (or fix your shell PATH), then restart PopBot.',
    actor: { name: 'PopBot', avatar: 'PB', color: '#7e9cf0' },
    actions: [{
      kind: 'external',
      label: 'Install Claude Code',
      url: 'https://docs.claude.com/en/docs/claude-code',
      primary: true,
    }],
    dedupKey: 'claude-missing',
  });
}

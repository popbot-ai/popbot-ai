/**
 * A host keeps itself current with the PopBot repository it was built
 * from: when the branch it runs (main, usually) moves on GitHub, it pulls,
 * rebuilds itself and restarts — so a push reaches every host without
 * anyone at the machine.
 *
 * Every few minutes it compares its checkout with the remote branch. A
 * newer commit is taken only when the checkout is clean (no edits to
 * tracked files), on that branch, and a fast-forward away. Then:
 * `git merge --ff-only`, `npm ci` if package.json or the lockfile changed,
 * `npm run build:host`, and a restart — once no chat or bot is mid-turn
 * (or after RESTART_WAIT_MS at the latest). A failed step keeps the old
 * build running and that commit is not tried again.
 *
 * Off when the host does not run from a git checkout (the container
 * image), or with `"autoUpdate": { "enabled": false }` in its config.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dlog } from '../main/diagLog';

/** Longest a pending restart waits for running turns to end. */
const RESTART_WAIT_MS = 30 * 60_000;
const IDLE_CHECK_MS = 30_000;

export interface AutoUpdateConfig {
  enabled: boolean;
  /** The branch it follows. */
  branch: string;
  intervalMinutes: number;
}

export const DEFAULT_AUTO_UPDATE: AutoUpdateConfig = { enabled: true, branch: 'main', intervalMinutes: 5 };

export type UpdateCheck =
  | { action: 'none' }
  | { action: 'skip'; reason: string }
  | { action: 'update'; from: string; to: string; depsChanged: boolean };

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // npm is a .cmd on Windows, which Node only runs through a shell.
    const shell = process.platform === 'win32' && cmd === 'npm';
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${(stderr || '').toString().trim().split('\n').slice(-4).join(' ') || err.message}`));
      else resolvePromise(stdout.toString().trim());
    });
  });
}

const git = (cwd: string, ...args: string[]): Promise<string> => run('git', ['-c', 'safe.directory=*', ...args], cwd);

/** The repository this host was built from: dist-host/ sits at its root. */
export function hostRepoRoot(bundlePath: string): string | null {
  const root = resolve(dirname(bundlePath), '..');
  return existsSync(join(root, '.git')) && existsSync(join(root, 'package.json')) ? root : null;
}

/** Is there a newer commit to take, and may it be taken? */
export async function checkForUpdate(repo: string, branch: string): Promise<UpdateCheck> {
  const current = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== branch) return { action: 'skip', reason: `the checkout is on "${current}", not "${branch}"` };
  const dirty = await git(repo, 'status', '--porcelain', '--untracked-files=no');
  if (dirty) return { action: 'skip', reason: 'the checkout has uncommitted changes' };
  await git(repo, 'fetch', '--quiet', 'origin', branch);
  const from = await git(repo, 'rev-parse', 'HEAD');
  const to = await git(repo, 'rev-parse', `origin/${branch}`);
  if (from === to) return { action: 'none' };
  const fastForward = await git(repo, 'merge-base', '--is-ancestor', from, to).then(() => true, () => false);
  if (!fastForward) return { action: 'skip', reason: `the checkout has diverged from origin/${branch}` };
  const changed = await git(repo, 'diff', '--name-only', from, to, '--', 'package.json', 'package-lock.json');
  return { action: 'update', from, to, depsChanged: changed.length > 0 };
}

/** Take the update: fast-forward, dependencies if they changed, rebuild. */
export async function applyUpdate(repo: string, branch: string, check: Extract<UpdateCheck, { action: 'update' }>): Promise<void> {
  await git(repo, 'merge', '--ff-only', `origin/${branch}`);
  if (check.depsChanged) await run('npm', ['ci', '--no-audit', '--no-fund'], repo, 15 * 60_000);
  await run('npm', ['run', 'build:host'], repo, 10 * 60_000);
}

export interface SelfUpdateHooks {
  /** No chat or bot is in the middle of a turn. */
  idle(): boolean;
  /** Stop serving and end every session, before the new build starts. */
  shutdown(): Promise<void>;
}

/** Start following the branch. Returns a stop function. */
export function startSelfUpdate(config: AutoUpdateConfig, bundlePath: string, hooks: SelfUpdateHooks): () => void {
  const repo = hostRepoRoot(bundlePath);
  if (!config.enabled) {
    dlog('host.update.off', { why: 'disabled in config' });
    return () => undefined;
  }
  if (!repo) {
    dlog('host.update.off', { why: 'not running from a git checkout', bundlePath });
    return () => undefined;
  }
  let stopped = false;
  let busy = false;
  let lastSkip = '';
  const failed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      const check = await checkForUpdate(repo, config.branch);
      if (check.action === 'skip') {
        if (check.reason !== lastSkip) dlog('host.update.skip', { reason: check.reason });
        lastSkip = check.reason;
      } else if (check.action === 'update' && !failed.has(check.to)) {
        dlog('host.update.begin', { from: check.from.slice(0, 7), to: check.to.slice(0, 7), depsChanged: check.depsChanged });
        try {
          await applyUpdate(repo, config.branch, check);
        } catch (err) {
          failed.add(check.to);
          dlog('host.update.failed', { to: check.to.slice(0, 7), error: err instanceof Error ? err.message : String(err) });
          return;
        }
        dlog('host.update.built', { to: check.to.slice(0, 7) });
        await restartWhenIdle(bundlePath, hooks);
        return;
      }
    } catch (err) {
      dlog('host.update.check-failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      busy = false;
    }
    schedule(config.intervalMinutes * 60_000);
  };

  schedule(60_000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Wait for running turns to end (up to RESTART_WAIT_MS), then hand over
 *  to the new build: stop serving, end the sessions, start the new
 *  process (it waits for the port), and exit. */
async function restartWhenIdle(bundlePath: string, hooks: SelfUpdateHooks): Promise<void> {
  const deadline = Date.now() + RESTART_WAIT_MS;
  while (!hooks.idle() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, IDLE_CHECK_MS));
  }
  dlog('host.update.restart', { waitedForIdle: hooks.idle() ? 'idle' : 'gave up waiting' });
  await hooks.shutdown();
  const logs = process.env.POPBOT_LOG_DIR?.trim() || join(homedir(), '.popbot-host', 'logs');
  mkdirSync(logs, { recursive: true });
  const out = openSync(join(logs, 'host-output.log'), 'a');
  const child = spawn(process.execPath, [bundlePath, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  process.exit(0);
}

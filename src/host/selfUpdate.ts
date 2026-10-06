/**
 * A host runs the PopBot version its desktop runs. The desktop compares its
 * own commit with each host's (HostInfo.commit) and, when they differ, asks
 * the host to move to its commit (POST /v1/update). The host then:
 *
 *   - fetches the commit (git is assumed installed; the commit has to be
 *     on GitHub),
 *   - moves its checkout to it — a fast-forward of its branch when the
 *     commit is ahead on it, else a checkout of the commit itself,
 *   - runs `npm ci` if package.json or the lockfile differ,
 *   - runs `npm run build:host`,
 *   - and restarts into the new build once no chat or bot is mid-turn (or
 *     after RESTART_WAIT_MS at the latest).
 *
 * A checkout with uncommitted changes to tracked files is left alone, and
 * a failed step keeps the old build running. Off when the host does not run
 * from a git checkout (the container image), or with
 * `"autoUpdate": { "enabled": false }` in its config.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { HostUpdateAnswer, HostUpdateState } from '@shared/hostProtocol';
import { dlog } from '../main/diagLog';

/** Longest a pending restart waits for running turns to end. */
const RESTART_WAIT_MS = 30 * 60_000;
const IDLE_CHECK_MS = 30_000;

export interface AutoUpdateConfig {
  /** Accept a desktop's request to move to its version. */
  enabled: boolean;
}

export const DEFAULT_AUTO_UPDATE: AutoUpdateConfig = { enabled: true };

export type UpdatePlan =
  | { action: 'none' }
  | { action: 'skip'; reason: string }
  | { action: 'update'; from: string; to: string; fastForward: boolean; depsChanged: boolean };

export type UpdateState = HostUpdateState;

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

/** What moving the checkout to `target` takes, and whether it may. */
export async function planUpdate(repo: string, target: string): Promise<UpdatePlan> {
  if (!/^[0-9a-f]{7,40}$/i.test(target)) return { action: 'skip', reason: `"${target}" is not a commit` };
  const from = await git(repo, 'rev-parse', 'HEAD');
  if (from.startsWith(target.toLowerCase())) return { action: 'none' };
  const dirty = await git(repo, 'status', '--porcelain', '--untracked-files=no');
  if (dirty) return { action: 'skip', reason: 'the checkout has uncommitted changes' };
  const have = (): Promise<boolean> => git(repo, 'cat-file', '-e', `${target}^{commit}`).then(() => true, () => false);
  if (!(await have())) await git(repo, 'fetch', '--quiet', 'origin').catch(() => undefined);
  if (!(await have())) await git(repo, 'fetch', '--quiet', 'origin', target).catch(() => undefined);
  if (!(await have())) return { action: 'skip', reason: `commit ${target.slice(0, 7)} is not on GitHub (not pushed yet?)` };
  const to = await git(repo, 'rev-parse', `${target}^{commit}`);
  if (to === from) return { action: 'none' };
  const onBranch = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')) !== 'HEAD';
  const ahead = await git(repo, 'merge-base', '--is-ancestor', from, to).then(() => true, () => false);
  const changed = await git(repo, 'diff', '--name-only', from, to, '--', 'package.json', 'package-lock.json');
  return { action: 'update', from, to, fastForward: onBranch && ahead, depsChanged: changed.length > 0 };
}

/** Move the checkout, update dependencies if they changed, rebuild. */
export async function applyUpdate(repo: string, plan: Extract<UpdatePlan, { action: 'update' }>): Promise<void> {
  if (plan.fastForward) await git(repo, 'merge', '--ff-only', plan.to);
  else await git(repo, 'checkout', '--quiet', '--detach', plan.to);
  if (plan.depsChanged) await run('npm', ['ci', '--no-audit', '--no-fund'], repo, 15 * 60_000);
  await run('npm', ['run', 'build:host'], repo, 10 * 60_000);
}

export interface SelfUpdateHooks {
  /** No chat or bot is in the middle of a turn. */
  idle(): boolean;
  /** Stop serving and end every session, before the new build starts. */
  shutdown(): Promise<void>;
}

/** Takes a desktop's requests to move to its version. */
export class HostUpdater {
  private readonly repo: string | null;
  private state: UpdateState;

  constructor(private readonly config: AutoUpdateConfig, private readonly bundlePath: string, private readonly hooks: SelfUpdateHooks) {
    this.repo = hostRepoRoot(bundlePath);
    this.state = { phase: config.enabled && this.repo ? 'idle' : 'off' };
  }

  status(): UpdateState {
    return { ...this.state };
  }

  /** Move to `target`. Answers at once; the work goes on behind. */
  async request(target: string): Promise<HostUpdateAnswer> {
    if (!this.config.enabled) return { result: 'refused', reason: 'updates are off in this host\'s config', state: this.status() };
    if (!this.repo) return { result: 'refused', reason: 'this host does not run from a git checkout', state: this.status() };
    if (this.state.phase === 'updating' || this.state.phase === 'waiting-for-idle') return { result: 'busy', state: this.status() };
    let plan: UpdatePlan;
    try {
      plan = await planUpdate(this.repo, target);
    } catch (err) {
      return { result: 'refused', reason: err instanceof Error ? err.message : String(err), state: this.status() };
    }
    if (plan.action === 'none') return { result: 'current', state: this.status() };
    if (plan.action === 'skip') {
      dlog('host.update.refused', { to: target, reason: plan.reason });
      return { result: 'refused', reason: plan.reason, state: this.status() };
    }
    this.state = { phase: 'updating', to: plan.to };
    dlog('host.update.begin', { from: plan.from.slice(0, 7), to: plan.to.slice(0, 7), fastForward: plan.fastForward, depsChanged: plan.depsChanged });
    void this.run(plan);
    return { result: 'updating', state: this.status() };
  }

  private async run(plan: Extract<UpdatePlan, { action: 'update' }>): Promise<void> {
    try {
      await applyUpdate(this.repo!, plan);
    } catch (err) {
      this.state = { phase: 'failed', to: plan.to, error: err instanceof Error ? err.message : String(err) };
      dlog('host.update.failed', { to: plan.to.slice(0, 7), error: this.state.error });
      return;
    }
    dlog('host.update.built', { to: plan.to.slice(0, 7) });
    this.state = { phase: 'waiting-for-idle', to: plan.to };
    await restartWhenIdle(this.bundlePath, this.hooks);
  }
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

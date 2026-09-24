/**
 * The git and GitHub plumbing a cloud chat needs on the local side: the
 * repo's GitHub URL, the branch to mount, pushing it before the sandbox
 * clones, pulling the sandbox's commits back, and a GitHub token for
 * the clone. All shell-outs; nothing here touches the DB.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { githubRepoUrl } from './managedAgents';

const execFileP = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['-c', 'safe.directory=*', ...args], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')}: ${e.stderr?.trim() || e.message}`);
  }
}

/** The checkout's `origin` as a GitHub HTTPS URL, or null. */
export async function githubOriginUrl(cwd: string): Promise<string | null> {
  const remote = await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '');
  return remote ? githubRepoUrl(remote) : null;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const out = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
  const name = out.trim();
  return name && name !== 'HEAD' ? name : null;
}

export async function branchOnOrigin(cwd: string, branch: string): Promise<boolean> {
  const out = await git(cwd, ['ls-remote', '--heads', 'origin', branch]).catch(() => '');
  return out.trim().length > 0;
}

/** `git push -u origin <branch>` — the sandbox clones what is on origin. */
export async function pushBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ['push', '-u', 'origin', branch]);
}

/**
 * Bring the sandbox's commits into the local checkout. Fast-forward
 * only: the cloud pushes on top of what was pushed from here, so a
 * divergence means local commits were made meanwhile, and merging
 * those is the user's call.
 */
export async function pullBranch(cwd: string, branch: string): Promise<string> {
  const head = await currentBranch(cwd);
  if (head !== branch) {
    throw new Error(`the checkout is on ${head ?? 'a detached HEAD'}, not ${branch}; check out ${branch} first`);
  }
  const before = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  await git(cwd, ['pull', '--ff-only', 'origin', branch]);
  const after = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (before === after) return 'Already up to date.';
  const log = await git(cwd, ['log', '--oneline', `${before}..${after}`]).catch(() => '');
  const n = log.split('\n').filter(Boolean).length;
  return `Pulled ${n} commit${n === 1 ? '' : 's'}.`;
}

/** The token `gh` is signed in with, or null. */
export async function ghAuthToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('gh', ['auth', 'token'], {
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      timeout: 10_000,
    });
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

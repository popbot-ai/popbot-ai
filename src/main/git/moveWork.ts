/**
 * Moving a chat's work between machines — this computer and PopBot hosts —
 * without going through GitHub. The machine the chat leaves packs its
 * branch: the commits no remote has (a git bundle) and everything not
 * committed, untracked files included (a binary patch). The machine it
 * goes to unpacks them into its own checkout of the same repository, on
 * the same branch, at the same commit, with the same uncommitted changes.
 *
 * Nothing here touches the machine's index or working tree it packs from:
 * the uncommitted changes are read through a throwaway index.
 *
 * Shared by the desktop and popbot-host (which bundles this file).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackedWork } from '@shared/hostProtocol';

export type { PackedWork };

/** Past this, the move is refused rather than shipped: the host
 *  protocol carries it inline. */
const MAX_PACK_BYTES = 40 * 1024 * 1024;

export class MoveWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveWorkError';
  }
}

function run(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: Buffer } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'safe.directory=*', ...args],
      { cwd, env: opts.env ?? process.env, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const errText = stderr ? stderr.toString().trim() : '';
        if (err) reject(new MoveWorkError(`git ${args[0]}: ${errText || err.message}`));
        else resolve({ stdout: stdout as Buffer, stderr: errText });
      },
    );
    if (opts.input) child.stdin?.end(opts.input);
  });
}

async function text(cwd: string, args: string[]): Promise<string> {
  return (await run(cwd, args)).stdout.toString().trim();
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'popbot-move-'));
}

/**
 * Pack the chat's work. `cwd` is its checkout when it has one (its
 * uncommitted changes come too), else the repository (commits only).
 */
export async function packWork(cwd: string, branch: string, opts: { withChanges: boolean }): Promise<PackedWork> {
  const ref = `refs/heads/${branch}`;
  let head: string;
  try {
    head = await text(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    throw new MoveWorkError(`there is no branch "${branch}" to move`);
  }
  const dir = scratchDir();
  try {
    // Commits no remote has. An empty bundle means every commit is on a
    // remote already — the other side fetches them.
    let bundleBase64: string | null = null;
    const bundlePath = join(dir, 'work.bundle');
    try {
      await run(cwd, ['bundle', 'create', bundlePath, ref, '--not', '--remotes']);
      bundleBase64 = readFileSync(bundlePath).toString('base64');
    } catch (err) {
      if (!/empty bundle/i.test(err instanceof Error ? err.message : String(err))) throw err;
      // All on remotes; check it really is, or the other side cannot get it.
      const onRemote = await text(cwd, ['branch', '-r', '--contains', head]).catch(() => '');
      if (!onRemote) throw new MoveWorkError(`the commits on "${branch}" could not be packed`);
    }

    // Uncommitted changes, read through a throwaway index so the real one
    // (and anything staged in it) is left exactly as it is.
    let patchBase64: string | null = null;
    if (opts.withChanges) {
      const current = await text(cwd, ['rev-parse', 'HEAD']);
      if (current !== head) {
        throw new MoveWorkError(`the checkout is not on "${branch}" (HEAD is ${current.slice(0, 7)})`);
      }
      const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
      await run(cwd, ['read-tree', 'HEAD'], { env });
      await run(cwd, ['add', '-A'], { env });
      const patch = (await run(cwd, ['diff', '--cached', '--binary', 'HEAD'], { env })).stdout;
      if (patch.length > 0) patchBase64 = patch.toString('base64');
    }

    const size = (bundleBase64?.length ?? 0) + (patchBase64?.length ?? 0);
    if (size > (MAX_PACK_BYTES * 4) / 3) {
      throw new MoveWorkError(
        `the work on "${branch}" is ${Math.round((size * 3) / 4 / 1024 / 1024)} MB to move, over the ${MAX_PACK_BYTES / 1024 / 1024} MB limit — commit and push it, or remove large untracked files, first`,
      );
    }
    return { branch, head, bundleBase64, patchBase64 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Put the branch into `repoPath` at the packed commit: from the bundle,
 * or fetched from the remote when the commits are all there. A branch of
 * that name already here is moved to it — after being kept under
 * `refs/popbot/moved/` if it held commits the incoming one does not.
 * Refused while that branch is checked out in some worktree here.
 */
export async function unpackBranch(repoPath: string, work: PackedWork): Promise<void> {
  const ref = `refs/heads/${work.branch}`;
  const worktrees = await text(repoPath, ['worktree', 'list', '--porcelain']).catch(() => '');
  const holder = worktrees
    .split('\n\n')
    .find((block) => block.split('\n').includes(`branch ${ref}`));
  if (holder) {
    const path = holder.split('\n')[0]?.replace(/^worktree /, '') ?? '?';
    throw new MoveWorkError(`"${work.branch}" is checked out in ${path} on this machine; free it first`);
  }
  // The base the work builds on, and the tip itself when it is pushed.
  await run(repoPath, ['fetch', '--quiet', 'origin']).catch(() => undefined);

  if (work.bundleBase64) {
    const dir = scratchDir();
    try {
      const bundlePath = join(dir, 'work.bundle');
      writeFileSync(bundlePath, Buffer.from(work.bundleBase64, 'base64'));
      try {
        await run(repoPath, ['bundle', 'verify', bundlePath]);
      } catch (err) {
        throw new MoveWorkError(
          `this machine's checkout is missing commits the work builds on (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      await run(repoPath, ['fetch', '--quiet', bundlePath, ref]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  try {
    await run(repoPath, ['cat-file', '-e', `${work.head}^{commit}`]);
  } catch {
    throw new MoveWorkError(`this machine cannot get commit ${work.head.slice(0, 7)} of "${work.branch}" (is it pushed?)`);
  }

  const existing = await text(repoPath, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '');
  if (existing && existing !== work.head) {
    const contained = await run(repoPath, ['merge-base', '--is-ancestor', existing, work.head]).then(() => true, () => false);
    if (!contained) {
      const keep = `refs/popbot/moved/${work.branch}/${Date.now()}`;
      await run(repoPath, ['update-ref', keep, existing]);
    }
  }
  await run(repoPath, ['update-ref', ref, work.head]);
}

/** Lay the packed uncommitted changes onto a checkout of the branch. */
export async function applyWorkChanges(worktreePath: string, work: PackedWork): Promise<void> {
  if (!work.patchBase64) return;
  const patch = Buffer.from(work.patchBase64, 'base64');
  try {
    await run(worktreePath, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: patch });
  } catch (err) {
    throw new MoveWorkError(`the uncommitted changes did not apply (${err instanceof Error ? err.message : String(err)})`);
  }
}

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyWorkChanges, packWork, unpackBranch } from './moveWork';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/** A remote, and two clones of it: "here" and "there". */
function world(): { here: string; there: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), 'popbot-movework-'));
  dirs.push(root);
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', remote, seed);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'base');
  git(seed, 'push', 'origin', 'HEAD:main');
  const here = join(root, 'here');
  const there = join(root, 'there');
  git(root, 'clone', remote, here);
  git(root, 'clone', remote, there);
  return { here, there, remote };
}

describe('moving a chat’s work between machines', () => {
  it('carries unpushed commits and uncommitted changes, untracked files included', async () => {
    const { here, there } = world();
    git(here, 'switch', '-c', 'feat/x');
    writeFileSync(join(here, 'a.txt'), 'one\ntwo\n');
    git(here, 'commit', '-am', 'local only');
    writeFileSync(join(here, 'a.txt'), 'one\ntwo\nthree (not committed)\n');
    writeFileSync(join(here, 'new.bin'), Buffer.from([0, 1, 2, 255]));
    git(here, 'add', 'a.txt'); // something staged, to prove the real index is left alone
    const stagedBefore = git(here, 'diff', '--cached', '--name-only');

    const work = await packWork(here, 'feat/x', { withChanges: true });
    expect(work.bundleBase64).not.toBeNull();
    expect(work.patchBase64).not.toBeNull();
    expect(git(here, 'diff', '--cached', '--name-only')).toBe(stagedBefore);
    expect(git(here, 'status', '--porcelain')).toContain('?? new.bin');

    await unpackBranch(there, work);
    expect(git(there, 'rev-parse', 'refs/heads/feat/x')).toBe(work.head);
    const wt = join(there, '..', 'there-wt');
    git(there, 'worktree', 'add', wt, 'feat/x');
    await applyWorkChanges(wt, work);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\ntwo\nthree (not committed)\n');
    expect([...readFileSync(join(wt, 'new.bin'))]).toEqual([0, 1, 2, 255]);
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('local only');
  });

  it('sends no bundle when every commit is pushed — the other side fetches it', async () => {
    const { here, there } = world();
    git(here, 'switch', '-c', 'feat/pushed');
    writeFileSync(join(here, 'b.txt'), 'b\n');
    git(here, 'add', '.');
    git(here, 'commit', '-m', 'pushed');
    git(here, 'push', 'origin', 'feat/pushed');
    const work = await packWork(here, 'feat/pushed', { withChanges: true });
    expect(work.bundleBase64).toBeNull();
    expect(work.patchBase64).toBeNull();
    await unpackBranch(there, work);
    expect(git(there, 'rev-parse', 'refs/heads/feat/pushed')).toBe(work.head);
  });

  it('keeps a diverged branch of the same name instead of losing it', async () => {
    const { here, there } = world();
    git(here, 'switch', '-c', 'feat/y');
    writeFileSync(join(here, 'c.txt'), 'here\n');
    git(here, 'add', '.');
    git(here, 'commit', '-m', 'here');
    git(there, 'switch', '-c', 'feat/y');
    writeFileSync(join(there, 'c.txt'), 'there\n');
    git(there, 'add', '.');
    git(there, 'commit', '-m', 'there');
    const theirs = git(there, 'rev-parse', 'HEAD');
    git(there, 'switch', 'main');
    const work = await packWork(here, 'feat/y', { withChanges: false });
    await unpackBranch(there, work);
    expect(git(there, 'rev-parse', 'refs/heads/feat/y')).toBe(work.head);
    expect(git(there, 'for-each-ref', '--format=%(objectname)', 'refs/popbot/moved/')).toBe(theirs);
  });

  it('refuses while the branch is checked out on the machine it goes to', async () => {
    const { here, there } = world();
    git(here, 'switch', '-c', 'feat/z');
    writeFileSync(join(here, 'd.txt'), 'd\n');
    git(here, 'add', '.');
    git(here, 'commit', '-m', 'z');
    git(there, 'switch', '-c', 'feat/z');
    const work = await packWork(here, 'feat/z', { withChanges: false });
    await expect(unpackBranch(there, work)).rejects.toThrow(/checked out/);
    expect(existsSync(there)).toBe(true);
  });
});

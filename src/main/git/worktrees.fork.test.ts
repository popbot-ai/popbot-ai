import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WIP_COMMIT_MSG, forkBranchInto } from './worktrees';

// Trailing whitespace only: porcelain status lines START with a
// significant space (' M' = unstaged, 'M ' = staged). Line endings are
// pinned to LF: a Windows git with core.autocrlf=true would check the
// files out as CRLF and the byte-for-byte assertions below would fail.
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).replace(/\s+$/, '');

const AUTHOR = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const commitAll = (cwd: string, msg: string): void => {
  git(cwd, 'add', '-A');
  git(cwd, ...AUTHOR, 'commit', '-q', '-m', msg);
};

/**
 * Real git, in a temp dir: a root repo, an "original" slot clone with a
 * chat branch carrying a local commit plus uncommitted and untracked
 * work, and an empty "fork" slot clone on its parking branch.
 */
describe('forkBranchInto', () => {
  let dir: string;
  let root: string;
  let orig: string;
  let fork: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'popbot-fork-'));
    root = join(dir, 'root');
    orig = join(dir, 'slot-1');
    fork = join(dir, 'slot-2');
    git(dir, 'init', '-q', '-b', 'main', root);
    git(root, 'config', 'user.name', 't');
    git(root, 'config', 'user.email', 't@t');
    writeFileSync(join(root, 'README.md'), 'base\n');
    commitAll(root, 'base');
    git(dir, 'clone', '-q', root, orig);
    git(dir, 'clone', '-q', root, fork);
    // The code under test runs its own git in these clones; the repo
    // config keeps its checkouts on LF too.
    for (const wt of [root, orig, fork]) {
      git(wt, 'config', 'user.name', 't');
      git(wt, 'config', 'user.email', 't@t');
      git(wt, 'config', 'core.autocrlf', 'false');
    }
    // The original chat: its branch, one local commit, then dirty work.
    git(orig, 'checkout', '-q', '-b', 'you/feature', 'main');
    writeFileSync(join(orig, 'committed.txt'), 'in a local commit\n');
    commitAll(orig, 'feature work');
    writeFileSync(join(orig, 'README.md'), 'edited but not committed\n');
    writeFileSync(join(orig, 'untracked.txt'), 'never added\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lands the fork on the original’s tip with its uncommitted work carried over', async () => {
    await forkBranchInto({
      repoPath: root,
      sourceWorktreePath: orig,
      sourceBranch: 'you/feature',
      worktreePath: fork,
      branch: 'you/feature-fork',
    });

    expect(git(fork, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('you/feature-fork');
    // The local commit came across…
    expect(git(fork, 'log', '-1', '--pretty=%s')).toBe('feature work');
    expect(existsSync(join(fork, 'committed.txt'))).toBe(true);
    // …and the dirty work is dirty here too — edits AND untracked files.
    expect(readFileSync(join(fork, 'README.md'), 'utf8')).toBe('edited but not committed\n');
    expect(readFileSync(join(fork, 'untracked.txt'), 'utf8')).toBe('never added\n');
    expect(git(fork, 'status', '--porcelain').split('\n').sort()).toEqual([' M README.md', '?? untracked.txt']);
  });

  it('leaves the original exactly as it was: same tip, same dirty files, no WIP commit', async () => {
    const tipBefore = git(orig, 'rev-parse', 'HEAD');
    await forkBranchInto({
      repoPath: root,
      sourceWorktreePath: orig,
      sourceBranch: 'you/feature',
      worktreePath: fork,
      branch: 'you/feature-fork',
    });
    expect(git(orig, 'rev-parse', 'HEAD')).toBe(tipBefore);
    expect(git(orig, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('you/feature');
    expect(git(orig, 'log', '-1', '--pretty=%s')).not.toBe(WIP_COMMIT_MSG);
    expect(git(orig, 'status', '--porcelain').split('\n').sort()).toEqual([' M README.md', '?? untracked.txt']);
  });

  it('forks from the root repo when the original has no worktree any more', async () => {
    // What a close does: the branch (with a WIP commit) lands in the root.
    commitAll(orig, WIP_COMMIT_MSG);
    git(orig, 'push', '-q', root, 'you/feature:you/feature');
    rmSync(orig, { recursive: true, force: true });

    await forkBranchInto({
      repoPath: root,
      sourceWorktreePath: orig,
      sourceBranch: 'you/feature',
      worktreePath: fork,
      branch: 'you/feature-fork',
    });
    expect(git(fork, 'log', '-1', '--pretty=%s')).toBe('feature work');
    expect(readFileSync(join(fork, 'README.md'), 'utf8')).toBe('edited but not committed\n');
    expect(git(fork, 'status', '--porcelain')).toContain('README.md');
  });

  it('fails clearly when the branch exists nowhere', async () => {
    await expect(forkBranchInto({
      repoPath: root,
      sourceWorktreePath: null,
      sourceBranch: 'nope/never',
      worktreePath: fork,
      branch: 'nope/never-fork',
    })).rejects.toMatchObject({ code: 'branch-missing' });
  });
});

/**
 * Working-tree git operations for the per-chat git sidebar:
 * status, diff, commit, revert, plus history scoped to the chat's branch.
 *
 * All entry points take an absolute worktree path. The IPC layer is
 * responsible for resolving chatId → worktreePath before calling in.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  GitCommitSummary,
  GitFileChange,
  GitFileStatus,
  GitPrInfo,
  GitScope,
  GitBaseBranches,
} from '@shared/git';

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr?.trim() || e.message}`);
  }
}

/** Slug a name into a git-ref-safe branch username segment. */
function slugUsername(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Derive a branch-name username without asking the user, in priority:
 *   1. The GitHub login (`gh api user`) — branches/PRs target GitHub.
 *   2. The local-part of `git config user.email`.
 *   3. `git config user.name`.
 * Returns '' if none resolve (caller falls back to a default).
 */
export async function deriveGitUsername(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('gh', ['api', 'user', '--jq', '.login'], { timeout: 4000 });
    const login = slugUsername(stdout);
    if (login) return login;
  } catch { /* gh missing / not authed */ }
  try {
    const { stdout } = await execFileP('git', ['config', 'user.email'], { cwd, timeout: 3000 });
    const local = slugUsername(stdout.trim().split('@')[0] ?? '');
    if (local) return local;
  } catch { /* no email configured */ }
  try {
    const { stdout } = await execFileP('git', ['config', 'user.name'], { cwd, timeout: 3000 });
    const name = slugUsername(stdout);
    if (name) return name;
  } catch { /* no name configured */ }
  return '';
}

function classifyStatus(x: string, y: string): GitFileStatus {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict';
  if (x === 'R') return 'renamed';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

function parseStatusZ(stdout: string): {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
} {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileChange[] = [];
  const records = stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    if (r.startsWith('## ')) {
      const body = r.slice(3);
      // `branch...remote [ahead N, behind N]` — remote and tracking are
      // optional. Detached HEAD prints `HEAD (no branch)`.
      const m = /^([^\s.]+)(?:\.\.\.\S+)?(?:\s+\[(.*)\])?$/.exec(body);
      if (m) {
        branch = m[1] === 'HEAD' ? null : m[1];
        const tag = m[2];
        if (tag) {
          ahead = Number(/ahead (\d+)/.exec(tag)?.[1] ?? 0);
          behind = Number(/behind (\d+)/.exec(tag)?.[1] ?? 0);
        }
      }
      continue;
    }
    const x = r[0];
    const y = r[1];
    const path = r.slice(3);
    let oldPath: string | undefined;
    if (x === 'R' || x === 'C') {
      oldPath = records[i + 1];
      i += 1;
    }
    files.push({ path, status: classifyStatus(x, y), oldPath });
  }
  return { branch, ahead, behind, files };
}

function parseLogZ(stdout: string): GitCommitSummary[] {
  if (!stdout) return [];
  // Records separated by NUL so the subject can contain newlines.
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      const [sha, shortSha, author, ts, ...rest] = rec.split('\x1f');
      return {
        sha,
        shortSha,
        author,
        date: Number(ts) * 1000,
        subject: rest.join('\x1f'),
      };
    });
}

export async function listStatus(wt: string): Promise<{
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  recentCommits: GitCommitSummary[];
}> {
  const [statusOut, logOut] = await Promise.all([
    git(wt, ['status', '--porcelain=v1', '--branch', '-z']),
    git(wt, [
      'log',
      '-n', '20',
      // %x1f = unit separator between fields, %x00 between records.
      '--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s%x00',
      'HEAD',
    ]).catch(() => ({ stdout: '', stderr: '' })),
  ]);
  const parsed = parseStatusZ(statusOut.stdout);
  return { ...parsed, recentCommits: parseLogZ(logOut.stdout) };
}

export async function listFilesInCommit(wt: string, sha: string): Promise<GitFileChange[]> {
  const { stdout } = await git(wt, [
    'diff-tree', '--no-commit-id', '--name-status', '-r', '-z', sha,
  ]);
  const tokens = stdout.split('\0').filter(Boolean);
  const out: GitFileChange[] = [];
  for (let i = 0; i < tokens.length;) {
    const code = tokens[i++];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      out.push({ path, oldPath, status: code.startsWith('R') ? 'renamed' : 'modified' });
    } else {
      const path = tokens[i++];
      let status: GitFileStatus = 'modified';
      if (code === 'A') status = 'added';
      else if (code === 'D') status = 'deleted';
      out.push({ path, status });
    }
  }
  return out;
}

function looksBinary(buf: Buffer): boolean {
  // Same heuristic git uses: NUL byte in the first 8KB → binary.
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  return slice.includes(0);
}

/**
 * Read a file at a given revision. `git show <rev>:<path>` outputs the
 * file as raw bytes. Returns `null` when the path didn't exist at that
 * revision (we can't tell that from a normal failed exec because git
 * mixes "not found" with other errors, so we fall back to status code).
 */
async function readAtRev(wt: string, rev: string, path: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileP('git', ['show', `${rev}:${path}`], {
      cwd: wt,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'buffer',
    });
    return stdout as Buffer;
  } catch {
    return null;
  }
}

function readWorking(wt: string, path: string): Buffer | null {
  const full = join(wt, path);
  if (!existsSync(full)) return null;
  return readFileSync(full);
}

function bufToText(buf: Buffer | null): { text: string; isBinary: boolean } {
  if (buf == null) return { text: '', isBinary: false };
  if (looksBinary(buf)) return { text: '', isBinary: true };
  return { text: buf.toString('utf8'), isBinary: false };
}

export async function fileDiff(
  wt: string,
  scope: GitScope,
  path: string,
): Promise<{ oldText: string; newText: string; isBinary: boolean; path: string }> {
  let oldBuf: Buffer | null;
  let newBuf: Buffer | null;
  if (scope.kind === 'wip') {
    oldBuf = await readAtRev(wt, 'HEAD', path);
    newBuf = readWorking(wt, path);
  } else {
    oldBuf = await readAtRev(wt, `${scope.sha}~`, path);
    newBuf = await readAtRev(wt, scope.sha, path);
  }
  const oldSide = bufToText(oldBuf);
  const newSide = bufToText(newBuf);
  return {
    oldText: oldSide.text,
    newText: newSide.text,
    isBinary: oldSide.isBinary || newSide.isBinary,
    path,
  };
}

export async function commitFiles(
  wt: string,
  message: string,
  paths: string[],
): Promise<{ sha: string }> {
  if (paths.length === 0) throw new Error('Nothing to commit');
  if (!message.trim()) throw new Error('Commit message required');
  // Stage exactly the requested paths (handles untracked via -A) then
  // commit only those — `--` pathspec keeps unrelated staged changes
  // out of this commit.
  await git(wt, ['add', '-A', '--', ...paths]);
  await git(wt, ['commit', '-m', message, '--', ...paths]);
  const { stdout } = await git(wt, ['rev-parse', 'HEAD']);
  return { sha: stdout.trim() };
}

/**
 * List PR target candidates: develop (when present) plus the most
 * recent rc-1.* branches by committer date. Includes both local and
 * `origin/` remote branches because release-candidate branches often
 * exist only on origin.
 */
/** Branches floated to the top of the picker — the usual base branches.
 *  Everything else stays in most-recently-committed order. */
const PRIORITY_BRANCHES = ['main', 'master', 'develop', 'development', 'trunk'];

export async function listBaseBranches(wt: string): Promise<GitBaseBranches> {
  // Refresh remote-tracking refs first so branches created on origin but
  // never fetched locally still appear. Fail-soft: offline / origin
  // rejects → fall back to cached refs rather than blocking chat create.
  await git(wt, ['fetch', 'origin', '--prune', '--quiet']).catch(() => undefined);
  // Every local + origin branch, newest commit first. No naming-convention
  // filtering — the picker searches this list and the user chooses.
  const { stdout } = await git(wt, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    'refs/heads/',
    'refs/remotes/origin/',
  ]).catch(() => ({ stdout: '', stderr: '' }));
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const line of stdout.split('\n')) {
    const name = line.replace(/^origin\//, '').trim();
    // Skip the symbolic origin/HEAD ref and any duplicates.
    if (!name || name === 'HEAD' || name.endsWith('/HEAD') || seen.has(name)) continue;
    seen.add(name);
    branches.push(name);
  }
  // Stable-sort the well-known base branches to the front, preserving the
  // committerdate order for everything else.
  branches.sort((a, b) => {
    const ai = PRIORITY_BRANCHES.indexOf(a);
    const bi = PRIORITY_BRANCHES.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return { branches };
}

/**
 * Detect an existing PR for the chat's current branch via the `gh`
 * CLI. Returns null when no PR exists for the branch (gh exits 1).
 * Differentiates "no gh on PATH" and "not authenticated" so the UI
 * can show a useful nudge.
 */
export async function detectPr(
  wt: string,
  opts: { prNumber?: number } = {},
): Promise<
  | { ok: true; pr: GitPrInfo | null }
  | { ok: false; reason: 'gh-not-found' | 'gh-not-authed' | 'error'; error?: string }
> {
  // Without a number, `gh pr view` looks at the current branch — what
  // slot-bound chats want. CR / slot-less chats spawn in repo root
  // (typically on `develop`) and need an explicit PR number to look
  // up the right PR; the caller supplies it from chat.pr or by
  // parsing the chat title.
  const args = ['pr', 'view'];
  if (opts.prNumber !== undefined) args.push(String(opts.prNumber));
  args.push('--json', 'number,url,state,isDraft,title');
  try {
    const { stdout } = await execFileP(
      'gh',
      args,
      { cwd: wt, maxBuffer: 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as GitPrInfo;
    return { ok: true, pr: data };
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message: string };
    if (e.code === 'ENOENT') return { ok: false, reason: 'gh-not-found' };
    const stderr = (e.stderr ?? '').toLowerCase();
    // gh prints `no pull requests found` or similar when the branch
    // simply has no PR yet — that's a success case for our purposes.
    if (stderr.includes('no pull requests found') || stderr.includes('no pull request')) {
      return { ok: true, pr: null };
    }
    if (stderr.includes('authentication') || stderr.includes('not logged') || stderr.includes('http 401')) {
      return { ok: false, reason: 'gh-not-authed' };
    }
    return { ok: false, reason: 'error', error: e.stderr?.trim() || e.message };
  }
}

export async function revertFiles(wt: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  // Bucket into untracked (rm) vs tracked (`git checkout HEAD --`).
  const { stdout } = await git(wt, ['status', '--porcelain=v1', '-z', '--', ...paths]);
  const records = stdout.split('\0').filter(Boolean);
  const untracked: string[] = [];
  const tracked: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const x = r[0];
    const path = r.slice(3);
    if (x === 'R' || x === 'C') i += 1; // skip the original-path record
    if (r.startsWith('??')) untracked.push(path);
    else tracked.push(path);
  }
  if (tracked.length) await git(wt, ['checkout', 'HEAD', '--', ...tracked]);
  for (const p of untracked) {
    try { rmSync(join(wt, p)); } catch { /* best-effort */ }
  }
}

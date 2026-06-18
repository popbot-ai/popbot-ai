/**
 * Git sidebar IPC payload types.
 *
 * "scope" is what's being viewed in the panel:
 *   - 'wip'      → uncommitted working-tree changes (allows commit/revert)
 *   - { sha }    → an existing commit (read-only)
 */

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflict';

export interface GitFileChange {
  /** Repo-relative path. For renames this is the new path. */
  path: string;
  status: GitFileStatus;
  /** Original path when status === 'renamed'. */
  oldPath?: string;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** Unix-ms author date. */
  date: number;
}

export interface GitStatusResult {
  ok: true;
  branch: string | null;
  ahead: number;
  behind: number;
  /** Working-tree changes (staged + unstaged + untracked). */
  files: GitFileChange[];
  /** Most recent commits on the current branch (newest first, capped). */
  recentCommits: GitCommitSummary[];
}
export type GitStatusResultOrErr =
  | GitStatusResult
  | { ok: false; reason: 'no-worktree' | 'not-a-git-repo'; error?: string };

export type GitScope = { kind: 'wip' } | { kind: 'commit'; sha: string };

export interface GitDiffResult {
  ok: true;
  /** File contents at the "before" side (HEAD or sha~). Empty for adds/untracked. */
  oldText: string;
  /** File contents at the "after" side (working tree or sha). Empty for deletes. */
  newText: string;
  /** True when either side is binary; `oldText` / `newText` will be empty. */
  isBinary: boolean;
  /** Repo-relative path (echoed for convenience). */
  path: string;
}
export type GitDiffResultOrErr = GitDiffResult | { ok: false; error: string };

export interface GitCommitInput {
  chatId: string;
  message: string;
  /** Repo-relative paths to include in this commit. Empty = nothing to do. */
  paths: string[];
}
export type GitCommitResult =
  | { ok: true; sha: string }
  | { ok: false; error: string };

export interface GitRevertInput {
  chatId: string;
  /** Repo-relative paths to discard local changes for. */
  paths: string[];
}
export type GitRevertResult = { ok: true } | { ok: false; error: string };

export interface GitDiffInput {
  chatId: string;
  scope: GitScope;
  path: string;
}

export interface GitFilesInCommitInput {
  chatId: string;
  sha: string;
}
export type GitFilesInCommitResult =
  | { ok: true; files: GitFileChange[] }
  | { ok: false; error: string };

/** Candidate target branches for PR creation, surfaced in the
 *  panel's "→ <target>" dropdown. */
export interface GitBaseBranches {
  /** True when a `develop` branch (local or remote) exists. */
  hasDevelop: boolean;
  /** Up to N most recent rc-1.x branch names (e.g. 'rc-1.234'),
   *  sorted by committer date descending. */
  releaseCandidates: string[];
}
export type GitBaseBranchesResult =
  | { ok: true; branches: GitBaseBranches }
  | { ok: false; reason: 'no-worktree' | 'not-a-git-repo' | 'error'; error?: string };

/** PR detection via `gh pr view`. */
export interface GitPrInfo {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  title: string;
}
export type GitDetectPrResult =
  | { ok: true; pr: GitPrInfo | null }
  | { ok: false; reason: 'no-worktree' | 'gh-not-found' | 'gh-not-authed' | 'error'; error?: string };

/**
 * Git implementation of {@link SourceControlProvider}.
 *
 * Thin delegation: the actual git plumbing still lives in `../git/files`
 * (review/working-tree) and `../git/worktrees` (worktree lifecycle).
 * This class is the seam — it lets the rest of the app talk to "the
 * source-control provider" instead of importing git functions directly,
 * which is what makes Perforce / Lore addable without touching callers.
 */
import { homedir } from 'node:os';
import type { GitBaseBranches, GitFileChange, GitScope } from '@shared/git';
import {
  type SourceControlCapabilities,
  SOURCE_CONTROL_PROVIDERS,
} from '@shared/sourceControl';
import {
  SourceControlProvider,
  type CheckoutBranchOpts,
  type EnsureChatWorktreeOpts,
  type EnsureSlotWorktreeOpts,
  type EphemeralSlugOpts,
  type ParkSlotOpts,
  type RemoveChatWorktreeOpts,
  type ScmDetectPrResult,
  type ScmFileDiff,
  type ScmStatus,
  type WorktreeStatus,
} from './provider';
import {
  commitFiles,
  deriveGitUsername,
  detectPr,
  fileDiff,
  listBaseBranches,
  listFilesInCommit,
  listStatus,
  revertFiles,
} from '../git/files';
import {
  chatStashPrefix,
  checkoutBranch,
  deleteBranch,
  ensureChatWorktree,
  ensureSlotWorktree,
  ephemeralWorktreeSlug,
  findLatestStashRef,
  newChatStashName,
  parkSlot,
  parkingBranch,
  popStash,
  refreshParkBranchInBackground,
  refreshSlotForAllocation,
  removeChatWorktree,
  removeWorktree,
  worktreeStatus,
} from '../git/worktrees';

export class GitProvider extends SourceControlProvider {
  readonly id = 'git' as const;
  readonly capabilities: SourceControlCapabilities = SOURCE_CONTROL_PROVIDERS.git.capabilities;

  /* ---------- review / working-tree ---------- */

  listStatus(wt: string): Promise<ScmStatus> {
    return listStatus(wt);
  }
  fileDiff(wt: string, scope: GitScope, path: string): Promise<ScmFileDiff> {
    return fileDiff(wt, scope, path);
  }
  commitFiles(wt: string, message: string, paths: string[]): Promise<{ sha: string }> {
    return commitFiles(wt, message, paths);
  }
  revertFiles(wt: string, paths: string[]): Promise<void> {
    return revertFiles(wt, paths);
  }
  listFilesInCommit(wt: string, sha: string): Promise<GitFileChange[]> {
    return listFilesInCommit(wt, sha);
  }
  listBaseBranches(wt: string): Promise<GitBaseBranches> {
    return listBaseBranches(wt);
  }
  detectPr(wt: string, opts: { prNumber?: number } = {}): Promise<ScmDetectPrResult> {
    return detectPr(wt, opts);
  }
  deriveUsername(cwd: string = homedir()): Promise<string> {
    return deriveGitUsername(cwd);
  }

  /* ---------- workspace lifecycle ---------- */

  parkingBranch(repoName: string, slotId: number): string {
    return parkingBranch(repoName, slotId);
  }
  ensureSlotWorktree(opts: EnsureSlotWorktreeOpts): Promise<void> {
    return ensureSlotWorktree(opts);
  }
  checkoutBranch(opts: CheckoutBranchOpts): Promise<void> {
    return checkoutBranch(opts);
  }
  worktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
    return worktreeStatus(worktreePath);
  }
  parkSlot(opts: ParkSlotOpts): Promise<void> {
    return parkSlot(opts);
  }
  refreshSlotForAllocation(opts: { worktreePath: string; baseBranch: string }): Promise<void> {
    return refreshSlotForAllocation(opts);
  }
  refreshParkBranchInBackground(opts: {
    worktreePath: string;
    parkBranch: string;
    baseBranch: string;
  }): void {
    refreshParkBranchInBackground(opts);
  }
  deleteBranch(repoPath: string, branch: string): Promise<void> {
    return deleteBranch(repoPath, branch);
  }

  /* ---------- ephemeral worktree lifecycle ---------- */

  ephemeralWorktreeSlug(opts: EphemeralSlugOpts): string {
    return ephemeralWorktreeSlug(opts);
  }
  ensureChatWorktree(opts: EnsureChatWorktreeOpts): Promise<void> {
    return ensureChatWorktree(opts);
  }
  removeChatWorktree(opts: RemoveChatWorktreeOpts): Promise<void> {
    return removeChatWorktree(opts);
  }
  removeWorktree(opts: { repoPath: string; worktreePath: string }): Promise<void> {
    return removeWorktree(opts);
  }

  /* ---------- stash / shelve ---------- */

  chatStashPrefix(chatId: string): string {
    return chatStashPrefix(chatId);
  }
  newChatStashName(chatId: string): string {
    return newChatStashName(chatId);
  }
  findLatestStashRef(worktreePath: string, prefix: string): Promise<string | null> {
    return findLatestStashRef(worktreePath, prefix);
  }
  popStash(worktreePath: string, ref: string): Promise<void> {
    return popStash(worktreePath, ref);
  }
}

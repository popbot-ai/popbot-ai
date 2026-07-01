/**
 * Git implementation of {@link SourceControlProvider}.
 *
 * Thin delegation: the actual git plumbing still lives in `../git/files`
 * (review/working-tree) and `../git/worktrees` (worktree lifecycle).
 * This class is the seam — it lets the rest of the app talk to "the
 * source-control provider" instead of importing git functions directly,
 * which is what makes Perforce / Lore addable without touching callers.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { GitBaseBranches, GitFileChange, GitScope } from '@shared/git';
import type {
  GetReviewResult,
  ListRecentReviewsResult,
  ListReviewsResult,
} from '@shared/reviews';
import type { RepoRecord } from '@shared/persistence';
import { listRepos } from '../persistence/repos';
import { ensureSlot, removeSlot } from '../shado/slots';
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
  getReviewByNumber as ghGetReview,
  listPendingReviews as ghListPendingReviews,
  listRecentOpenPrs as ghListRecentOpenPrs,
} from '../git/reviews';
import {
  chatStashPrefix,
  checkoutBranch,
  ensureChatWorktree,
  ephemeralWorktreeSlug,
  findLatestStashRef,
  newChatStashName,
  parkSlot,
  parkingBranch,
  persistBranchToRoot,
  popStash,
  refreshParkBranchInBackground,
  refreshSlotForAllocation,
  removeChatWorktree,
  restoreBranchFromRoot,
  worktreeStatus,
} from '../git/worktrees';

const execFileP = promisify(execFile);

export class GitProvider extends SourceControlProvider {
  readonly id = 'git' as const;
  readonly capabilities: SourceControlCapabilities = SOURCE_CONTROL_PROVIDERS.git.capabilities;

  /** The git repo backing a folder (for the base name = its short id). */
  private repoFor(repoPath: string): RepoRecord {
    const repo = listRepos().find(
      (r) => r.repoPath === repoPath && (r.scm ?? 'git') !== 'perforce',
    );
    if (!repo) throw new Error(`No git repo configured for ${repoPath}`);
    return repo;
  }

  private async gitInSlot(cwd: string, args: string[]): Promise<void> {
    // shado slot clones are created in the elevated (UAC) context, so their
    // files are owned by the Administrators group while PopBot runs as the
    // normal user — git then refuses with "detected dubious ownership". Trust
    // the dir for this invocation (scoped `-c`, not a global config change).
    await execFileP('git', ['-c', 'safe.directory=*', ...args], { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  }

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

  /* ---------- code review (GitHub PRs via gh) ---------- */

  listPendingReviews(repoPaths: string[]): Promise<ListReviewsResult> {
    return ghListPendingReviews(repoPaths);
  }
  listRecentReviews(repoPaths: string[]): Promise<ListRecentReviewsResult> {
    return ghListRecentOpenPrs(repoPaths);
  }
  getReview(repoPaths: string[], prNumber: number): Promise<GetReviewResult> {
    return ghGetReview(repoPaths, prNumber);
  }

  /* ---------- workspace lifecycle ---------- */

  parkingBranch(repoName: string, slotId: number): string {
    return parkingBranch(repoName, slotId);
  }
  /**
   * Slot mode now rides shado: each slot is a copy-on-write clone of the
   * repo's frozen base (so warm caches — node_modules, build output —
   * survive across chats), not a `git worktree`. The clone is a full git
   * repo at the slot path; we just establish the parking branch inside it.
   * The clone is created by the elevated base-build, so ensureSlot here
   * tolerates the already-mounted slot and stays unprivileged.
   */
  async ensureSlotWorktree(opts: EnsureSlotWorktreeOpts): Promise<void> {
    const repo = this.repoFor(opts.repoPath);
    await ensureSlot({
      baseName: repo.id,
      repoId: repo.id,
      repoPath: opts.repoPath,
      worktreePath: opts.worktreePath,
    });
    // Park the freshly-cloned slot on its parking branch off the base. FORCE
    // the checkout: a clone inherits whatever uncommitted state the base had
    // (e.g. a modified package-lock.json), which would otherwise abort with
    // "local changes would be overwritten". A slot is meant to start pristine,
    // so we discard that inherited dirt and land cleanly on the parking branch.
    await this.gitInSlot(opts.worktreePath, ['checkout', '-f', '-B', opts.parkBranch, opts.baseBranch]);
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
  deleteBranch(_repoPath: string, _branch: string): Promise<void> {
    // Parking branches live inside each slot's clone (its own .git), so they
    // vanish when the clone is removed — nothing to delete in the source repo.
    return Promise.resolve();
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
  async removeWorktree(opts: { repoPath: string; worktreePath: string }): Promise<void> {
    const repo = this.repoFor(opts.repoPath);
    await removeSlot({
      baseName: repo.id,
      repoId: repo.id,
      repoPath: opts.repoPath,
      worktreePath: opts.worktreePath,
    });
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

  /* ---------- cross-slot continuity ---------- */

  async persistChatOnClose(opts: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    discard: boolean;
  }): Promise<{ p4ShelfCl?: number | null }> {
    // Push the chat branch (carrying uncommitted work as a soft WIP commit,
    // unless discarded) to the local root so any slot can restore it.
    await persistBranchToRoot(opts);
    return {};
  }

  async restoreChatOnReopen(opts: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
  }): Promise<{ p4ShelfCl?: number | null }> {
    // `checkoutBranch` already placed us on a fresh `branch` off the latest
    // base; overlay the chat's persisted state from the local root if present
    // (no-op when nothing was ever persisted).
    await restoreBranchFromRoot({
      repoPath: opts.repoPath,
      worktreePath: opts.worktreePath,
      branch: opts.branch,
    });
    return {};
  }
}

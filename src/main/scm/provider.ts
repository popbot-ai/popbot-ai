/**
 * Source-control provider — BASE CLASS (main process).
 *
 * The abstract surface every provider (Git today; Perforce / Lore
 * roughed-in) implements. It is deliberately the SMALL COMMON layer that
 * maps across very different VCSs:
 *
 *   - workspace lifecycle: open / park / tear-down a per-chat working
 *     copy (git worktree, Perforce client, …);
 *   - review: status, file diff, commit/submit, revert, files-in-commit;
 *   - base refs + PR/review detection;
 *   - the naming conventions those flows depend on (parking branch,
 *     ephemeral slug, stash names) — encapsulated here so a provider
 *     whose model differs (Perforce changelists) can name things its
 *     own way without callers special-casing the id.
 *
 * Behavior that does NOT abstract cleanly is feature-detected via
 * {@link SourceControlCapabilities} (see `@shared/sourceControl`), and a
 * provider too divergent for the generic git sidebar opts into its own
 * client window (`capabilities.nativeClientUi`). Callers branch on
 * CAPABILITIES, never on the provider id.
 *
 * All operations take explicit absolute paths; the IPC layer resolves
 * chatId → worktree/repo before calling in. Methods mirror the existing
 * free functions in `../git/*` 1:1 so the concrete {@link GitProvider}
 * is a thin delegation.
 */
import type {
  GitBaseBranches,
  GitCommitSummary,
  GitFileChange,
  GitPrInfo,
  GitScope,
} from '@shared/git';
import type { SourceControlProviderId, SourceControlCapabilities } from '@shared/sourceControl';
import type {
  CheckoutBranchOpts,
  EnsureChatWorktreeOpts,
  EnsureSlotWorktreeOpts,
  ParkSlotOpts,
  RemoveChatWorktreeOpts,
  WorktreeStatus,
} from '../git/worktrees';

/** Working-tree status + recent history (matches `GitStatusResult`
 *  minus the `ok` discriminator the IPC layer adds). */
export interface ScmStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  recentCommits: GitCommitSummary[];
  /** Perforce only — shelved changelists for the P4 panel's shelf section. */
  shelves?: import('@shared/perforce').P4Shelf[];
  /** Perforce only — the slot's P4 client (workspace) name, for the panel. */
  client?: string;
}

/** A single file's before/after for the diff overlay. */
export interface ScmFileDiff {
  oldText: string;
  newText: string;
  isBinary: boolean;
  path: string;
}

export type ScmDetectPrResult =
  | { ok: true; pr: GitPrInfo | null }
  | { ok: false; reason: 'gh-not-found' | 'gh-not-authed' | 'error'; error?: string };

/** Inputs for {@link SourceControlProvider.ephemeralWorktreeSlug}. */
export interface EphemeralSlugOpts {
  ticket: string | null;
  pr: number | null;
  chatId: string;
}

export type {
  CheckoutBranchOpts,
  EnsureChatWorktreeOpts,
  EnsureSlotWorktreeOpts,
  ParkSlotOpts,
  RemoveChatWorktreeOpts,
  WorktreeStatus,
};

/**
 * Base class for a source-control provider. Concrete providers extend
 * this and implement every method. New providers should keep the COMMON
 * surface honest — if an operation can't be expressed for a provider,
 * gate it behind a capability rather than stubbing a lie here.
 */
export abstract class SourceControlProvider {
  abstract readonly id: SourceControlProviderId;
  abstract readonly capabilities: SourceControlCapabilities;

  /* ---------- review / working-tree (the git sidebar) ---------- */

  /** Status + recent commits for the working copy at `wt`. */
  abstract listStatus(wt: string): Promise<ScmStatus>;
  /** Before/after text for one file under `scope`. */
  abstract fileDiff(wt: string, scope: GitScope, path: string): Promise<ScmFileDiff>;
  /** Commit/submit the given paths. Returns the new commit/change id. */
  abstract commitFiles(wt: string, message: string, paths: string[]): Promise<{ sha: string }>;
  /** Discard local changes for the given paths. */
  abstract revertFiles(wt: string, paths: string[]): Promise<void>;
  /** Files touched by a commit/change. */
  abstract listFilesInCommit(wt: string, sha: string): Promise<GitFileChange[]>;
  /** Candidate base refs to fork a chat from. Gated by
   *  `capabilities.baseRefSelection`. */
  abstract listBaseBranches(wt: string): Promise<GitBaseBranches>;
  /** Detect an open PR/review for the working copy / explicit number.
   *  Gated by `capabilities.pullRequests`. */
  abstract detectPr(wt: string, opts?: { prNumber?: number }): Promise<ScmDetectPrResult>;
  /** Branch-name username (gh login / git identity / Perforce user). */
  abstract deriveUsername(cwd: string): Promise<string>;

  /* ---------- workspace lifecycle (the slot system) ---------- */

  /** Parking-branch (or equivalent idle ref) name for a slot. */
  abstract parkingBranch(repoName: string, slotId: number): string;
  /** Idempotently ensure a slot's long-lived worktree exists on its
   *  parking branch. */
  abstract ensureSlotWorktree(opts: EnsureSlotWorktreeOpts): Promise<void>;
  /** Switch a slot worktree to the chat's branch (creating it off base). */
  abstract checkoutBranch(opts: CheckoutBranchOpts): Promise<void>;
  /** Dirty/clean + porcelain lines for the close-confirm UI. */
  abstract worktreeStatus(worktreePath: string): Promise<WorktreeStatus>;
  /** Release a slot back to its parking branch (optionally stash/discard). */
  abstract parkSlot(opts: ParkSlotOpts): Promise<void>;
  /** Bring a slot's parking + base refs current before allocation. */
  abstract refreshSlotForAllocation(opts: { worktreePath: string; baseBranch: string }): Promise<void>;
  /** Fire-and-forget post-close refresh of the parking branch. */
  abstract refreshParkBranchInBackground(opts: {
    worktreePath: string;
    parkBranch: string;
    baseBranch: string;
  }): void;
  /** Best-effort delete of a parking/chat branch from the main repo. */
  abstract deleteBranch(repoPath: string, branch: string): Promise<void>;

  /* ---------- ephemeral worktree lifecycle ---------- */

  /** Folder-name slug for an ephemeral chat worktree. */
  abstract ephemeralWorktreeSlug(opts: EphemeralSlugOpts): string;
  /** Idempotently ensure an ephemeral worktree on the chat's branch. */
  abstract ensureChatWorktree(opts: EnsureChatWorktreeOpts): Promise<void>;
  /** Tear down an ephemeral chat worktree (optionally stash/discard). */
  abstract removeChatWorktree(opts: RemoveChatWorktreeOpts): Promise<void>;
  /** Hard tear-down of a worktree (purge / uninstall tooling). */
  abstract removeWorktree(opts: { repoPath: string; worktreePath: string }): Promise<void>;

  /* ---------- stash / shelve (close→reopen continuity) ---------- */

  /** Stash-message prefix used to find a chat's set-aside work. */
  abstract chatStashPrefix(chatId: string): string;
  /** A fresh, unique stash/shelve name for a chat. */
  abstract newChatStashName(chatId: string): string;
  /** Find the most recent stash/shelve for `prefix`, or null. */
  abstract findLatestStashRef(worktreePath: string, prefix: string): Promise<string | null>;
  /** Restore (pop) a stash/shelve by ref. */
  abstract popStash(worktreePath: string, ref: string): Promise<void>;
}

/**
 * Perforce implementation of {@link SourceControlProvider}.
 *
 * Composition, mirroring {@link GitProvider}'s thin delegation:
 *   - review/working-tree  → `../p4/files` (opened files, diff, submit,
 *     revert, change history), driven from each slot's `.p4config`;
 *   - slot lifecycle       → shado differencing clones (`../shado/client`)
 *     plus a per-slot P4 client flushed to the base changelist (0-byte) —
 *     see the shado+P4 design. The "parking branch" is the slot's stable
 *     P4 client name; the "stash" is a Perforce shelve.
 *
 * Unlike git, Perforce can't infer its connection/config from the working
 * directory, so slot-creating methods look the owning repo up by path
 * (`RepoRecord.p4`), and path-only methods read the slot's `.p4config` +
 * a `.popbot-p4.json` sidecar written at create time.
 *
 * NOTE: shado mutations (clone create/rm) require an elevated context;
 * a non-elevated call surfaces shado's error. The standing elevated
 * service (pbworkspaced) is future work — until then the app must run
 * elevated for slot allocation on Perforce repos.
 */
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, parse } from 'node:path';
import type { GitBaseBranches, GitFileChange, GitScope } from '@shared/git';
import type { PerforceRepoConfig, RepoRecord } from '@shared/persistence';
import {
  type SourceControlCapabilities,
  SOURCE_CONTROL_PROVIDERS,
} from '@shared/sourceControl';
import { listRepos } from '../persistence/repos';
import { runShado, shadoHomeForRepo } from '../shado/client';
import { readP4Config, type P4Context } from '../p4/exec';
import {
  deriveUsername as p4DeriveUsername,
  fileDiff as p4FileDiff,
  filesInChange as p4FilesInChange,
  listStatus as p4ListStatus,
  revertFiles as p4RevertFiles,
  submitFiles as p4SubmitFiles,
} from '../p4/files';
import {
  deleteClient,
  ensureClient,
  findLatestShelf,
  flushTo,
  readSlotMeta,
  revertAll,
  shelveWork,
  unshelvePop,
  writeSlotMeta,
} from '../p4/workspace';
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

/** Max porcelain lines surfaced by worktreeStatus for the close prompt. */
const STATUS_LINES = 200;

export class PerforceProvider extends SourceControlProvider {
  readonly id = 'perforce' as const;
  readonly capabilities: SourceControlCapabilities = SOURCE_CONTROL_PROVIDERS.perforce.capabilities;

  /* ---------- helpers ---------- */

  /** P4 connection for a slot path, from its `.p4config`. Throws when the
   *  slot was never initialized (no config) — callers in the review path
   *  catch and surface "no workspace". */
  private ctx(wt: string): P4Context {
    const c = readP4Config(wt);
    if (!c) throw new Error(`No Perforce workspace at ${wt} (missing .p4config)`);
    return c;
  }

  /** The Perforce repo (+ its config) owning `repoPath`. */
  private repoFor(repoPath: string): { repo: RepoRecord; p4: PerforceRepoConfig } {
    const repo = listRepos().find((r) => r.repoPath === repoPath && r.scm === 'perforce');
    if (!repo?.p4) throw new Error(`No Perforce repo configured for ${repoPath}`);
    return { repo, p4: repo.p4 };
  }

  /** shado slot id = the worktree folder name. With `slotPrefix` set to the
   *  shado base, that's the `<base>-<n>` convention (e.g. `league-1`). */
  private shadoSlot(worktreePath: string): string {
    return basename(worktreePath);
  }

  /** Drive root (case-folded) for the same-drive invariant. */
  private drive(p: string): string {
    return parse(p).root.toLowerCase();
  }

  /* ---------- review / working-tree ---------- */

  async listStatus(wt: string): Promise<ScmStatus> {
    try {
      return await p4ListStatus(this.ctx(wt), wt);
    } catch {
      return { branch: null, ahead: 0, behind: 0, files: [], recentCommits: [] };
    }
  }
  fileDiff(wt: string, scope: GitScope, path: string): Promise<ScmFileDiff> {
    return p4FileDiff(this.ctx(wt), wt, scope, path);
  }
  commitFiles(wt: string, message: string, paths: string[]): Promise<{ sha: string }> {
    return p4SubmitFiles(this.ctx(wt), wt, message, paths);
  }
  revertFiles(wt: string, paths: string[]): Promise<void> {
    return p4RevertFiles(this.ctx(wt), wt, paths);
  }
  listFilesInCommit(wt: string, sha: string): Promise<GitFileChange[]> {
    return p4FilesInChange(this.ctx(wt), wt, sha);
  }
  // Perforce streams aren't modelled yet; the base picker is empty (the
  // capability stays on so the UI can light up once streams land).
  listBaseBranches(_wt: string): Promise<GitBaseBranches> {
    return Promise.resolve({ branches: [] });
  }
  // No PR/review integration (Swarm) yet — pullRequests capability is off,
  // so this is never reached; answer "no PR" defensively.
  detectPr(_wt: string): Promise<ScmDetectPrResult> {
    return Promise.resolve({ ok: true, pr: null });
  }
  async deriveUsername(cwd: string): Promise<string> {
    try {
      return await p4DeriveUsername(this.ctx(cwd));
    } catch {
      return '';
    }
  }

  /* ---------- workspace lifecycle (slots) ---------- */

  /** The slot's stable P4 client name — the parking-branch analog. */
  parkingBranch(repoName: string, slotId: number): string {
    return `popbot_${repoName}_slot${slotId}`;
  }

  async ensureSlotWorktree(opts: EnsureSlotWorktreeOpts): Promise<void> {
    const { p4 } = this.repoFor(opts.repoPath);
    // Slots and the source repo MUST be on the same drive — the VHDX base
    // and its differencing children live together on the repo's drive.
    if (this.drive(opts.worktreePath) !== this.drive(opts.repoPath)) {
      throw new Error(
        `Perforce slot must be on the same drive as its repo (slot ${opts.worktreePath}, repo ${opts.repoPath})`,
      );
    }
    const slot = this.shadoSlot(opts.worktreePath); // "<base>-<n>"
    const env = { SHADO_HOME: shadoHomeForRepo(opts.repoPath) };
    // shado differencing clone mounted at the slot path (base + diffs on the
    // repo's drive via SHADO_HOME).
    const r = await runShado(
      ['clone', 'create', '--name', p4.shadoBase, '--slot', slot, '--mount', opts.worktreePath],
      { env },
    );
    if (!r.ok && !existsSync(opts.worktreePath)) {
      throw new Error(`shado clone create failed for slot ${slot}: ${r.stderr || r.stdout}`);
    }
    // Per-slot P4 client + flush to the base changelist (0-byte), locked to
    // this host so P4V lists it.
    await ensureClient({
      ctx: { port: p4.port, user: p4.user, client: opts.parkBranch },
      root: opts.worktreePath,
      depotPath: p4.depotPath,
      baseChangelist: p4.baseChangelist,
      host: hostname(),
    });
    writeSlotMeta(opts.worktreePath, { depotPath: p4.depotPath, baseChangelist: p4.baseChangelist });
  }

  /** Perforce has no branches; a freshly-allocated slot is reset to a clean
   *  base (revert opened, re-anchor have-list at the base changelist). */
  async checkoutBranch(opts: CheckoutBranchOpts): Promise<void> {
    const ctx = this.ctx(opts.worktreePath);
    const meta = readSlotMeta(opts.worktreePath);
    await revertAll(ctx, opts.worktreePath);
    if (meta) await flushTo(ctx, meta.depotPath, meta.baseChangelist);
  }

  async worktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
    try {
      const { files } = await p4ListStatus(this.ctx(worktreePath), worktreePath);
      return {
        dirty: files.length > 0,
        files: files.slice(0, STATUS_LINES).map((f) => `${f.status}\t${f.path}`),
      };
    } catch {
      return { dirty: false, files: [] };
    }
  }

  async parkSlot(opts: ParkSlotOpts): Promise<void> {
    const ctx = this.ctx(opts.worktreePath);
    const meta = readSlotMeta(opts.worktreePath);
    if (opts.stash) {
      await shelveWork(ctx, opts.worktreePath, opts.stashMessage ?? 'popbot park');
    }
    // Park clean either way — work is either shelved (recoverable) or
    // discarded. Then re-anchor the have-list at the base changelist.
    await revertAll(ctx, opts.worktreePath);
    if (meta) await flushTo(ctx, meta.depotPath, meta.baseChangelist);
  }

  async refreshSlotForAllocation(opts: { worktreePath: string; baseBranch: string }): Promise<void> {
    // The shado base is frozen at a fixed changelist; "refresh" just
    // re-anchors the slot's have-list there (idempotent, 0-byte).
    try {
      const ctx = this.ctx(opts.worktreePath);
      const meta = readSlotMeta(opts.worktreePath);
      if (meta) await flushTo(ctx, meta.depotPath, meta.baseChangelist);
    } catch {
      /* slot not yet initialized — ensureSlotWorktree will set it up */
    }
  }

  // Nothing to refresh in the background for a frozen base.
  refreshParkBranchInBackground(_opts: {
    worktreePath: string;
    parkBranch: string;
    baseBranch: string;
  }): void {
    /* no-op */
  }

  async deleteBranch(repoPath: string, branch: string): Promise<void> {
    const { p4 } = this.repoFor(repoPath);
    await deleteClient({ port: p4.port, user: p4.user, client: branch });
  }

  /* ---------- ephemeral (unsupported for Perforce) ---------- */

  ephemeralWorktreeSlug(opts: EphemeralSlugOpts): string {
    if (opts.ticket) return opts.ticket.toLowerCase();
    if (opts.pr != null) return `pr-${opts.pr}`;
    return `chat-${opts.chatId.slice(-12)}`;
  }
  ensureChatWorktree(_opts: EnsureChatWorktreeOpts): Promise<void> {
    return Promise.reject(new Error('Perforce repos do not support ephemeral worktrees'));
  }
  removeChatWorktree(_opts: RemoveChatWorktreeOpts): Promise<void> {
    return Promise.resolve(); // never created; nothing to tear down
  }

  /** Hard teardown of a slot: delete the P4 client + destroy the shado clone. */
  async removeWorktree(opts: { repoPath: string; worktreePath: string }): Promise<void> {
    try {
      await deleteClient(this.ctx(opts.worktreePath));
    } catch {
      /* no client / config — fall through to shado teardown */
    }
    try {
      const { p4 } = this.repoFor(opts.repoPath);
      await runShado(
        ['clone', 'rm', '--name', p4.shadoBase, '--slot', this.shadoSlot(opts.worktreePath), '--force'],
        { env: { SHADO_HOME: shadoHomeForRepo(opts.repoPath) } },
      );
    } catch {
      /* repo gone or shado unavailable — best-effort */
    }
  }

  /* ---------- stash / shelve ---------- */

  chatStashPrefix(chatId: string): string {
    return `popbot/chat_${chatId}/`;
  }
  newChatStashName(chatId: string): string {
    return `${this.chatStashPrefix(chatId)}${new Date().toISOString()}`;
  }
  findLatestStashRef(worktreePath: string, prefix: string): Promise<string | null> {
    try {
      return findLatestShelf(this.ctx(worktreePath), prefix);
    } catch {
      return Promise.resolve(null);
    }
  }
  popStash(worktreePath: string, ref: string): Promise<void> {
    return unshelvePop(this.ctx(worktreePath), worktreePath, ref);
  }
}

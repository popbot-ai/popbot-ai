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
import { hostname } from 'node:os';
import type { GitBaseBranches, GitFileChange, GitScope } from '@shared/git';
import type { P4ShelfItem } from '@shared/perforce';
import type { PerforceRepoConfig, RepoRecord } from '@shared/persistence';
import {
  type SourceControlCapabilities,
  SOURCE_CONTROL_PROVIDERS,
} from '@shared/sourceControl';
import { listRepos } from '../persistence/repos';
import { ensureSlot, removeSlot } from '../shado/slots';
import { readP4Config, type P4Context } from '../p4/exec';
import {
  deriveUsername as p4DeriveUsername,
  fileDiff as p4FileDiff,
  filesInChange as p4FilesInChange,
  listStatus as p4ListStatus,
  revertFiles as p4RevertFiles,
  submitFiles as p4SubmitFiles,
  submitChangelist,
  queueRecentChangesRefresh,
} from '../p4/files';
import {
  deleteClient,
  createChangelist,
  deleteChangelist,
  ensureClient,
  ensureRootClient,
  findLatestShelf,
  flushTo,
  listShelves,
  openChanges,
  readSlotMeta,
  deleteShelf,
  reshelveInto,
  revertAll,
  revertUnchanged,
  rootClientName,
  shelveFiles,
  shelveWork,
  syncLatest,
  unshelveInto,
  unshelvePop,
  writeSlotMeta,
} from '../p4/workspace';
import { p4exec } from '../p4/exec';
import {
  clearSlotChanges,
  getSlotChanges,
  getSpamSuggestion,
  clearSpamSuggestion,
  muteSubtree,
  pauseSlotWatch,
  reloadSlotWatch,
  resumeSlotWatch,
  startSlotWatch,
  stopSlotWatch,
} from '../p4/watcher';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSetting, setSetting } from '../persistence/settings';
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

  /** Slots whose watcher setup has been scheduled — so the heavy recursive
   *  fs.watch is kicked off once, OFF the awaited status path (it blocked the
   *  app ~14s on the first status). */
  private readonly watchScheduled = new Set<string>();

  /** P4 connection for a slot path, from its `.p4config`. Throws when the
   *  slot was never initialized (no config) — callers in the review path
   *  catch and surface "no workspace". */
  private ctx(wt: string): P4Context {
    const c = readP4Config(wt);
    if (!c) throw new Error(`No Perforce workspace at ${wt} (missing .p4config)`);
    return c;
  }

  /**
   * Open whatever the slot watcher saw change (targeted edit/add/delete,
   * never reconcile) so `p4 opened` reflects the working tree. The SINGLE
   * reconciliation point shared by status / commit / worktreeStatus — so a
   * close-confirm or submit can't miss files the agent edited without an
   * explicit `p4 edit`.
   */
  private async syncWatched(ctx: P4Context, wt: string): Promise<void> {
    // Start the slot watcher OFF the awaited status path. Its recursive fs.watch
    // setup is heavy on a large slot tree (blocked the app ~14s on the first
    // status), so schedule it once, asynchronously — never gate status on it.
    if (!this.watchScheduled.has(wt)) {
      this.watchScheduled.add(wt);
      setImmediate(() => startSlotWatch(wt, this.spamIgnoreRels(wt)));
    }
    const changes = getSlotChanges(wt);
    if (changes.length) {
      // Open the watcher's changes into the chat's named changelist.
      await openChanges(ctx, wt, changes, readSlotMeta(wt)?.changelist);
      clearSlotChanges(wt);
      // The watcher opens files on raw OS write events — which include PopBot's
      // OWN bulk writes (p4 sync / unshelve) whose content equals the depot, so
      // a fresh slot can show thousands of byte-identical files "opened". p4 is
      // the content authority: `revert -a` drops every unchanged open and keeps
      // only genuinely-modified files. `p4 edit`/`revert` fire ~no fs events
      // (verified), so this doesn't feed the watcher.
      await revertUnchanged(ctx, wt);
    }
  }

  /** The Perforce repo (+ its config) owning `repoPath`. */
  private repoFor(repoPath: string): { repo: RepoRecord; p4: PerforceRepoConfig } {
    const repo = listRepos().find((r) => r.repoPath === repoPath && r.scm === 'perforce');
    if (!repo?.p4) throw new Error(`No Perforce repo configured for ${repoPath}`);
    return { repo, p4: repo.p4 };
  }

  /* ---------- review / working-tree ---------- */

  async listStatus(wt: string): Promise<ScmStatus> {
    let ctx: P4Context;
    try {
      ctx = this.ctx(wt);
    } catch {
      // No `.p4config` yet — the slot isn't initialized. An empty (clean)
      // status is the right answer here, not an error.
      return { branch: null, ahead: 0, behind: 0, files: [], recentCommits: [] };
    }
    // Real p4 failures (bad P4PORT, expired ticket, server down) propagate so
    // the IPC layer returns { ok:false, error } and the panel shows them —
    // a connection failure must NOT render as an empty, clean workspace.
    await this.syncWatched(ctx, wt);
    // "Recent changes" scopes to the MAIN workspace's client view (aggregate
    // include list) / depot path — repo-level, fetched once per repo (cached).
    const meta = readSlotMeta(wt);
    const status = await p4ListStatus(ctx, wt, meta?.mainClient, meta?.depotPath);
    const shelves = await listShelves(ctx).catch(() => []);
    // Surface the chat's changelist name (its branch analog) as the branch, and
    // any pending spam-folder suggestion the watcher auto-muted.
    const name = meta?.changelistName;
    return { ...status, branch: name ?? status.branch, shelves, spamSuggestion: getSpamSuggestion(wt) };
  }
  /** Act on an auto-muted spam folder (worktree-rel `path`). Always mutes it for
   *  the session (stops the live spam); then optionally persists an ignore or
   *  recovers the real changes via a bounded reconcile. */
  async spamAction(wt: string, path: string, action: 'p4ignore' | 'prefs' | 'session' | 'reconcile'): Promise<void> {
    // Normalize the user-editable path: unify Windows separators, strip leading/
    // trailing slashes, and reject any `..` segment so it can't escape the slot.
    const rel = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!rel || rel.split('/').some((s) => s === '..')) return;
    if (action === 'p4ignore' || action === 'prefs') {
      if (action === 'p4ignore') {
        // Team-shared, p4-native: append the dir to the slot's .p4ignore.
        const file = join(wt, '.p4ignore');
        let cur = '';
        try { cur = readFileSync(file, 'utf8'); } catch { /* none yet */ }
        const present = cur.split(/\r?\n/).some((l) => l.trim() === `${rel}/` || l.trim() === rel);
        if (!present) {
          try { writeFileSync(file, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + `${rel}/\n`); } catch { /* best effort */ }
        }
      } else {
        // App-local (for teams who can't edit .p4ignore): keyed by the repo's depot
        // path (repo-stable, read straight from slot meta — no repo lookup needed).
        const key = readSlotMeta(wt)?.depotPath;
        if (key) {
          const all = getSetting<Record<string, string[]>>('p4-ignore') ?? {};
          all[key] = [...new Set([...(all[key] ?? []), rel])];
          setSetting('p4-ignore', all);
        }
      }
      // Re-prune @parcel so the folder stops consuming inotify now AND next
      // session (via spamIgnoreRels). This clears the pending suggestion too
      // (fresh state) and carries over other folders' mutes + pending changes.
      await reloadSlotWatch(wt, this.spamIgnoreRels(wt));
      return;
    }
    // session / reconcile: mute for this run; reconcile also recovers the real
    // edits the mute dropped — bounded to this folder, into the chat's CL. For
    // reconcile, RUN IT FIRST (non-tolerant so a genuine failure throws) and
    // only mute + clear the suggestion on success — otherwise a failed recover
    // would drop the real changes AND lose the prompt to retry.
    if (action === 'reconcile') {
      const cl = readSlotMeta(wt)?.changelist;
      const args = ['reconcile', ...(cl ? ['-c', String(cl)] : []), `${rel}/...`];
      await p4exec(this.ctx(wt), args, { cwd: wt, maxBuffer: 64 * 1024 * 1024 });
    }
    muteSubtree(wt, rel);
    clearSpamSuggestion(wt);
  }

  /** Persisted per-folder ignores for a slot — the @parcel prune set passed to
   *  the watcher: PopBot-pref ignores (depot-path keyed) + exact-path dir entries
   *  from .p4ignore. Built-in heavy dirs (Saved/, Intermediate/, …) are pruned
   *  separately by the watcher's own globs. */
  private spamIgnoreRels(wt: string): string[] {
    const rels = new Set<string>();
    const key = readSlotMeta(wt)?.depotPath;
    if (key) for (const r of getSetting<Record<string, string[]>>('p4-ignore')?.[key] ?? []) rels.add(r);
    try {
      for (const raw of readFileSync(join(wt, '.p4ignore'), 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        const p = line.replace(/^\/+|\/+$/g, '');
        if (p && !/[*?[\]]/.test(p)) rels.add(p); // exact dir (name or path); wildcards stay in loadIgnore
      }
    } catch { /* no .p4ignore */ }
    return [...rels];
  }

  fileDiff(wt: string, scope: GitScope, path: string): Promise<ScmFileDiff> {
    return p4FileDiff(this.ctx(wt), wt, scope, path);
  }
  async commitFiles(wt: string, message: string, paths: string[]): Promise<{ sha: string }> {
    const ctx = this.ctx(wt);
    await this.syncWatched(ctx, wt);
    const meta = readSlotMeta(wt);
    let result: { sha: string };
    if (meta?.changelist) {
      result = await submitChangelist(ctx, wt, meta.changelist, message);
      // Keep the chat going in a fresh changelist with the same name.
      const cl = await createChangelist(ctx, meta.changelistName ?? message);
      writeSlotMeta(wt, { ...meta, changelist: cl || undefined });
    } else {
      result = await p4SubmitFiles(ctx, wt, message, paths);
    }
    // A new CL just landed — queue a non-blocking recent-changes refresh so the
    // panel reflects it without waiting for the cache TTL.
    queueRecentChangesRefresh(ctx, meta?.mainClient, meta?.depotPath);
    return result;
  }
  /** Revert the selected files. PAUSE the slot watcher around it: `p4 revert`
   *  rewrites each file back to the depot version on disk, which fires OS
   *  file-change events — without the pause the watcher re-records them and the
   *  next status `p4 edit`s them right back open, so the revert appears to do
   *  nothing. */
  async revertFiles(wt: string, paths: string[]): Promise<void> {
    const ctx = this.ctx(wt);
    pauseSlotWatch(wt);
    try {
      await p4RevertFiles(ctx, wt, paths);
    } finally {
      // Drain the revert's fs events (dropped while paused), then clear +
      // resume so the just-reverted files don't reappear on the next status.
      setTimeout(() => {
        clearSlotChanges(wt);
        resumeSlotWatch(wt);
      }, 600);
    }
  }
  /** Shelve the checked files. "Move" (default) reverts the working copies;
   *  "Copy" (keepWorking) leaves them opened. Opens watched edits first so the
   *  checked files are really opened, and PAUSES the slot watcher around the
   *  revert so those p4-driven rewrites aren't re-recorded + re-opened. */
  async shelveFiles(wt: string, paths: string[], message: string, keepWorking = false): Promise<{ change: string }> {
    const ctx = this.ctx(wt);
    await this.syncWatched(ctx, wt);
    pauseSlotWatch(wt);
    try {
      const change = await shelveFiles(ctx, wt, paths, message, keepWorking);
      return { change: change ?? '' };
    } finally {
      // Let the revert's fs events drain (dropped while paused), then clear +
      // resume so a stale edit doesn't reappear on the next status.
      setTimeout(() => {
        clearSlotChanges(wt);
        resumeSlotWatch(wt);
      }, 600);
    }
  }
  /** Restore the checked shelved FILES into the working area ("Return to
   *  Changelist") — unshelve the named files + drop them from the shelf. The
   *  panel lists files, so each item is a changelist + the files picked from it. */
  async unshelve(wt: string, items: P4ShelfItem[]): Promise<void> {
    const ctx = this.ctx(wt);
    // Pause the watcher: unshelve writes the shelved files to disk (and opens
    // them in p4 directly), so the fs events it fires would otherwise be
    // re-recorded and churned on the next status.
    pauseSlotWatch(wt);
    try {
      for (const it of items) {
        await unshelvePop(ctx, wt, it.change, it.paths);
      }
    } finally {
      setTimeout(() => {
        clearSlotChanges(wt);
        resumeSlotWatch(wt);
      }, 600);
    }
  }
  /** Discard the checked shelved FILES ("Delete From Shelf") without restoring. */
  async deleteShelf(wt: string, items: P4ShelfItem[]): Promise<void> {
    const ctx = this.ctx(wt);
    for (const it of items) {
      await deleteShelf(ctx, wt, it.change, it.paths);
    }
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
    const { repo, p4 } = this.repoFor(opts.repoPath);
    // shado COW clone mounted at the slot path (shared substrate enforces
    // same-drive + <base>-N naming + SHADO_HOME under workspaces/<id>/shado).
    await ensureSlot({
      baseName: p4.shadoBase,
      repoId: repo.id,
      repoPath: opts.repoPath,
      worktreePath: opts.worktreePath,
    });
    // Per-slot P4 client + flush to the base changelist (0-byte), locked to
    // this host so P4V lists it.
    await ensureClient({
      ctx: { port: p4.port, user: p4.user, client: opts.parkBranch },
      root: opts.worktreePath,
      depotPath: p4.depotPath,
      baseChangelist: p4.baseChangelist,
      host: hostname(),
    });
    writeSlotMeta(opts.worktreePath, {
      depotPath: p4.depotPath,
      mainClient: p4.mainClient,
      baseChangelist: p4.baseChangelist,
    });
    startSlotWatch(opts.worktreePath, this.spamIgnoreRels(opts.worktreePath));
  }

  /** Perforce has no branches; a freshly-allocated slot is reset to a clean
   *  base (revert opened, re-anchor have-list at the base changelist). */
  async checkoutBranch(opts: CheckoutBranchOpts): Promise<void> {
    const ctx = this.ctx(opts.worktreePath);
    const meta = readSlotMeta(opts.worktreePath);
    // revertAll + sync below rewrite many files on disk. PAUSE the slot watcher
    // first (ensure it exists, then pause) so those PopBot-driven writes aren't
    // recorded as agent edits and `p4 edit`-ed — that bug opened the ENTIRE
    // depot for edit (thousands of "M" files in a fresh slot). The watcher's
    // `clearSlotChanges` alone is insufficient: ReadDirectoryChangesW delivers
    // events asynchronously, so writes recorded AFTER a clear still leak.
    startSlotWatch(opts.worktreePath, this.spamIgnoreRels(opts.worktreePath));
    pauseSlotWatch(opts.worktreePath);
    try {
      await revertAll(ctx, opts.worktreePath);
      // Drop the prior chat's (now reverted / empty) changelist.
      if (meta?.changelist) await deleteChangelist(ctx, meta.changelist);
      if (meta) {
        await flushTo(ctx, meta.depotPath, meta.baseChangelist);
        // A new chat starts from the LATEST changelist — flushing re-anchors the
        // have-list at the warm frozen base, then sync transfers only the
        // base→head delta (the warm-slot payoff).
        await syncLatest(ctx, opts.worktreePath, meta.depotPath);
      }
      // The chat's named pending changelist (its git-branch analog) — the slot
      // watcher opens edits into it; commit submits it.
      const cl = await createChangelist(ctx, opts.branch);
      if (meta) {
        writeSlotMeta(opts.worktreePath, {
          ...meta,
          changelist: cl || undefined,
          changelistName: opts.branch,
        });
      }
    } finally {
      // Forget everything recorded so far, then resume after a delay so any
      // in-flight fs events from the sync drain WHILE STILL PAUSED (dropped),
      // and clear once more at resume in case one lands right on the boundary.
      clearSlotChanges(opts.worktreePath);
      const wt = opts.worktreePath;
      setTimeout(() => {
        clearSlotChanges(wt);
        resumeSlotWatch(wt);
      }, 1500);
    }
  }

  async worktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
    try {
      const ctx = this.ctx(worktreePath);
      await this.syncWatched(ctx, worktreePath);
      const { files } = await p4ListStatus(ctx, worktreePath);
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
    clearSlotChanges(opts.worktreePath);
    stopSlotWatch(opts.worktreePath);
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
    stopSlotWatch(opts.worktreePath);
    try {
      await deleteClient(this.ctx(opts.worktreePath));
    } catch {
      /* no client / config — fall through to shado teardown */
    }
    try {
      const { repo, p4 } = this.repoFor(opts.repoPath);
      await removeSlot({ baseName: p4.shadoBase, repoId: repo.id, repoPath: opts.repoPath, worktreePath: opts.worktreePath });
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

  /* ---------- cross-slot continuity ---------- */

  /** Connection to the per-repo ROOT client (owns chat WIP shelves). */
  private rootCtx(repoPath: string): { ctx: P4Context; depotPath: string } {
    const { repo, p4 } = this.repoFor(repoPath);
    return {
      ctx: { port: p4.port, user: p4.user, client: rootClientName(repo.id) },
      depotPath: p4.depotPath,
    };
  }

  /**
   * On close: re-home the slot's WIP to the ROOT client as a shelf (server-side
   * `reshelve` — no file transfer), then clear the slot. Returns the root shelf
   * changelist to persist on the chat (or null when there's nothing/discarded).
   */
  async persistChatOnClose(opts: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    discard: boolean;
    p4ShelfCl?: number | null;
  }): Promise<{ p4ShelfCl?: number | null }> {
    const wt = opts.worktreePath;
    let slotCtx: P4Context;
    try {
      slotCtx = this.ctx(wt);
    } catch {
      return { p4ShelfCl: opts.p4ShelfCl ?? null }; // slot never initialized
    }
    const { ctx: rootCtx, depotPath } = this.rootCtx(opts.repoPath);
    // Open any pending watcher edits into the named CL so they're captured.
    await this.syncWatched(slotCtx, wt).catch(() => undefined);
    const slotCl = readSlotMeta(wt)?.changelist;

    const dropRootShelf = async (): Promise<void> => {
      if (opts.p4ShelfCl) await deleteShelf(rootCtx, opts.repoPath, String(opts.p4ShelfCl)).catch(() => undefined);
    };

    // Discard, or nothing to keep → revert the slot + drop the parked shelf.
    if (opts.discard) {
      await revertAll(slotCtx, wt).catch(() => undefined);
      if (slotCl) await deleteChangelist(slotCtx, slotCl).catch(() => undefined);
      await dropRootShelf();
      return { p4ShelfCl: null };
    }
    if (!slotCl) return { p4ShelfCl: opts.p4ShelfCl ?? null };

    // Shelve the slot's pending CL; bail to discard-semantics if nothing shelved.
    const shelved = await p4exec(slotCtx, ['shelve', '-c', String(slotCl)], { cwd: wt, tolerant: true });
    if (!/shelved/i.test(shelved.stdout + shelved.stderr)) {
      await revertAll(slotCtx, wt).catch(() => undefined);
      await deleteChangelist(slotCtx, slotCl).catch(() => undefined);
      await dropRootShelf();
      return { p4ShelfCl: null };
    }

    // Re-home the shelf to the root client (reuse the chat's root CL if it has
    // one, else create it), then wipe the slot's shelf + opened files + CL.
    await ensureRootClient({ ctx: rootCtx, root: opts.repoPath, depotPath, host: hostname() });
    let rootCl = opts.p4ShelfCl ?? null;
    if (!rootCl) rootCl = await createChangelist(rootCtx, opts.branch);
    await reshelveInto(slotCtx, slotCl, rootCl);
    await p4exec(slotCtx, ['shelve', '-d', '-c', String(slotCl)], { cwd: wt, tolerant: true });
    await revertAll(slotCtx, wt).catch(() => undefined);
    await deleteChangelist(slotCtx, slotCl).catch(() => undefined);
    return { p4ShelfCl: rootCl };
  }

  /**
   * On reopen: unshelve the chat's parked ROOT shelf into this slot's fresh CL
   * (keeping the root copy as the backup). `checkoutBranch` already created the
   * clean slot CL. Returns the (unchanged) root shelf to keep persisting.
   */
  async restoreChatOnReopen(opts: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
    p4ShelfCl?: number | null;
  }): Promise<{ p4ShelfCl?: number | null }> {
    if (!opts.p4ShelfCl) return { p4ShelfCl: opts.p4ShelfCl ?? null };
    const wt = opts.worktreePath;
    let slotCtx: P4Context;
    try {
      slotCtx = this.ctx(wt);
    } catch {
      return { p4ShelfCl: opts.p4ShelfCl };
    }
    const slotCl = readSlotMeta(wt)?.changelist;
    if (!slotCl) return { p4ShelfCl: opts.p4ShelfCl };
    // unshelve writes files to the slot — pause the watcher so they aren't
    // recorded as agent edits (same reason the sync path pauses).
    pauseSlotWatch(wt);
    try {
      await unshelveInto(slotCtx, wt, opts.p4ShelfCl, slotCl);
    } finally {
      clearSlotChanges(wt);
      setTimeout(() => {
        clearSlotChanges(wt);
        resumeSlotWatch(wt);
      }, 1500);
    }
    return { p4ShelfCl: opts.p4ShelfCl };
  }
}

/**
 * IPC for repo management. The renderer's Preferences "Repos" section
 * uses these handlers to list / create / update / delete the rows in
 * the `repos` table that back multi-repo support.
 *
 * Mode immutability: `repos:create` is the only path that writes
 * `mode`. `repos:update` deliberately omits it (matches the helper
 * contract in {@link upsertRepo}). Switching mode after chats exist
 * would orphan their worktrees, so the constraint is enforced in code
 * rather than requiring a UI guard alone.
 *
 * Delete is unconditional — the renderer is responsible for the
 * type-the-name confirm and the chat-count warning. That keeps this
 * file's contract dumb (just CRUD) and lets the UI evolve its
 * confirm-flow independently.
 */
import { existsSync } from 'node:fs';
import { ipcMain } from 'electron';
import {
  IpcChannel,
  type BasePreflightInfo,
  type BuildBaseInput,
  type BuildBaseResult,
  type CreateRepoInput,
  type RepoCreateResult,
  type RepoSlotStepResult,
  type RepoUpdateResult,
  type UpdateRepoInput,
} from '@shared/ipc';
import {
  countChatsForRepo,
  deleteRepo,
  getRepo,
  listRepos,
  setRepoSlotCount,
  upsertRepo,
} from '../persistence/repos';
import { listSlotOccupantsForRepo } from '../persistence/chats';
import { slotWorktreePathForRepo } from '../git/chatPaths';
import { getSourceControlProvider } from '../scm';
import { detectScm, p4WorkspaceInfo } from '../scm/detect';
import { basePreflight, buildBase, baseDiskUsage } from '../shado/base';
import { captureSyncedChangelist } from '../p4/workspace';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Normalize a repo path for equality: trim, unify separators, drop trailing
 *  slash, lowercase (Windows paths are case-insensitive; on macOS/Linux a repo
 *  added twice under different casing is still the same tree in practice). */
function normRepoPath(p: string): string {
  return p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function validateCreateInput(input: CreateRepoInput): string | null {
  if (!input.id || !ID_PATTERN.test(input.id)) {
    return 'Repo id must be lowercase alphanumeric with optional dashes (e.g. app, my-game-2).';
  }
  if (!input.repoPath?.trim()) return 'Repo path is required.';
  const isP4 = input.scm === 'perforce';
  // Perforce has no branch model — slots flush to the frozen base changelist,
  // so a default base branch is git-only. Perforce is always slot mode and
  // must carry the p4 config the base flow produced.
  if (!isP4 && !input.defaultBase?.trim()) return 'Default base branch is required.';
  if (isP4) {
    if (input.mode !== 'slots') return 'Perforce repos are always slot mode.';
    if (!input.p4) return 'Perforce repo requires a built base (connection + base changelist).';
    if (!input.p4.depotPath?.trim()) return 'Perforce depot path is required.';
    if (!input.p4.shadoBase?.trim()) return 'Perforce repo requires a frozen shado base.';
  } else if (input.mode !== 'slots' && input.mode !== 'ephemeral') {
    return 'Mode must be slots or ephemeral.';
  }
  if (input.slotCount < 1 || input.slotCount > 64) return 'Slot count must be 1–64.';
  return null;
}

export function registerReposHandlers(): void {
  ipcMain.handle(IpcChannel.ReposList, () => listRepos());

  ipcMain.handle(IpcChannel.ReposCreate, (_e, input: CreateRepoInput): RepoCreateResult => {
    const err = validateCreateInput(input);
    if (err) return { ok: false, reason: 'invalid', message: err };
    if (getRepo(input.id)) return { ok: false, reason: 'duplicate-id' };
    // Reject a folder already backing another repo — two repos over one tree
    // would collide on slots / the shado base.
    const want = normRepoPath(input.repoPath);
    const clash = listRepos().find((r) => normRepoPath(r.repoPath) === want);
    if (clash) return { ok: false, reason: 'duplicate-path', existingId: clash.id };
    const repo = upsertRepo({
      id: input.id.trim(),
      repoPath: input.repoPath.trim(),
      color: input.color.trim() || '#6b7cff',
      slotPrefix: input.slotPrefix.trim() || 'slot',
      defaultBase: input.defaultBase.trim(),
      slotCount: Math.floor(input.slotCount),
      mode: input.mode,
      scm: input.scm ?? 'git',
      ...(input.p4 ? { p4: input.p4 } : {}),
    });
    return { ok: true, repo };
  });

  ipcMain.handle(IpcChannel.ReposUpdate, (_e, input: UpdateRepoInput): RepoUpdateResult => {
    const existing = getRepo(input.id);
    if (!existing) return { ok: false, reason: 'not-found' };
    // Mode is intentionally not in the input shape — preserve the
    // existing value. Same for createdAt (which upsertRepo overwrites
    // via excluded.created_at, but only on the INSERT path).
    const repo = upsertRepo({
      id: existing.id,
      repoPath: input.repoPath.trim() || existing.repoPath,
      color: input.color.trim() || existing.color,
      slotPrefix: input.slotPrefix.trim() || existing.slotPrefix,
      defaultBase: input.defaultBase.trim() || existing.defaultBase,
      slotCount: Math.max(1, Math.floor(input.slotCount)),
      mode: existing.mode,
    });
    return { ok: true, repo };
  });

  ipcMain.handle(IpcChannel.ReposDelete, (_e, id: string): { ok: true } => {
    deleteRepo(id);
    return { ok: true };
  });

  ipcMain.handle(IpcChannel.ReposCountChats, (_e, id: string): number => countChatsForRepo(id));

  ipcMain.handle(IpcChannel.ReposDetectScm, (_e, folder: string) => detectScm(folder));

  ipcMain.handle(IpcChannel.ReposDetectP4Workspace, (_e, folder: string) => p4WorkspaceInfo(folder));

  /* ---------------- Perforce base-build flow ---------------- */

  ipcMain.handle(
    IpcChannel.ReposBasePreflight,
    (e, repoPath: string): Promise<BasePreflightInfo> =>
      basePreflight(repoPath, (msg) => e.sender.send(IpcChannel.ReposBaseProgress, msg)),
  );

  ipcMain.handle(
    IpcChannel.ReposBuildBase,
    async (e, input: BuildBaseInput): Promise<BuildBaseResult> => {
      const built = await buildBase(
        {
          repoPath: input.repoPath,
          repoId: input.repoId,
          baseName: input.baseName,
          sizeGb: input.sizeGb,
          slotPrefix: input.slotPrefix,
          slotCount: input.slotCount,
        },
        (msg) => e.sender.send(IpcChannel.ReposBaseProgress, msg),
      );
      if (!built.ok) return { ok: false, error: built.log };
      // The frozen base reflects the warm folder's synced state; capture the
      // changelist so every slot can `p4 flush @baseChangelist` (0-byte). Fall
      // back to the changelist the wizard already discovered from the
      // workspace (#have) when the server-side capture can't resolve it.
      let baseChangelist = 0;
      if (input.depotPath) {
        // Perforce only — git has no changelist to capture.
        try {
          baseChangelist = await captureSyncedChangelist(
            { port: input.port, user: input.user },
            input.repoPath,
            input.depotPath,
          );
        } catch {
          /* fall through to the discovered value */
        }
        if (baseChangelist <= 0) baseChangelist = input.baseChangelist ?? 0;
      }
      const du = await baseDiskUsage(input.repoPath, input.repoId, input.baseName);
      return { ok: true, baseChangelist, baseMb: du.baseMb, log: built.log };
    },
  );

  /* ---------------- Configure Slots flow ---------------- */

  ipcMain.handle(
    IpcChannel.ReposListSlotOccupants,
    (_e, repoId: string): Array<{ slotId: number; chatName: string }> => {
      const occupants = listSlotOccupantsForRepo(repoId);
      return Array.from(occupants.entries()).map(([slotId, o]) => ({
        slotId,
        chatName: o.chatName,
      }));
    },
  );

  ipcMain.handle(
    IpcChannel.ReposInitializeOneSlot,
    async (_e, repoId: string, slotId: number): Promise<RepoSlotStepResult> => {
      const repo = getRepo(repoId);
      if (!repo) return { ok: false, reason: 'repo-not-found' };
      if (repo.mode !== 'slots') return { ok: false, reason: 'wrong-mode' };
      const path = slotWorktreePathForRepo(repo, slotId);
      if (existsSync(path)) {
        return { ok: true, slotId, alreadyReady: true };
      }
      try {
        // Inside the try: getSourceControlProvider throws for unimplemented
        // SCM ids, and this handler must return a RepoSlotStepResult rather
        // than reject the IPC call.
        const scm = getSourceControlProvider(repo);
        await scm.ensureSlotWorktree({
          repoPath: repo.repoPath,
          worktreePath: path,
          parkBranch: scm.parkingBranch(repo.id, slotId),
          baseBranch: repo.defaultBase,
        });
        return { ok: true, slotId, alreadyReady: false };
      } catch (err) {
        return { ok: false, slotId, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.ReposDeleteOneSlot,
    async (_e, repoId: string, slotId: number): Promise<RepoSlotStepResult> => {
      const repo = getRepo(repoId);
      if (!repo) return { ok: false, reason: 'repo-not-found' };
      if (repo.mode !== 'slots') return { ok: false, reason: 'wrong-mode' };
      // Refuse if this slot is currently held by an open chat — the
      // renderer enforces a global gate before starting the loop, but
      // re-check here so a race (chat opens during the loop) doesn't
      // tear out a live worktree.
      const occupants = listSlotOccupantsForRepo(repoId);
      const here = occupants.get(slotId);
      if (here) return { ok: false, reason: 'slot-in-use', chatName: here.chatName };
      const path = slotWorktreePathForRepo(repo, slotId);
      try {
        // Inside the try: getSourceControlProvider throws for unimplemented
        // SCM ids, and this handler must return a RepoSlotStepResult rather
        // than reject the IPC call.
        const scm = getSourceControlProvider(repo);
        await scm.removeWorktree({ repoPath: repo.repoPath, worktreePath: path });
        await scm.deleteBranch(repo.repoPath, scm.parkingBranch(repo.id, slotId));
        return { ok: true, slotId };
      } catch (err) {
        return { ok: false, slotId, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.ReposSetSlotCount,
    (_e, id: string, n: number): { ok: true } | { ok: false; reason: 'not-found' } => {
      const existing = getRepo(id);
      if (!existing) return { ok: false, reason: 'not-found' };
      setRepoSlotCount(id, n);
      return { ok: true };
    },
  );
}

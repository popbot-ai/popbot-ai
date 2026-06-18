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
import {
  deleteBranch,
  ensureSlotWorktree,
  parkingBranch,
  removeWorktree,
} from '../git/worktrees';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function validateCreateInput(input: CreateRepoInput): string | null {
  if (!input.id || !ID_PATTERN.test(input.id)) {
    return 'Repo id must be lowercase alphanumeric with optional dashes (e.g. app, my-game-2).';
  }
  if (!input.repoPath?.trim()) return 'Repo path is required.';
  if (!input.defaultBase?.trim()) return 'Default base branch is required.';
  if (input.mode !== 'slots' && input.mode !== 'ephemeral') return 'Mode must be slots or ephemeral.';
  if (input.slotCount < 1 || input.slotCount > 64) return 'Slot count must be 1–64.';
  return null;
}

export function registerReposHandlers(): void {
  ipcMain.handle(IpcChannel.ReposList, () => listRepos());

  ipcMain.handle(IpcChannel.ReposCreate, (_e, input: CreateRepoInput): RepoCreateResult => {
    const err = validateCreateInput(input);
    if (err) return { ok: false, reason: 'invalid', message: err };
    if (getRepo(input.id)) return { ok: false, reason: 'duplicate-id' };
    const repo = upsertRepo({
      id: input.id.trim(),
      repoPath: input.repoPath.trim(),
      color: input.color.trim() || '#6b7cff',
      slotPrefix: input.slotPrefix.trim() || 'slot',
      defaultBase: input.defaultBase.trim(),
      slotCount: Math.floor(input.slotCount),
      mode: input.mode,
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
        await ensureSlotWorktree({
          repoPath: repo.repoPath,
          worktreePath: path,
          parkBranch: parkingBranch(repo.id, slotId),
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
        await removeWorktree({ repoPath: repo.repoPath, worktreePath: path });
        await deleteBranch(repo.repoPath, parkingBranch(repo.id, slotId));
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

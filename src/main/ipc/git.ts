/**
 * IPC handlers backing the right-side git sidebar. Every entrypoint
 * resolves chatId → worktreePath up front; the renderer never sees
 * paths so it can't accidentally drive ops on the wrong slot.
 */
import { ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { IpcChannel } from '@shared/ipc';
import type {
  GitCommitInput,
  GitCommitResult,
  GitDetectPrResult,
  GitDiffInput,
  GitDiffResultOrErr,
  GitFilesInCommitInput,
  GitFilesInCommitResult,
  GitRevertInput,
  GitRevertResult,
  GitStatusResultOrErr,
  GitBaseBranchesResult,
} from '@shared/git';
import { getChat } from '../persistence/chats';
import { backfillChatFields } from '../persistence/chatBackfill';
import { getRepo, listRepos } from '../persistence/repos';
import { getSetting } from '../persistence/settings';
import { worktreePathForChat } from '../git/chatPaths';
import {
  commitFiles,
  deriveGitUsername,
  detectPr,
  fileDiff,
  listFilesInCommit,
  listStatus,
  listBaseBranches,
  revertFiles,
} from '../git/files';

function resolveWorktree(chatId: string): string | { error: 'no-worktree' | 'not-a-git-repo' } {
  const chat = getChat(chatId);
  const wt = worktreePathForChat(chat);
  if (!wt) return { error: 'no-worktree' };
  if (!existsSync(wt)) return { error: 'no-worktree' };
  if (!existsSync(join(wt, '.git'))) return { error: 'not-a-git-repo' };
  return wt;
}

interface GitSettingsLite { repoPath?: string }

/**
 * For repo-scoped queries (e.g. "what base branches exist?") that
 * happen *before* a chat exists. Resolution order:
 *   1. `chatId` → the chat's worktree (in-chat git panel queries)
 *   2. `repoId` → the repo row's `repoPath` (new-chat dialog, multi-repo)
 *   3. legacy `settings.git.repoPath` fallback (single-repo install)
 */
function resolveRepoCwd(opts: { chatId?: string | null; repoId?: string | null }): string | { error: 'no-worktree' | 'not-a-git-repo' } {
  if (opts.chatId) {
    const wt = resolveWorktree(opts.chatId);
    if (typeof wt === 'string') return wt;
  }
  if (opts.repoId) {
    const repo = getRepo(opts.repoId);
    if (repo?.repoPath && existsSync(repo.repoPath)) return repo.repoPath;
  }
  // Prefer the multi-repo store (the "Add Repository" flow writes there),
  // then fall back to the legacy single-repo `git` setting. Without the
  // store fallback, a repo added via the new flow left the legacy setting
  // empty and git operations reported 'no-worktree'.
  for (const r of listRepos()) {
    if (r.repoPath && existsSync(r.repoPath)) return r.repoPath;
  }
  const s = getSetting<GitSettingsLite>('git');
  if (s?.repoPath && existsSync(s.repoPath)) return s.repoPath;
  return { error: 'no-worktree' };
}

export function registerGitHandlers(): void {
  ipcMain.handle(
    IpcChannel.GitStatus,
    async (_e, chatId: string): Promise<GitStatusResultOrErr> => {
      const wt = resolveWorktree(chatId);
      if (typeof wt !== 'string') return { ok: false, reason: wt.error };
      try {
        const r = await listStatus(wt);
        return { ok: true, ...r };
      } catch (err) {
        return { ok: false, reason: 'not-a-git-repo', error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.GitDiff,
    async (_e, input: GitDiffInput): Promise<GitDiffResultOrErr> => {
      const wt = resolveWorktree(input.chatId);
      if (typeof wt !== 'string') return { ok: false, error: wt.error };
      try {
        const r = await fileDiff(wt, input.scope, input.path);
        return { ok: true, ...r };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.GitCommit,
    async (_e, input: GitCommitInput): Promise<GitCommitResult> => {
      const wt = resolveWorktree(input.chatId);
      if (typeof wt !== 'string') return { ok: false, error: wt.error };
      try {
        const r = await commitFiles(wt, input.message, input.paths);
        return { ok: true, sha: r.sha };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.GitRevert,
    async (_e, input: GitRevertInput): Promise<GitRevertResult> => {
      const wt = resolveWorktree(input.chatId);
      if (typeof wt !== 'string') return { ok: false, error: wt.error };
      try {
        await revertFiles(wt, input.paths);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.GitListBaseBranches,
    async (
      _e,
      input: { chatId?: string | null; repoId?: string | null } | string | null,
    ): Promise<GitBaseBranchesResult> => {
      // Tolerant of the legacy `string | null` shape so a stale renderer
      // bundle (after an autoupdate) doesn't blow up — coerce to the
      // object form here.
      const opts = typeof input === 'object' && input !== null
        ? input
        : { chatId: input };
      const cwd = resolveRepoCwd(opts);
      if (typeof cwd !== 'string') return { ok: false, reason: cwd.error };
      try {
        const branches = await listBaseBranches(cwd);
        return { ok: true, branches };
      } catch (err) {
        return { ok: false, reason: 'error', error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IpcChannel.GitUsername, async (): Promise<string> => {
    // Explicit override in Source-control settings wins; otherwise derive
    // from gh/git. Global git config + gh are readable from anywhere, so
    // home is a safe cwd.
    const override = getSetting<{ username?: string }>('git')?.username?.trim();
    if (override) return override;
    return (await deriveGitUsername(homedir())) || 'pop';
  });

  ipcMain.handle(
    IpcChannel.GitDetectPr,
    async (_e, chatId: string): Promise<GitDetectPrResult> => {
      const chat = getChat(chatId);
      if (!chat) return { ok: false, reason: 'no-worktree' };

      // Backfill chat.pr from the title BEFORE looking up — handles
      // older CR chats that were created without the explicit pr
      // field (e.g. "[CR] PR #8123 · …"). Same for ticket id.
      const filled = backfillChatFields(chatId) ?? chat;

      // Slot-bound chats: `gh pr view` in the worktree picks up the
      // current branch's PR. CR / slot-less chats need an explicit
      // PR number; cwd falls back to the configured repo root.
      let cwd: string | null = worktreePathForChat(filled);
      let prNumber: number | undefined;
      if (cwd && existsSync(cwd) && existsSync(join(cwd, '.git'))) {
        // worktree path looks healthy; let `gh` resolve PR by branch
      } else {
        // Slot-less or worktree gone — fall back to repo root.
        cwd = getSetting<GitSettingsLite>('git')?.repoPath ?? null;
        if (!cwd) return { ok: false, reason: 'no-worktree' };
        prNumber = filled.pr ?? undefined;
        if (prNumber === undefined) {
          // Nothing to look up. Report as null PR (success), so the
          // chip layer cleanly hides instead of showing an error.
          return { ok: true, pr: null };
        }
      }

      const result = await detectPr(cwd, prNumber !== undefined ? { prNumber } : {});
      // Cross-link: if the resolved PR title mentions a Linear ticket
      // and the chat doesn't have one yet, fold it into the chat
      // record. Idempotent — only writes when ticket is currently null.
      if (result.ok && result.pr) {
        backfillChatFields(chatId, { prTitle: result.pr.title });
      }
      return result;
    },
  );

  ipcMain.handle(
    IpcChannel.GitFilesInCommit,
    async (_e, input: GitFilesInCommitInput): Promise<GitFilesInCommitResult> => {
      const wt = resolveWorktree(input.chatId);
      if (typeof wt !== 'string') return { ok: false, error: wt.error };
      try {
        const files = await listFilesInCommit(wt, input.sha);
        return { ok: true, files };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}

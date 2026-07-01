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
import type { P4ShelfItem } from '@shared/perforce';
import {
  clampMaxChangedFiles,
  type SourceControlSettings,
} from '@shared/persistence';
import { getChat } from '../persistence/chats';
import { backfillChatFields } from '../persistence/chatBackfill';
import { getRepo, listRepos } from '../persistence/repos';
import { getSetting } from '../persistence/settings';
import { worktreePathForChat } from '../git/chatPaths';
import { getSourceControlProvider, sourceControlIdFor } from '../scm';
import { p4Login } from '../p4/workspace';
import { ambientP4LoginStatus, ambientP4Login } from '../scm/detect';

/** The source-control provider backing a chat's repo (git today). */
function providerForChat(chatId: string) {
  const chat = getChat(chatId);
  return getSourceControlProvider(chat?.repoId ? getRepo(chat.repoId) : null);
}

function resolveWorktree(chatId: string): string | { error: 'no-worktree' | 'not-a-git-repo' } {
  const chat = getChat(chatId);
  const wt = worktreePathForChat(chat);
  if (!wt) return { error: 'no-worktree' };
  if (!existsSync(wt)) return { error: 'no-worktree' };
  // The `.git` sentinel only makes sense for git; a Perforce slot is a
  // shado clone with no `.git`. Gate the check on the repo's provider so
  // this handler is genuinely provider-agnostic.
  const scm = sourceControlIdFor(chat?.repoId ? getRepo(chat.repoId) : null);
  if (scm === 'git' && !existsSync(join(wt, '.git'))) return { error: 'not-a-git-repo' };
  return wt;
}

interface GitSettingsLite { repoPath?: string }

type RepoRow = ReturnType<typeof getRepo>;

/**
 * For repo-scoped queries (e.g. "what base branches exist?") that
 * happen *before* a chat exists. Resolution order:
 *   1. `chatId` → the chat's worktree (in-chat git panel queries)
 *   2. `repoId` → the repo row's `repoPath` (new-chat dialog, multi-repo)
 *   3. legacy `settings.git.repoPath` fallback (single-repo install)
 *
 * Returns the resolved `cwd` together with the repo row that owns it (or
 * null for the legacy fallback) so callers can pick the matching source-
 * control provider. Resolving cwd and provider separately risks driving
 * repo B's provider against repo A's path when both ids are supplied.
 */
function resolveRepoCwd(opts: { chatId?: string | null; repoId?: string | null }):
  | { cwd: string; repo: RepoRow }
  | { error: 'no-worktree' | 'not-a-git-repo' } {
  if (opts.chatId) {
    const wt = resolveWorktree(opts.chatId);
    if (typeof wt === 'string') {
      const repoId = getChat(opts.chatId)?.repoId;
      return { cwd: wt, repo: repoId ? getRepo(repoId) : null };
    }
  }
  if (opts.repoId) {
    const repo = getRepo(opts.repoId);
    if (repo?.repoPath && existsSync(repo.repoPath)) return { cwd: repo.repoPath, repo };
  }
  // Prefer the multi-repo store (the "Add Repository" flow writes there),
  // then fall back to the legacy single-repo `git` setting. Without the
  // store fallback, a repo added via the new flow left the legacy setting
  // empty and git operations reported 'no-worktree'.
  for (const r of listRepos()) {
    if (r.repoPath && existsSync(r.repoPath)) return { cwd: r.repoPath, repo: r };
  }
  const s = getSetting<GitSettingsLite>('git');
  if (s?.repoPath && existsSync(s.repoPath)) return { cwd: s.repoPath, repo: null };
  return { error: 'no-worktree' };
}

export function registerGitHandlers(): void {
  ipcMain.handle(
    IpcChannel.GitStatus,
    async (_e, chatId: string): Promise<GitStatusResultOrErr> => {
      const wt = resolveWorktree(chatId);
      if (typeof wt !== 'string') return { ok: false, reason: wt.error };
      try {
        const r = await providerForChat(chatId).listStatus(wt);
        // Cap the change list (provider-agnostic — git + Perforce). A slot
        // off a huge depot can open tens of thousands of files; rendering
        // them all would choke the panel. Surface the true total so the
        // panel can show "showing N of M".
        const cap = clampMaxChangedFiles(
          getSetting<SourceControlSettings>('sourceControl')?.maxChangedFiles,
        );
        if (r.files.length > cap) {
          return { ok: true, ...r, files: r.files.slice(0, cap), truncatedFrom: r.files.length };
        }
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
        const r = await providerForChat(input.chatId).fileDiff(wt, input.scope, input.path);
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
        const r = await providerForChat(input.chatId).commitFiles(wt, input.message, input.paths);
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
        await providerForChat(input.chatId).revertFiles(wt, input.paths);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.GitShelve,
    async (_e, input: { chatId: string; paths: string[]; message?: string; keepWorking?: boolean }): Promise<{ ok: true; change: string } | { ok: false; error: string }> => {
      const wt = resolveWorktree(input.chatId);
      if (typeof wt !== 'string') return { ok: false, error: wt.error };
      try {
        const r = await providerForChat(input.chatId).shelveFiles(wt, input.paths, input.message ?? 'popbot shelf', input.keepWorking);
        return { ok: true, change: r.change };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  /** Perforce: mint a login ticket from a password typed into the in-app login
   *  prompt (shown when a p4 op fails with an auth error). Password transits
   *  only this call's stdin — never stored. */
  ipcMain.handle(
    IpcChannel.P4Login,
    async (_e, input: { chatId: string; password: string }): Promise<{ ok: boolean; error?: string }> => {
      const chat = getChat(input.chatId);
      const repo = chat?.repoId ? getRepo(chat.repoId) : null;
      if (repo?.scm !== 'perforce' || !repo.p4) return { ok: false, error: 'Not a Perforce chat.' };
      return p4Login({ port: repo.p4.port, user: repo.p4.user }, input.password);
    },
  );

  /** Perforce: ambient login status (machine `p4 set` connection, no repo) —
   *  used at startup and before Add-Repository folder detection so an expired
   *  session doesn't make a real P4 workspace read as "not Perforce". */
  ipcMain.handle(IpcChannel.P4LoginStatus, () => ambientP4LoginStatus());

  /** Perforce: log in the ambient connection from a typed password. */
  ipcMain.handle(
    IpcChannel.P4LoginAmbient,
    (_e, input: { password: string }): Promise<{ ok: boolean; error?: string }> =>
      ambientP4Login(input.password),
  );

  /** Perforce: act on an auto-muted spam folder for a chat's slot. */
  ipcMain.handle(
    IpcChannel.P4SpamAction,
    async (
      _e,
      input: { chatId: string; path: string; action: 'p4ignore' | 'prefs' | 'session' | 'reconcile' },
    ): Promise<{ ok: boolean }> => {
      const wt = resolveWorktree(input.chatId);
      if (typeof wt !== 'string') return { ok: false };
      const prov = providerForChat(input.chatId) as {
        spamAction?: (wt: string, path: string, action: string) => Promise<void>;
      };
      await prov.spamAction?.(wt, input.path, input.action).catch(() => {});
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannel.GitUnshelve,
    async (_e, input: { chatId: string; items: P4ShelfItem[] }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const wt = resolveWorktree(input.chatId);
      if (typeof wt !== 'string') return { ok: false, error: wt.error };
      try {
        await providerForChat(input.chatId).unshelve(wt, input.items);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.GitDeleteShelf,
    async (_e, input: { chatId: string; items: P4ShelfItem[] }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const wt = resolveWorktree(input.chatId);
      if (typeof wt !== 'string') return { ok: false, error: wt.error };
      try {
        await providerForChat(input.chatId).deleteShelf(wt, input.items);
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
      const resolved = resolveRepoCwd(opts);
      if ('error' in resolved) return { ok: false, reason: resolved.error };
      // Provider selection follows the SAME repo that owns `cwd`, so we
      // never list branches with one repo's provider against another
      // repo's path.
      const { cwd, repo } = resolved;
      try {
        const branches = await getSourceControlProvider(repo).listBaseBranches(cwd);
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
    return (await getSourceControlProvider().deriveUsername(homedir())) || 'pop';
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

      const result = await getSourceControlProvider(
        filled.repoId ? getRepo(filled.repoId) : null,
      ).detectPr(cwd, prNumber !== undefined ? { prNumber } : {});
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
        const files = await providerForChat(input.chatId).listFilesInCommit(wt, input.sha);
        return { ok: true, files };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}

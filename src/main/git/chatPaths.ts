/**
 * Derived worktree path for a chat — not stored in the DB.
 *
 * The chat's identity is `(id, branch)`; the slot it occupies is
 * transient (a chat may park, close, and reopen in a different slot).
 * Storing `worktreePath` per chat would freeze it to the slot the chat
 * was first allocated to, then go stale when the slot reassigns or the
 * settings layout changes. Instead we compute it on demand:
 *
 *   `<worktreesDir>/<slotPrefix>-<chat.slotId>`
 *
 * where `worktreesDir` defaults to `~/popbot/workspaces/<repoName>` and
 * is overridable in Preferences > Source control.
 *
 * Returns null for chats without a slot (CR / slot-less chats use the
 * repo root as their cwd — that fallback lives in each consumer).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChatRecord, RepoRecord } from '@shared/persistence';
import { getSetting } from '../persistence/settings';
import { getRepo } from '../persistence/repos';
import { popbotRootForRepo } from '../shado/client';

interface GitSettingsView {
  repoPath?: string;
  repoName?: string;
  slotPrefix?: string;
  worktreesDir?: string;
}

interface ResolvedGitPaths {
  /** Slot worktree root: `<worktreesDir>/<slotPrefix>-N` is its child. */
  worktreesDir: string;
  /** Folder + parking-branch prefix per slot. */
  slotPrefix: string;
}

/** Resolve the live `worktreesDir` + `slotPrefix` from settings. The
 *  defaults match the on-disk layout enforced elsewhere. */
function resolvePaths(): ResolvedGitPaths | null {
  const s = getSetting<GitSettingsView>('git');
  if (!s?.repoPath) return null;
  const repoName = (s.repoName?.trim()
    || basename(s.repoPath).toLowerCase()
    || 'app');
  return {
    worktreesDir: s.worktreesDir || join(homedir(), 'popbot', 'workspaces', repoName),
    slotPrefix: s.slotPrefix?.trim() || 'slot',
  };
}

/**
 * Live worktree path for a chat — repo-aware.
 *
 *  - Slot-backed chat: derive from the chat's actual repo (via
 *    `repoId`), so multi-repo installs land each chat in its own
 *    `<worktreesDir>/<slotPrefix>-N` instead of all funneling into the
 *    legacy single-repo folder.
 *  - Ephemeral chat: the stored `worktreePath` IS the canonical path
 *    (it's the slug we picked at create time and the only place this
 *    lives). Hand it back unchanged.
 *  - Slot-less, no worktree (CR / Slack chats): null. The caller
 *    decides what repo root to substitute as cwd.
 *
 * Pre-multi-repo callers passed `Pick<…, 'slotId'>` only — the new
 * repoId/worktreePath fields fall through to the legacy
 * `resolvePaths()` (single-repo-only) when missing, so pre-migration
 * code paths still resolve.
 */
export function worktreePathForChat(
  chat: Pick<ChatRecord, 'slotId' | 'repoId' | 'worktreePath'> | Pick<ChatRecord, 'slotId'> | null | undefined,
): string | null {
  if (!chat) return null;
  if (chat.slotId != null) {
    // Prefer the chat's repo when we have it.
    const repoId = (chat as Pick<ChatRecord, 'repoId'>).repoId;
    const repo = repoId ? getRepo(repoId) : null;
    if (repo) return slotWorktreePathForRepo(repo, chat.slotId);
    // Legacy fallback for pre-migration code paths / orphaned chats
    // whose repo row was deleted.
    const paths = resolvePaths();
    if (!paths) return null;
    return join(paths.worktreesDir, `${paths.slotPrefix}-${chat.slotId}`);
  }
  // Ephemeral path — chat.worktreePath was set under the per-repo
  // resolver at create/reopen time.
  const stored = (chat as Pick<ChatRecord, 'worktreePath'>).worktreePath;
  if (stored && stored.length > 0) return stored;
  return null;
}

/**
 * Apply a Perforce repo's configured `agentCwd` subpath to a resolved base cwd
 * (slot worktree root, or repo root for slot-less CR chats). Perforce maps the
 * depot under a subfolder of the mount root, so the agent starts in that subdir
 * so repo-committed `.claude/skills` are at the cwd (Claude only auto-loads
 * skills at the cwd + ancestors, never child folders). This is the AGENT cwd
 * only — p4 operations keep using the mount root via {@link worktreePathForChat}
 * (that's where `.p4config` lives).
 *
 * Falls back to `baseCwd` when the repo isn't Perforce, has no `agentCwd`, or
 * the subpath doesn't exist on disk — so a stray config can't brick every spawn.
 * MUST be applied at EVERY agent/session cwd site (spawn, resume, recover,
 * pin-repair, validate) so the SDK's per-cwd session store stays consistent.
 */
export function applyPerforceAgentCwd(
  baseCwd: string | null,
  chat: Pick<ChatRecord, 'repoId'> | null | undefined,
): string | null {
  if (!baseCwd) return baseCwd;
  const repo = chat?.repoId ? getRepo(chat.repoId) : null;
  if (repo?.scm !== 'perforce' || !repo.p4) return baseCwd;
  // `agentCwd` is a path relative to the mount root; `/` (or blank/undefined)
  // means the mount root itself. Strip surrounding slashes → subpath segments.
  const sub = (repo.p4.agentCwd ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!sub) return baseCwd;
  const resolved = join(baseCwd, sub);
  return existsSync(resolved) ? resolved : baseCwd;
}

/** Path for a given slot id directly, without a chat record. Used by
 *  slot-allocation / initialization paths where the slot exists but
 *  no chat is yet attached. */
export function worktreePathForSlot(slotId: number): string | null {
  const paths = resolvePaths();
  if (!paths) return null;
  return join(paths.worktreesDir, `${paths.slotPrefix}-${slotId}`);
}

/** Worktrees directory for a specific repo. Convention:
 *
 *    `~/popbot/workspaces/<repo.id>`
 *
 *  For the legacy seeded single-repo install, prefer the user's existing
 *  `settings.git.worktreesDir` override if present so already-allocated
 *  slot worktrees aren't stranded by the multi-repo migration. New
 *  repos go straight to the home convention with no override knob. */
export function worktreesDirForRepo(repo: Pick<RepoRecord, 'id' | 'repoPath'>): string {
  const s = getSetting<GitSettingsView>('git');
  if (s?.worktreesDir && s.worktreesDir.trim().length > 0) {
    // Legacy single-repo install: settings.git.worktreesDir was the
    // per-install override. Honor it for the seed repo so existing
    // slot folders keep working without re-init.
    const legacyName = (s.repoName?.trim()
      || (s.repoPath ? basename(s.repoPath).toLowerCase() : '')
      || 'app');
    if (repo.id === legacyName) return s.worktreesDir;
  }
  // Slots MUST live on the source repo's drive — the shado differencing-VHDX
  // same-drive invariant, and the user's rule. popbotRootForRepo mirrors
  // ~/popbot onto the repo's drive, so a C: repo is unchanged and a D: repo's
  // slots land under D:\…\popbot\workspaces (alongside the base under
  // D:\…\popbot\shado), keeping mount + base co-driven.
  return join(popbotRootForRepo(repo.repoPath), 'workspaces', repo.id);
}

/** Slot worktree path for a specific repo + slot id. The
 *  parent-directory layout is `<worktreesDirForRepo>/<repo.slotPrefix>-N`. */
export function slotWorktreePathForRepo(
  repo: Pick<RepoRecord, 'id' | 'slotPrefix' | 'repoPath'>,
  slotId: number,
): string {
  return join(worktreesDirForRepo(repo), `${repo.slotPrefix}-${slotId}`);
}

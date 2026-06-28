import { ipcMain } from 'electron';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  IpcChannel,
  type CloseChatOptions,
  type ClosePrepResult,
  type CreateChatInput,
  type CreateChatResult,
  type DeleteAllSlotsResult,
  type InitializeSlotsResult,
  type ListSlotsResultOrErr,
  type ReopenChatResult,
  type SlotInfo,
  type SlotInitResult,
} from '@shared/ipc';
import {
  allocateSlotPreferring,
  closeChat,
  createChat,
  deleteChat,
  getChat,
  listClosedChats,
  listOpenChats,
  listSlotOccupants,
  reopenChat,
  searchChats,
  setChatSlot,
  setChatWorktree,
  setChatP4Shelf,
} from '../persistence/chats';
import { listMessages } from '../persistence/messages';
import { getSetting, setSetting } from '../persistence/settings';
import { AgentHost } from '../agents/AgentHost';
import { dlog } from '../diagLog';
import { dispose as disposePty } from '../term/ptyManager';
import { GitWorktreeError, getSourceControlProvider } from '../scm';
import type { SourceControlProvider } from '../scm';
import { getRepo, listRepos } from '../persistence/repos';
import { slotWorktreePathForRepo, worktreesDirForRepo } from '../git/chatPaths';
import { remountSlots, remountReposElevated } from '../shado/base';
import type { RepoRecord } from '@shared/persistence';

/** After a reboot, Windows drops the VHDX slot mounts. A dropped mount leaves
 *  the slot folder either EMPTY or as a BROKEN mount point (reading it errors).
 *  Detect either and re-attach ALL of the repo's shado clones via one elevated
 *  `shado remount` before allocating — otherwise the next slot op fails on the
 *  dead mount. No-op for non-slot repos, off-Windows, or slots already up. */
async function ensureSlotsMounted(repo: RepoRecord): Promise<void> {
  if (repo.mode !== 'slots' || process.platform !== 'win32') return;
  const baseName = repo.scm === 'perforce' ? repo.p4?.shadoBase : repo.id;
  if (!baseName) return;
  let unmounted = false;
  for (let i = 1; i <= repo.slotCount; i += 1) {
    const p = slotWorktreePathForRepo(repo, i);
    let populated = false;
    try {
      // A mounted slot lists the base's files. NOTE: a BROKEN mount-point
      // folder (its VHDX detached on reboot) throws "could not find a part of
      // the path" (ENOENT) — same code as a never-created slot — so we can't
      // special-case ENOENT. Any non-populated slot (empty, missing, or broken)
      // is treated as needing remount; `shado remount` no-ops registry clones
      // that are already up and ignores ones that don't exist.
      populated = readdirSync(p).length > 0;
    } catch {
      populated = false;
    }
    if (!populated) { unmounted = true; break; }
  }
  if (!unmounted) return;
  dlog('chat.create.remountSlots', { repoId: repo.id, scm: repo.scm ?? 'git', baseName });
  const res = await remountSlots({ repoPath: repo.repoPath, repoId: repo.id, baseName });
  if (!res.ok) throw new Error(res.log);
}

/** Detect slot repos whose VHDX clones are DISCONNECTED — a reboot drops every
 *  mount, leaving slot folders empty or as broken mount points (which error on
 *  read). Non-elevated + cheap; drives the renderer's "Reconnect" banner. */
export function listDisconnectedSlotRepos(): Array<{ repoPath: string; repoId: string; baseName: string }> {
  if (process.platform !== 'win32') return [];
  const need: Array<{ repoPath: string; repoId: string; baseName: string }> = [];
  for (const repo of listRepos()) {
    if (repo.mode !== 'slots') continue;
    const baseName = repo.scm === 'perforce' ? repo.p4?.shadoBase : repo.id;
    if (!baseName) continue;
    let disconnected = false;
    for (let i = 1; i <= repo.slotCount; i += 1) {
      let populated = false;
      try {
        populated = readdirSync(slotWorktreePathForRepo(repo, i)).length > 0;
      } catch {
        populated = false; // missing or broken mount-point folder
      }
      if (!populated) { disconnected = true; break; }
    }
    if (disconnected) need.push({ repoPath: repo.repoPath, repoId: repo.id, baseName });
  }
  return need;
}

/** USER-TRIGGERED (the "Reconnect" button): re-attach every disconnected slot
 *  repo's clones in ONE elevated batch — one UAC, which the user clearly
 *  initiated. No-op when nothing's disconnected. */
export async function reconnectSlots(): Promise<{ ok: boolean; error?: string }> {
  const need = listDisconnectedSlotRepos();
  if (!need.length) return { ok: true };
  dlog('repos.reconnectSlots', { repos: need.map((r) => r.repoId) });
  const res = await remountReposElevated(need);
  if (!res.ok) {
    dlog('repos.reconnectSlots.failed', { error: res.log });
    return { ok: false, error: res.log };
  }
  return { ok: true };
}

interface SlotsSettings { maxCount?: number }
interface GitSettings {
  repoPath?: string;
  /** Short, filesystem-safe repo identifier. Used as the parent
   *  segment of slot worktree paths (`<workspaces>/<repoName>/slot-N`),
   *  the prefix on git parking branches (`<repoName>/slotN`), and the
   *  short label in any UI that needs to identify the repo. Defaults
   *  to `app`. Future multi-repo work hangs off this. */
  repoName?: string;
  /** Accent color for this repo. Used as the background tint on slot
   *  pills (S1, S2, …) so chats from different repos read at a glance.
   *  Any CSS color string — hex, rgb(), oklch(), etc. Defaults to the
   *  app's Apple-blue accent. */
  repoColor?: string;
  /** Per-slot folder/branch prefix. Slot worktrees become
   *  `<workspaces>/<repoName>/<slotPrefix>-N`; parking branches become
   *  `<repoName>/<slotPrefix>N`. Defaults to `slot`. Lets multi-repo
   *  installs use distinct prefixes (e.g. `app`-prefixed slots
   *  alongside `widgets`-prefixed slots) without name collisions. */
  slotPrefix?: string;
  worktreesDir?: string;
  defaultBase?: string;
}

function readSlotsSettings(): { maxCount: number } | null {
  const s = getSetting<SlotsSettings>('slots');
  const n = s?.maxCount;
  if (typeof n !== 'number' || n < 1) return null;
  return { maxCount: Math.floor(n) };
}

function readGitSettings(): {
  repoPath: string;
  repoName: string;
  repoColor: string | null;
  slotPrefix: string;
  worktreesDir: string;
  defaultBase: string;
} | null {
  const s = getSetting<GitSettings>('git');
  if (!s?.repoPath || !s.defaultBase) return null;
  // Prefer the explicitly-configured repoName. Fall back to the path
  // basename (lowercased, trailing slash stripped) so existing installs
  // keep working until the user opens Preferences and confirms. Final
  // fallback `app` matches the current sole-repo default.
  const repoName = (s.repoName?.trim()
    || basename(s.repoPath).toLowerCase()
    || 'app');
  const slotPrefix = s.slotPrefix?.trim() || 'slot';
  return {
    repoPath: s.repoPath,
    repoName,
    repoColor: s.repoColor?.trim() || null,
    slotPrefix,
    // Default to a discoverable path in $HOME so the user can `cd` into
    // it from a normal shell without going hunting in Application Support.
    // Layout: `<home>/popbot/workspaces/<repoName>/<slotPrefix>-N`.
    // The repo segment + configurable prefix prepare us for multi-repo
    // support — for now it's just `app/slot-N` but the path shape
    // accommodates a future widgets-N alongside app-N without
    // colliding.
    worktreesDir: s.worktreesDir || join(homedir(), 'popbot', 'workspaces', repoName),
    defaultBase: s.defaultBase,
  };
}

function slotPathFor(worktreesDir: string, slotPrefix: string, slotId: number): string {
  return join(worktreesDir, `${slotPrefix}-${slotId}`);
}

/** Resolve the repo a chat (or chat-create input) lives in. Defaults
 *  to 'app' so legacy callers + pre-multi-repo installs keep
 *  working unchanged. Returns null if the repo row was deleted (chat
 *  is detached — caller must surface that). */
function resolveRepo(repoId?: string | null): RepoRecord | null {
  return getRepo(repoId?.trim() || 'app');
}

/** Pick an ephemeral worktree path under the repo's worktreesDir. If
 *  the preferred slug is taken, suffix with the chat-id tail to
 *  guarantee uniqueness. Pure path resolution — does not touch disk
 *  beyond an `existsSync` check. */
function ephemeralPathFor(opts: {
  scm: SourceControlProvider;
  worktreesDir: string;
  ticket: string | null;
  pr: number | null;
  chatId: string;
}): string {
  const slug = opts.scm.ephemeralWorktreeSlug({
    ticket: opts.ticket,
    pr: opts.pr,
    chatId: opts.chatId,
  });
  const preferred = join(opts.worktreesDir, slug);
  if (!existsSync(preferred)) return preferred;
  // Slug collision (rare — same ticket reused, or PR repeated). Fall
  // through to a chat-id-suffixed path so we never clobber an existing
  // worktree on disk.
  const tail = opts.chatId.replace(/^chat_/, '').slice(-8);
  return join(opts.worktreesDir, `${slug}-${tail}`);
}

export function registerChatHandlers(): void {
  // Disconnected-slot detection + the user-clicked "Reconnect" (elevated).
  ipcMain.handle(IpcChannel.ReposDisconnectedSlots, (): string[] =>
    listDisconnectedSlotRepos().map((r) => r.repoId),
  );
  ipcMain.handle(IpcChannel.ReposReconnectSlots, () => reconnectSlots());

  ipcMain.handle(IpcChannel.ChatsList, () => listOpenChats());
  ipcMain.handle(IpcChannel.ChatsListClosed, (_e, limit?: number) => listClosedChats(limit));

  ipcMain.handle(IpcChannel.ChatsListSlots, (): ListSlotsResultOrErr => {
    const slotsCfg = readSlotsSettings();
    if (!slotsCfg) return { ok: false, reason: 'slots-not-configured' };
    const gitCfg = readGitSettings();
    const occupants = listSlotOccupants();
    const slots: SlotInfo[] = [];
    for (let i = 1; i <= slotsCfg.maxCount; i++) {
      const ready = gitCfg ? existsSync(slotPathFor(gitCfg.worktreesDir, gitCfg.slotPrefix, i)) : false;
      slots.push({ slotId: i, ready, occupant: occupants.get(i) ?? null });
    }
    return { ok: true, maxCount: slotsCfg.maxCount, slots };
  });

  /** Eagerly create all slot worktrees on their parking branches —
   *  the "set up everything now" button in Preferences. Idempotent;
   *  slots that already exist are reported as alreadyReady. */
  ipcMain.handle(
    IpcChannel.ChatsInitializeSlots,
    async (): Promise<InitializeSlotsResult> => {
      const slotsCfg = readSlotsSettings();
      if (!slotsCfg) return { ok: false, reason: 'slots-not-configured' };
      const gitCfg = readGitSettings();
      if (!gitCfg) return { ok: false, reason: 'git-not-configured' };

      const results: SlotInitResult[] = [];
      const scm = getSourceControlProvider();
      for (let i = 1; i <= slotsCfg.maxCount; i++) {
        const path = slotPathFor(gitCfg.worktreesDir, gitCfg.slotPrefix, i);
        const alreadyReady = existsSync(path);
        if (alreadyReady) {
          results.push({ slotId: i, alreadyReady: true, ok: true });
          continue;
        }
        try {
          await scm.ensureSlotWorktree({
            repoPath: gitCfg.repoPath,
            worktreePath: path,
            parkBranch: scm.parkingBranch(gitCfg.repoName, i),
            baseBranch: gitCfg.defaultBase,
          });
          results.push({ slotId: i, alreadyReady: false, ok: true });
        } catch (err) {
          results.push({
            slotId: i,
            alreadyReady: false,
            ok: false,
            error: (err as Error).message,
          });
        }
      }
      return { ok: true, results };
    },
  );

  ipcMain.handle(IpcChannel.ChatsCreate, async (_e, input: CreateChatInput): Promise<CreateChatResult> => {
    const wantsWorkspace = input.slotId != null || input.allocateSlot === true;

    // No workspace requested → cheap path. Used by lite chats that run
    // against the repo root and never need a worktree (e.g. CR chats).
    if (!wantsWorkspace) {
      const chat = createChat({
        name: input.name,
        ticket: input.ticket ?? null,
        pr: input.pr ?? null,
        branch: input.branch ?? null,
        type: input.type ?? 'lite',
        slotId: null,
        worktreePath: null,
        repoId: input.repoId,
        agent: input.agent,
        claudeModel: input.claudeModel,
        claudeReasoningEffort: input.claudeReasoningEffort,
        codexModel: input.codexModel,
        codexReasoningEffort: input.codexReasoningEffort,
      });
      if (input.baseBranch?.trim()) {
        const blob = (getSetting<Record<string, string>>('git.baseBranchByChat') ?? {});
        blob[chat.id] = input.baseBranch.trim();
        setSetting('git.baseBranchByChat', blob);
      }
      return { ok: true, chat };
    }

    // Workspace requested → resolve repo first; mode determines whether
    // we allocate a slot from the pool or spin up an ephemeral worktree.
    const repo = resolveRepo(input.repoId);
    if (!repo) return { ok: false, reason: 'git-not-configured' };
    const scm = getSourceControlProvider(repo);
    // The repo record is the source of truth (repoPath, defaultBase,
    // slotCount). The legacy single-repo `settings.git` is only a
    // fallback for pre-multi-repo installs — NOT required. A valid repo
    // + git/gh is enough; don't force the user into Source-control prefs.
    const gitCfg = readGitSettings();
    const branch = input.branch?.trim() || `popbot/chat-${Date.now()}`;
    const baseBranch = input.baseBranch?.trim() || repo.defaultBase || gitCfg?.defaultBase || 'main';

    if (repo.mode === 'ephemeral') {
      // Ephemeral (throwaway-per-chat) worktrees are a git-style notion;
      // providers whose working copies are heavyweight + long-lived
      // (Perforce) opt out via capabilities. Refuse rather than silently
      // mis-provisioning. Git always supports it, so this is a no-op
      // today and the seam for when non-git repos can be created.
      if (!scm.capabilities.supportsEphemeralRepos) {
        return {
          ok: false,
          reason: 'worktree-failed',
          message: `${scm.id} repos don't support ephemeral worktrees`,
        };
      }
      // input.slotId is meaningless in ephemeral mode — the renderer
      // shouldn't pass it for ephemeral repos, but if it does we just
      // ignore it rather than error (the user got a workspace either way).
      const chat = createChat({
        name: input.name,
        ticket: input.ticket ?? null,
        pr: input.pr ?? null,
        branch,
        type: input.type ?? 'lite',
        slotId: null,
        worktreePath: null,
        repoId: repo.id,
        agent: input.agent,
        claudeModel: input.claudeModel,
        claudeReasoningEffort: input.claudeReasoningEffort,
        codexModel: input.codexModel,
        codexReasoningEffort: input.codexReasoningEffort,
      });
      const worktreePath = ephemeralPathFor({
        scm,
        // Per-repo workspace dir, NOT the legacy `gitCfg.worktreesDir`
        // (which is scoped to the default seed repo). Without this,
        // ephemeral chats for a non-default repo were getting checked
        // out under the default repo's workspace dir and the agent's
        // cwd ended up in the wrong repo.
        worktreesDir: worktreesDirForRepo(repo),
        ticket: input.ticket ?? null,
        pr: input.pr ?? null,
        chatId: chat.id,
      });
      try {
        await scm.ensureChatWorktree({
          repoPath: repo.repoPath || gitCfg?.repoPath || '',
          worktreePath,
          branch,
          baseBranch,
        });
      } catch (err) {
        const msg = err instanceof GitWorktreeError ? err.message : (err as Error).message;
        return { ok: false, reason: 'worktree-failed', message: msg };
      }
      setChatWorktree(chat.id, worktreePath);
      if (input.baseBranch?.trim()) {
        const blob = (getSetting<Record<string, string>>('git.baseBranchByChat') ?? {});
        blob[chat.id] = input.baseBranch.trim();
        setSetting('git.baseBranchByChat', blob);
      }
      const updated = getChat(chat.id);
      return updated ? { ok: true, chat: updated } : { ok: false, reason: 'worktree-failed', message: 'Lost chat after create' };
    }

    // Slot-pool mode — original flow. Pool size comes from the repo's
    // own slotCount (set in the Add Repository wizard); fall back to the
    // legacy global slots setting only for pre-multi-repo installs.
    const maxSlots = repo.slotCount || readSlotsSettings()?.maxCount || 0;
    if (maxSlots < 1) return { ok: false, reason: 'slots-not-configured' };
    let slotId: number;
    if (input.slotId != null) {
      const taken = listSlotOccupants();
      if (taken.has(input.slotId)) {
        return { ok: false, reason: 'slot-taken', slotId: input.slotId };
      }
      slotId = input.slotId;
    } else {
      const picked = allocateSlotPreferring(maxSlots, null);
      if (picked === null) return { ok: false, reason: 'no-free-slot' };
      slotId = picked;
    }
    // Per-repo path + parking branch; the legacy default seed honors
    // `settings.git.worktreesDir` via `worktreesDirForRepo` so existing
    // slot worktrees keep working unchanged.
    const worktreePath = slotWorktreePathForRepo(repo, slotId);

    try {
      // Re-attach VHDX slot mounts if a reboot dropped them (one elevated
      // `shado remount`), before any slot op touches an empty mount.
      await ensureSlotsMounted(repo);
      await scm.ensureSlotWorktree({
        repoPath: repo.repoPath || gitCfg?.repoPath || '',
        worktreePath,
        parkBranch: scm.parkingBranch(repo.id, slotId),
        baseBranch: repo.defaultBase || gitCfg?.defaultBase || 'main',
      });
      await scm.refreshSlotForAllocation({ worktreePath, baseBranch });
      await scm.checkoutBranch({ worktreePath, branch, baseBranch });
    } catch (err) {
      const msg = err instanceof GitWorktreeError ? err.message : (err as Error).message;
      dlog('chat.create.worktreeFailed', {
        repoId: repo.id,
        scm: repo.scm ?? 'git',
        slotId,
        worktreePath,
        branch,
        baseBranch,
        error: msg,
        stack: (err as Error).stack,
      });
      return { ok: false, reason: 'worktree-failed', message: msg };
    }

    const chat = createChat({
      name: input.name,
      ticket: input.ticket ?? null,
      pr: input.pr ?? null,
      branch,
      type: input.type ?? 'lite',
      slotId,
      worktreePath,
      repoId: repo.id,
      agent: input.agent,
      claudeModel: input.claudeModel,
      claudeReasoningEffort: input.claudeReasoningEffort,
      codexModel: input.codexModel,
      codexReasoningEffort: input.codexReasoningEffort,
    });
    if (input.baseBranch?.trim()) {
      const blob = (getSetting<Record<string, string>>('git.baseBranchByChat') ?? {});
      blob[chat.id] = input.baseBranch.trim();
      setSetting('git.baseBranchByChat', blob);
    }
    return { ok: true, chat };
  });

  /** Initialize a single slot. Powers the renderer's progress panel,
   *  which loops 1..N and shows per-slot status. Idempotent. */
  ipcMain.handle(IpcChannel.ChatsInitializeOneSlot, async (_e, slotId: number) => {
    const slotsCfg = readSlotsSettings();
    if (!slotsCfg) return { ok: false, error: 'slots-not-configured' };
    if (slotId < 1 || slotId > slotsCfg.maxCount) {
      return { ok: false, error: `Slot ${slotId} out of range` };
    }
    const gitCfg = readGitSettings();
    if (!gitCfg) return { ok: false, error: 'git-not-configured' };
    const path = slotPathFor(gitCfg.worktreesDir, gitCfg.slotPrefix, slotId);
    if (existsSync(path)) {
      return { slotId, alreadyReady: true, ok: true };
    }
    const scm = getSourceControlProvider();
    try {
      await scm.ensureSlotWorktree({
        repoPath: gitCfg.repoPath,
        worktreePath: path,
        parkBranch: scm.parkingBranch(gitCfg.repoName, slotId),
        baseBranch: gitCfg.defaultBase,
      });
      return { slotId, alreadyReady: false, ok: true };
    } catch (err) {
      return { slotId, alreadyReady: false, ok: false, error: (err as Error).message };
    }
  });

  /** Tear down every slot worktree on disk + delete each parking
   *  branch. Refuses if any open chat is currently using a slot —
   *  caller must close those first. */
  ipcMain.handle(IpcChannel.ChatsDeleteAllSlots, async (): Promise<DeleteAllSlotsResult> => {
    const occupants = listSlotOccupants();
    if (occupants.size > 0) {
      return {
        ok: false,
        reason: 'slots-in-use',
        chatNames: [...occupants.values()].map((o) => o.chatName),
      };
    }
    const gitCfg = readGitSettings();
    if (!gitCfg) return { ok: false, reason: 'git-not-configured' };

    let removed = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(gitCfg.worktreesDir);
    } catch {
      // dir doesn't exist — nothing to do
      return { ok: true, removed: 0 };
    }
    const scm = getSourceControlProvider();
    // Match the configured slot prefix, not a hardcoded `slot-`; otherwise a
    // custom prefix leaves worktrees + parking branches behind while we
    // report success.
    const escapedPrefix = gitCfg.slotPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const slotDirPattern = new RegExp(`^${escapedPrefix}-(\\d+)$`);
    for (const name of entries) {
      const m = slotDirPattern.exec(name);
      if (!m) continue;
      const slotId = Number(m[1]);
      const path = join(gitCfg.worktreesDir, name);
      try {
        await scm.removeWorktree({ repoPath: gitCfg.repoPath, worktreePath: path });
        await scm.deleteBranch(gitCfg.repoPath, scm.parkingBranch(gitCfg.repoName, slotId));
        removed++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[slots] delete-all: ${path} failed: ${(err as Error).message}`);
      }
    }
    return { ok: true, removed };
  });

  /** Attach a slot + worktree to an already-open chat that doesn't
   *  have one yet (e.g. created before slots were configured). Same
   *  error shape as `chats:create` so the renderer routes errors the
   *  same way (no-free-slot → modal, slots-not-configured → prefs, …). */
  ipcMain.handle(IpcChannel.ChatsAttachSlot, async (_e, chatId: string): Promise<CreateChatResult> => {
    const chat = getChat(chatId);
    if (!chat) return { ok: false, reason: 'worktree-failed', message: 'Chat not found' };
    if (chat.slotId != null && chat.worktreePath) {
      return { ok: true, chat };
    }
    const slotsCfg = readSlotsSettings();
    if (!slotsCfg) return { ok: false, reason: 'slots-not-configured' };
    const repo = resolveRepo(chat.repoId);
    const gitCfg = readGitSettings();
    if (!repo || !gitCfg) return { ok: false, reason: 'git-not-configured' };
    const scm = getSourceControlProvider(repo);

    const slotId = allocateSlotPreferring(slotsCfg.maxCount, null);
    if (slotId === null) return { ok: false, reason: 'no-free-slot' };

    // Same per-repo path / parking branch / base resolution as the
    // create + reopen handlers — anything keyed off `gitCfg` directly
    // would route this attach into the default repo's slot pool.
    const worktreePath = slotWorktreePathForRepo(repo, slotId);
    const branch = chat.branch?.trim() || `popbot/chat-${chat.id}`;
    const baseBranch = repo.defaultBase || gitCfg.defaultBase;
    try {
      await ensureSlotsMounted(repo);
      await scm.ensureSlotWorktree({
        repoPath: repo.repoPath || gitCfg.repoPath,
        worktreePath,
        parkBranch: scm.parkingBranch(repo.id, slotId),
        baseBranch,
      });
      await scm.checkoutBranch({ worktreePath, branch, baseBranch });
    } catch (err) {
      const msg = err instanceof GitWorktreeError ? err.message : (err as Error).message;
      return { ok: false, reason: 'worktree-failed', message: msg };
    }

    setChatSlot(chatId, slotId, worktreePath);
    const updated = getChat(chatId);
    return updated ? { ok: true, chat: updated } : { ok: false, reason: 'worktree-failed', message: 'Lost chat after attach' };
  });

  ipcMain.handle(IpcChannel.ChatsClosePrep, async (_e, chatId: string): Promise<ClosePrepResult> => {
    const chat = getChat(chatId);
    if (!chat?.worktreePath) {
      return { hasWorktree: false, dirty: false, files: [], worktreePath: null };
    }
    const scm = getSourceControlProvider(resolveRepo(chat.repoId));
    const status = await scm.worktreeStatus(chat.worktreePath);
    return {
      hasWorktree: true,
      dirty: status.dirty,
      files: status.files.slice(0, 50),
      worktreePath: chat.worktreePath,
    };
  });

  ipcMain.handle(
    IpcChannel.ChatsClose,
    async (_e, chatId: string, opts?: CloseChatOptions) => {
      const chat = getChat(chatId);
      // Await SDK shutdown so its session JSONL flushes before any
      // worktree teardown below — otherwise the next reopen of this
      // chat lands on "no conversation found".
      await AgentHost.dispose(chatId);
      disposePty(chatId);

      // Slot-backed chat: park to its parking branch + leave the worktree
      // in place for the next slot allocation. Parking branch must be
      // namespaced by the chat's repo (`<repoId>/slot<N>`) — using the
      // legacy `gitCfg.repoName` here would route every repo's slot
      // back to the default repo's parking branches and corrupt them.
      if (chat?.slotId != null && chat.worktreePath) {
        const repo = resolveRepo(chat.repoId);
        const gitCfg = readGitSettings();
        const scm = getSourceControlProvider(repo);
        const park = repo
          ? scm.parkingBranch(repo.id, chat.slotId)
          : gitCfg ? scm.parkingBranch(gitCfg.repoName, chat.slotId) : null;
        const baseBranch = repo?.defaultBase || gitCfg?.defaultBase;
        const repoPath = repo?.repoPath || gitCfg?.repoPath;
        try {
          // Consolidate the chat's work to its slot-independent home BEFORE
          // parking (parking resets the slot). git → push branch to the local
          // root; perforce → shelve the changelist. Returns state to persist
          // on the chat (the perforce shelf changelist).
          if (repoPath && chat.branch) {
            try {
              const persisted = await scm.persistChatOnClose({
                repoPath,
                worktreePath: chat.worktreePath,
                branch: chat.branch,
                discard: opts?.stash !== true,
                p4ShelfCl: chat.p4ShelfCl ?? null,
              });
              if (persisted.p4ShelfCl !== undefined) {
                setChatP4Shelf(chat.id, persisted.p4ShelfCl ?? null);
              }
            } catch (err) {
              console.warn(`[slots] persist-on-close failed for chat ${chatId}: ${(err as Error).message}`);
            }
          }
          if (park) {
            await scm.parkSlot({
              worktreePath: chat.worktreePath,
              parkBranch: park,
              stash: opts?.stash === true,
              discard: opts?.stash !== true,
              stashMessage: scm.newChatStashName(chat.id),
            });
          }
          if (park && baseBranch) {
            scm.refreshParkBranchInBackground({
              worktreePath: chat.worktreePath,
              parkBranch: park,
              baseBranch,
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[slots] park failed for chat ${chatId}: ${(err as Error).message}`);
        }
      }
      // Ephemeral chat (worktree but no slot): tear down the worktree
      // entirely. Branch stays in the repo so reopen can recreate.
      else if (chat?.slotId == null && chat?.worktreePath) {
        const repo = resolveRepo(chat.repoId);
        const gitCfg = readGitSettings();
        const scm = getSourceControlProvider(repo);
        const repoPath = repo?.repoPath || gitCfg?.repoPath;
        if (repoPath) {
          try {
            await scm.removeChatWorktree({
              repoPath,
              worktreePath: chat.worktreePath,
              stash: opts?.stash === true,
              discard: opts?.stash !== true,
              stashMessage: scm.newChatStashName(chat.id),
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[ephemeral] remove failed for chat ${chatId}: ${(err as Error).message}`);
          }
        }
      }

      closeChat(chatId);
    },
  );

  ipcMain.handle(
    IpcChannel.ChatsReopen,
    async (_e, chatId: string): Promise<ReopenChatResult> => {
      const chat = getChat(chatId);
      if (!chat) return { ok: false, reason: 'not-found' };
      // CR chats (and any future slot-less chat type) have no branch
      // — they run against the repo root and don't need a worktree
      // restored on reopen. Slot-backed chats always have a branch
      // (auto-generated at create time if the caller didn't supply
      // one), so branch presence is the only signal we need.
      //
      // Previously this also checked slot_id / worktree_path being
      // empty as a fallback, but both are correctly cleared by
      // closeChat() now, so they're zero on every closed chat —
      // including slot-backed ones we DO want to restore. Branch is
      // chat-stable identity; the runtime fields are not.
      if (!chat.branch) {
        const reopened = reopenChat(chatId);
        if (!reopened) return { ok: false, reason: 'not-found' };
        return { ok: true, chat: reopened };
      }
      const repo = resolveRepo(chat.repoId);
      const gitCfg = readGitSettings();
      if (!repo || !gitCfg) {
        // Repo row vanished (deleted via Preferences) or git not
        // configured. Fall back to a plain reopen so the chat is at
        // least usable; user can reattach via the per-chat reattach
        // flow once they re-add the repo.
        const reopened = reopenChat(chatId);
        if (!reopened) return { ok: false, reason: 'not-found' };
        return { ok: true, chat: reopened };
      }
      const baseBranch = repo.defaultBase || gitCfg.defaultBase;
      const scm = getSourceControlProvider(repo);

      if (repo.mode === 'ephemeral') {
        const worktreePath = ephemeralPathFor({
          scm,
          worktreesDir: worktreesDirForRepo(repo),
          ticket: chat.ticket,
          pr: chat.pr,
          chatId: chat.id,
        });
        try {
          await scm.ensureChatWorktree({
            repoPath: repo.repoPath || gitCfg.repoPath,
            worktreePath,
            branch: chat.branch,
            baseBranch,
          });
          // Same per-chat stash convention slot mode uses — pop the
          // latest one so dirty work survives close→reopen cycles.
          const stashRef = await scm.findLatestStashRef(worktreePath, scm.chatStashPrefix(chatId));
          if (stashRef) await scm.popStash(worktreePath, stashRef);
        } catch (err) {
          return { ok: false, reason: 'worktree-failed', message: (err as Error).message };
        }
        const reopened = reopenChat(chatId, { slotId: null, worktreePath });
        if (!reopened) return { ok: false, reason: 'not-found' };
        return { ok: true, chat: reopened };
      }

      // Slot-pool mode.
      const slotsCfg = readSlotsSettings();
      if (!slotsCfg) {
        const reopened = reopenChat(chatId);
        if (!reopened) return { ok: false, reason: 'not-found' };
        return { ok: true, chat: reopened };
      }
      // Remember which slot this chat last lived in so we can detect a
      // forced slot-reassignment below and tell the agent about it.
      const previousSlotId = chat.slotId;
      const slotId = allocateSlotPreferring(slotsCfg.maxCount, chat.slotId);
      if (slotId === null) return { ok: false, reason: 'no-free-slot' };
      const worktreePath = slotWorktreePathForRepo(repo, slotId);
      try {
        await scm.ensureSlotWorktree({
          repoPath: repo.repoPath || gitCfg.repoPath,
          worktreePath,
          parkBranch: scm.parkingBranch(repo.id, slotId),
          baseBranch: repo.defaultBase || gitCfg.defaultBase,
        });
        await scm.checkoutBranch({ worktreePath, branch: chat.branch, baseBranch: repo.defaultBase || gitCfg.defaultBase });
        // Restore the chat's work from its slot-independent home (git → fetch
        // the branch from the local root; perforce → unshelve into this slot).
        // Replaces the old slot-local stash, which couldn't survive a reopen on
        // a different slot. Returns updated state to persist (perforce shelf CL).
        const restored = await scm.restoreChatOnReopen({
          repoPath: repo.repoPath || gitCfg.repoPath,
          worktreePath,
          branch: chat.branch,
          baseBranch: repo.defaultBase || gitCfg.defaultBase,
          p4ShelfCl: chat.p4ShelfCl ?? null,
        });
        if (restored.p4ShelfCl !== undefined) setChatP4Shelf(chatId, restored.p4ShelfCl ?? null);
      } catch (err) {
        return { ok: false, reason: 'worktree-failed', message: (err as Error).message };
      }
      const reopened = reopenChat(chatId, { slotId, worktreePath });
      if (!reopened) return { ok: false, reason: 'not-found' };
      // Slot changed: the agent's prior context referenced an old
      // worktree path. Inject a heads-up note so subsequent reads,
      // edits, and git ops use the new slot/worktree without the
      // agent silently following the stale path it remembers. We
      // fire-and-forget so a transient send failure (e.g. agent not
      // ready yet) doesn't break the reopen.
      if (previousSlotId != null && previousSlotId !== slotId) {
        const slotLabel = `${repo.slotPrefix}-${slotId}`;
        const prevLabel = `${repo.slotPrefix}-${previousSlotId}`;
        const note = (
          `Heads-up: this chat was paused and just resumed in a new worktree slot. ` +
          `Previous: \`${prevLabel}\`. Now active: \`${slotLabel}\` (\`${worktreePath}\`). ` +
          `All file reads, edits, and git operations from here on should use the new slot path — ` +
          `the old one no longer reflects this chat's working tree. ` +
          `There's nothing you need to do about this right now; continue with the user's next instruction.`
        );
        void AgentHost.send(chatId, note).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(`[slots] slot-change note failed for chat ${chatId}: ${(err as Error).message}`);
        });
      }
      return { ok: true, chat: reopened };
    },
  );

  ipcMain.handle(IpcChannel.ChatsDelete, async (_e, chatId: string) => {
    const chat = getChat(chatId);
    await AgentHost.dispose(chatId);
    disposePty(chatId);
    // If the chat is ephemeral and still has a live worktree on disk
    // (i.e. delete-from-open, not delete-after-close), tear it down so
    // we don't leak <worktreesDir>/<slug> directories. Slot-backed
    // chats keep their worktree for reuse — we only touch ephemerals.
    if (chat?.slotId == null && chat?.worktreePath) {
      const repo = resolveRepo(chat.repoId);
      const gitCfg = readGitSettings();
      const scm = getSourceControlProvider(repo);
      const repoPath = repo?.repoPath || gitCfg?.repoPath;
      if (repoPath) {
        try {
          await scm.removeChatWorktree({ repoPath, worktreePath: chat.worktreePath, discard: true });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[ephemeral] delete cleanup failed for chat ${chatId}: ${(err as Error).message}`);
        }
      }
    }
    deleteChat(chatId);
  });

  ipcMain.handle(IpcChannel.ChatsSearch, (_e, query: string, limit?: number) =>
    searchChats(query, limit),
  );

  ipcMain.handle(IpcChannel.MessagesList, (_e, chatId: string, tail?: number) =>
    listMessages(chatId, tail),
  );
}

/**
 * The host's workspaces: slot pools and ephemeral worktrees per
 * repository, the same model the desktop uses for its own checkouts.
 *
 *   - `slots` mode: a pool of `slotCount` long-lived git worktrees at
 *     `<workspaces>/<repo>/<prefix>-N`, each parked on `<repo>/slotN`
 *     when idle. A chat takes the lowest free slot, the worktree is
 *     switched to the chat's branch (made off the base branch if new),
 *     and releasing parks it again — stashing or discarding dirty work.
 *   - `ephemeral` mode: one worktree per chat at
 *     `<workspaces>/<repo>/chat-<id>`, removed on release.
 *   - The repo root, and a scratch folder for chats with no repository.
 *
 * Who holds what is written to `<workspaces>/state.json` so a host
 * restart keeps every chat's checkout; the desktop keeps the same facts
 * on the chat and asks again when it needs to (a request for a
 * workspace the chat already holds is answered from the state).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HostRepo,
  HostSlotsInfo,
  HostWorkspaceErrorCode,
  HostWorkspaceRequest,
  HostWorkspaceResult,
} from '@shared/hostProtocol';
import {
  checkoutBranch,
  chatStashPrefix,
  ensureChatWorktree,
  ensureSlotWorktree,
  ephemeralWorktreeSlug,
  findLatestStashRef,
  newChatStashName,
  parkSlot,
  parkingBranch,
  popStash,
  refreshParkBranchInBackground,
  refreshSlotForAllocation,
  removeChatWorktree,
} from '../main/git/worktrees';
import { dlog } from '../main/diagLog';
import type { HostConfig } from './config';

interface SlotHolder {
  chatId: string;
  branch: string;
}

interface EphemeralHolder {
  repoId: string;
  path: string;
  branch: string;
}

interface State {
  /** repoId → slotId → holder */
  slots: Record<string, Record<string, SlotHolder>>;
  /** chatId → worktree */
  ephemeral: Record<string, EphemeralHolder>;
}

export class HostWorkspaceError extends Error {
  constructor(public readonly code: HostWorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'HostWorkspaceError';
  }
}

export class HostWorkspaces {
  private state: State = { slots: {}, ephemeral: {} };
  private readonly statePath: string;
  /** One workspace operation at a time per chat; allocation is serialized
   *  across chats so two spawns cannot take the same slot. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: HostConfig) {
    this.statePath = join(config.workspacesDir, 'state.json');
  }

  load(): void {
    try {
      if (!existsSync(this.statePath)) return;
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<State>;
      this.state = {
        slots: raw.slots && typeof raw.slots === 'object' ? raw.slots : {},
        ephemeral: raw.ephemeral && typeof raw.ephemeral === 'object' ? raw.ephemeral : {},
      };
      // A worktree that is gone from disk is not held by anyone.
      for (const [repoId, slots] of Object.entries(this.state.slots)) {
        const repo = this.repo(repoId);
        for (const slotId of Object.keys(slots)) {
          if (!repo || !existsSync(this.slotPath(repo, Number(slotId)))) delete slots[slotId];
        }
      }
      for (const [chatId, e] of Object.entries(this.state.ephemeral)) {
        if (!existsSync(e.path)) delete this.state.ephemeral[chatId];
      }
      dlog('host.workspaces.loaded', {
        slots: Object.values(this.state.slots).reduce((n, s) => n + Object.keys(s).length, 0),
        ephemeral: Object.keys(this.state.ephemeral).length,
      });
    } catch (err) {
      dlog('host.workspaces.load-failed', { error: err instanceof Error ? err.message : String(err) });
      this.state = { slots: {}, ephemeral: {} };
    }
  }

  private save(): void {
    mkdirSync(this.config.workspacesDir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.statePath);
  }

  private repo(repoId: string | null | undefined): HostRepo | null {
    return this.config.repos.find((r) => r.id === repoId) ?? null;
  }

  private slotPath(repo: HostRepo, slotId: number): string {
    return join(this.config.workspacesDir, repo.id, `${repo.slotPrefix}-${slotId}`);
  }

  /** Occupancy of a repository's pool, for the desktop's pickers. */
  list(repoId: string): HostSlotsInfo {
    const repo = this.repo(repoId);
    if (!repo) throw new HostWorkspaceError('no-repo', `no repo "${repoId}" on this host`);
    const held = this.state.slots[repo.id] ?? {};
    const slots: HostSlotsInfo['slots'] = [];
    for (let slotId = 1; slotId <= repo.slotCount; slotId += 1) {
      const holder = held[String(slotId)];
      slots.push({
        slotId,
        path: this.slotPath(repo, slotId),
        chatId: holder?.chatId ?? null,
        branch: holder?.branch ?? null,
      });
    }
    return { slotPrefix: repo.slotPrefix, slotCount: repo.slotCount, mode: repo.mode, slots };
  }

  /** The workspace a chat holds right now, if any. */
  held(chatId: string): HostWorkspaceResult | null {
    for (const [repoId, slots] of Object.entries(this.state.slots)) {
      for (const [slotId, holder] of Object.entries(slots)) {
        if (holder.chatId !== chatId) continue;
        const repo = this.repo(repoId);
        if (!repo) continue;
        return { cwd: this.slotPath(repo, Number(slotId)), kind: 'slot', slotId: Number(slotId), branch: holder.branch };
      }
    }
    const e = this.state.ephemeral[chatId];
    if (e) return { cwd: e.path, kind: 'ephemeral', slotId: null, branch: e.branch };
    return null;
  }

  /** Give the chat the workspace it asks for, or the one it already
   *  holds. Serialized so allocations never race. */
  ensure(chatId: string, req: HostWorkspaceRequest | null | undefined): Promise<HostWorkspaceResult> {
    const run = this.chain.then(() => this.ensureNow(chatId, req));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async ensureNow(chatId: string, req: HostWorkspaceRequest | null | undefined): Promise<HostWorkspaceResult> {
    const kind = req?.kind ?? 'scratch';
    if (kind === 'scratch') {
      const cwd = join(this.config.workspacesDir, 'scratch', chatId);
      mkdirSync(cwd, { recursive: true });
      return { cwd, kind: 'scratch', slotId: null, branch: null };
    }
    const repo = this.repo(req?.repoId);
    if (!repo) throw new HostWorkspaceError('no-repo', `no repo "${req?.repoId ?? ''}" on this host`);
    if (!existsSync(repo.path)) throw new HostWorkspaceError('worktree-failed', `repo "${repo.id}" is not at ${repo.path} on this host`);
    if (kind === 'root') return { cwd: repo.path, kind: 'root', slotId: null, branch: null };

    // A worktree on the chat's branch: what it already holds, else a
    // slot from the pool or a fresh ephemeral worktree.
    const current = this.held(chatId);
    const branch = req?.branch?.trim() || current?.branch || `popbot/chat-${Date.now()}`;
    const baseBranch = req?.baseBranch?.trim() || repo.defaultBase || 'main';
    if (current) {
      // Re-check the checkout is there and on the branch (a resume).
      try {
        if (current.kind === 'slot' && current.slotId != null) {
          await ensureSlotWorktree({ repoPath: repo.path, worktreePath: current.cwd, parkBranch: parkingBranch(repo.id, current.slotId), baseBranch });
          await checkoutBranch({ worktreePath: current.cwd, branch: current.branch ?? branch, baseBranch });
        } else {
          await ensureChatWorktree({ repoPath: repo.path, worktreePath: current.cwd, branch: current.branch ?? branch, baseBranch });
        }
      } catch (err) {
        throw new HostWorkspaceError('worktree-failed', err instanceof Error ? err.message : String(err));
      }
      return current;
    }

    if (repo.mode === 'ephemeral' || repo.slotCount < 1) {
      if (repo.mode === 'slots') throw new HostWorkspaceError('no-free-slot', `repo "${repo.id}" has no slots on this host (set slotCount in its config)`);
      const path = this.ephemeralPathFor(repo, chatId);
      try {
        await ensureChatWorktree({ repoPath: repo.path, worktreePath: path, branch, baseBranch });
        await this.popChatStash(path, chatId);
      } catch (err) {
        throw new HostWorkspaceError('worktree-failed', err instanceof Error ? err.message : String(err));
      }
      this.state.ephemeral[chatId] = { repoId: repo.id, path, branch };
      this.save();
      dlog('host.workspace.ephemeral', { chatId, repo: repo.id, path, branch });
      return { cwd: path, kind: 'ephemeral', slotId: null, branch };
    }

    const held = (this.state.slots[repo.id] ??= {});
    let slotId: number | null = null;
    if (req?.slotId != null && req.slotId >= 1 && req.slotId <= repo.slotCount) {
      if (held[String(req.slotId)]) throw new HostWorkspaceError('slot-taken', `slot ${req.slotId} of "${repo.id}" is taken on this host`);
      slotId = req.slotId;
    } else {
      for (let i = 1; i <= repo.slotCount; i += 1) {
        if (!held[String(i)]) { slotId = i; break; }
      }
    }
    if (slotId === null) throw new HostWorkspaceError('no-free-slot', `no free slot in "${repo.id}" on this host (${repo.slotCount} in use)`);
    const worktreePath = this.slotPath(repo, slotId);
    try {
      await ensureSlotWorktree({ repoPath: repo.path, worktreePath, parkBranch: parkingBranch(repo.id, slotId), baseBranch: repo.defaultBase || 'main' });
      await refreshSlotForAllocation({ worktreePath, baseBranch });
      await checkoutBranch({ worktreePath, branch, baseBranch });
      await this.popChatStash(worktreePath, chatId);
    } catch (err) {
      throw new HostWorkspaceError('worktree-failed', err instanceof Error ? err.message : String(err));
    }
    held[String(slotId)] = { chatId, branch };
    this.save();
    dlog('host.workspace.slot', { chatId, repo: repo.id, slotId, branch });
    return { cwd: worktreePath, kind: 'slot', slotId, branch };
  }

  /** Park the chat's slot (or remove its ephemeral worktree). The
   *  branch stays in the repository; dirty work is stashed under the
   *  chat's name or discarded. Nothing held is fine. */
  release(chatId: string, stash: boolean): Promise<{ released: boolean }> {
    const run = this.chain.then(() => this.releaseNow(chatId, stash));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async releaseNow(chatId: string, stash: boolean): Promise<{ released: boolean }> {
    const current = this.held(chatId);
    if (!current) return { released: false };
    const repoId = current.kind === 'ephemeral'
      ? this.state.ephemeral[chatId]?.repoId
      : Object.entries(this.state.slots).find(([, slots]) => Object.values(slots).some((h) => h.chatId === chatId))?.[0];
    const repo = this.repo(repoId);
    try {
      if (current.kind === 'slot' && current.slotId != null && repo) {
        const parkBranch = parkingBranch(repo.id, current.slotId);
        await parkSlot({ worktreePath: current.cwd, parkBranch, stash, discard: !stash, stashMessage: newChatStashName(chatId) });
        refreshParkBranchInBackground({ worktreePath: current.cwd, parkBranch, baseBranch: repo.defaultBase || 'main' });
        delete this.state.slots[repo.id][String(current.slotId)];
      } else if (current.kind === 'ephemeral' && repo) {
        await removeChatWorktree({ repoPath: repo.path, worktreePath: current.cwd, stash, discard: !stash, stashMessage: newChatStashName(chatId) });
        delete this.state.ephemeral[chatId];
      }
    } finally {
      this.save();
    }
    dlog('host.workspace.released', { chatId, kind: current.kind, slotId: current.slotId, stash });
    return { released: true };
  }

  private async popChatStash(worktreePath: string, chatId: string): Promise<void> {
    const ref = await findLatestStashRef(worktreePath, chatStashPrefix(chatId)).catch(() => null);
    if (ref) await popStash(worktreePath, ref).catch(() => undefined);
  }

  private ephemeralPathFor(repo: HostRepo, chatId: string): string {
    const dir = join(this.config.workspacesDir, repo.id);
    const slug = ephemeralWorktreeSlug({ ticket: null, pr: null, chatId });
    const preferred = join(dir, slug);
    if (!existsSync(preferred)) return preferred;
    return join(dir, `${slug}-${Date.now().toString(36)}`);
  }
}

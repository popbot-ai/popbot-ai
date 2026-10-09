/**
 * Move a chat to another machine: from this computer to a PopBot host,
 * from a host back here, or from one host to another.
 *
 * The conversation does not move — its transcript is in this computer's
 * database wherever the chat runs. Its native agent session lives on the
 * machine it ran on, so it is left behind; the chat's next message starts
 * a fresh one where it now is, carrying the conversation so far (the
 * provider bridge in AgentHost).
 *
 * The work moves without going through GitHub (src/main/git/moveWork.ts):
 * the branch's commits no remote has, and the uncommitted changes, packed
 * where the chat was and unpacked into a checkout of the repository of the
 * same name where it goes. Where there is no repository of that name, the
 * chat — once the person agrees — moves without one, its work staying on
 * the machine it left. The checkout it leaves is parked with its work
 * stashed, as closing a chat does, so nothing is lost either way.
 *
 * Order: stop the agent, pack, unpack, then — only once the work is in
 * place — point the chat at its new home and release the old checkout. A
 * failure before that leaves the chat where it was.
 */
import { ipcMain } from 'electron';
import { IpcChannel, type MoveChatResult, type MoveChatTarget } from '@shared/ipc';
import type { HostRepo, HostSlotsInfo, HostUnpackBody, HostWorkspaceResult, PackedWork } from '@shared/hostProtocol';
import { RAW_CHAT_REPO_ID, type ChatRecord, type HostChatInfo, type HostRecord, type RepoRecord } from '@shared/persistence';
import { AgentHost } from '../agents/AgentHost';
import { endHostSession, hostRequest, probeHost, releaseHostWorkspace, setHostChatMeta } from '../agents/hostClient';
import { slotWorktreePathForRepo, worktreesDirForRepo } from '../git/chatPaths';
import { applyWorkChanges, packWork, unpackBranch } from '../git/moveWork';
import { movedChatStashName } from '../git/worktrees';
import { allocateSlotPreferring, getChat, relocateChat } from '../persistence/chats';
import { getHost } from '../persistence/hosts';
import { appendMessage } from '../persistence/messages';
import { getRepo } from '../persistence/repos';
import { getSourceControlProvider } from '../scm';
import { dlog } from '../diagLog';
import { ensureSlotsMounted, ephemeralPathFor, resolveRepo } from './chats';

/** What the chat holds: nothing (a scratch chat), a repository root (a
 *  review chat, say), or a branch in its own checkout. */
type Shape = 'scratch' | 'root' | 'worktree';

interface Where {
  label: string;
  host: HostRecord | null;
}

class MoveError extends Error {}

function fail(message: string): never {
  throw new MoveError(message);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The person has to agree first: there is no repository of this name
 *  where the chat would go. */
class NeedsConfirm extends Error {
  constructor(readonly repo: string, readonly toLabel: string, readonly fromLabel: string, readonly branch: string | null) {
    super('no matching repository');
  }
}

export async function moveChat(
  chatId: string,
  target: MoveChatTarget,
  opts: { withoutRepo?: boolean } = {},
): Promise<MoveChatResult> {
  try {
    const chat = await moveChatNow(chatId, target, opts.withoutRepo === true);
    return { ok: true, chat };
  } catch (err) {
    if (err instanceof NeedsConfirm) {
      return { ok: false, reason: 'no-matching-repo', repo: err.repo, from: err.fromLabel, to: err.toLabel, branch: err.branch };
    }
    dlog('chat.move.failed', { chatId, target, error: message(err) });
    return { ok: false, error: message(err) };
  }
}

async function moveChatNow(chatId: string, target: MoveChatTarget, withoutRepo: boolean): Promise<ChatRecord> {
  const chat = getChat(chatId) ?? fail('that chat no longer exists');
  if (chat.host?.botId) fail("a bot's chat runs where its bot lives; it does not move");
  if (chat.cloud) fail('a cloud chat runs in the cloud; it does not move');
  if (chat.status === 'run') fail('the agent is working — stop it, or let it finish, first');

  // ---- Where it is, and where it goes.
  const fromHost = chat.host ? getHost(chat.host.hostId) ?? fail(`its host "${chat.host.hostName}" is no longer in Preferences ▸ Hosts`) : null;
  const toHost = target.kind === 'host' ? getHost(target.hostId) ?? fail('that host is no longer in Preferences ▸ Hosts') : null;
  if ((fromHost?.id ?? null) === (toHost?.id ?? null)) fail('it is already there');
  const from: Where = { label: fromHost?.name ?? 'this computer', host: fromHost };
  const to: Where = { label: toHost?.name ?? 'this computer', host: toHost };

  // ---- What it holds, in which repository (by name).
  let shape: Shape;
  let repoId: string | null = null;
  let localRepo: RepoRecord | null = null;
  const branch = chat.host ? chat.host.branch : chat.branch;
  if (chat.host) {
    shape = chat.host.kind;
    repoId = chat.host.repoId;
  } else {
    localRepo = chat.repoId === RAW_CHAT_REPO_ID ? null : resolveRepo(chat.repoId);
    shape = !localRepo ? 'scratch' : chat.branch ? 'worktree' : 'root';
    if (localRepo?.scm === 'perforce') fail('Perforce chats cannot move between machines yet');
    repoId = localRepo?.id ?? null;
  }
  if (shape === 'worktree' && !branch) fail('it has no branch to move');

  // ---- The repository of the same name where it goes. With none, the
  // chat goes without one — once the person has said so — and its work
  // stays behind.
  let targetLocalRepo: RepoRecord | null = null;
  let targetHostRepo: HostRepo | null = null;
  let leftBehind = false;
  if (shape !== 'scratch' && repoId) {
    if (toHost) {
      const info = await probeHost(toHost).catch((err: unknown) => fail(`${to.label} cannot be reached (${message(err)})`));
      targetHostRepo = info.repos.find((r) => r.id === repoId) ?? null;
    } else {
      const here = getRepo(repoId);
      targetLocalRepo = here && here.scm !== 'perforce' ? here : null;
    }
    if (!targetHostRepo && !targetLocalRepo) {
      if (!withoutRepo) throw new NeedsConfirm(repoId, to.label, from.label, shape === 'worktree' ? branch : null);
      leftBehind = shape === 'worktree';
      shape = 'scratch';
    }
  }
  dlog('chat.move.begin', { chatId, from: from.label, to: to.label, shape, branch, repoId, leftBehind });

  // ---- Stop the agent here, and pack the work where it is.
  await AgentHost.dispose(chatId);
  let work: PackedWork | null = null;
  if (shape === 'worktree') {
    if (fromHost) {
      const res = await hostRequest<{ work: PackedWork | null }>(
        fromHost, 'POST', `/v1/chats/${encodeURIComponent(chatId)}/pack`, { repoId, branch }, 300_000,
      );
      work = res.work ?? fail(`${from.label} found no work on "${branch}" to move`);
    } else {
      const cwd = chat.worktreePath || localRepo!.repoPath;
      work = await packWork(cwd, branch!, { withChanges: !!chat.worktreePath });
    }
  } else if (fromHost) {
    await endHostSession(fromHost, chatId).catch(() => undefined);
  }

  // ---- Unpack it where it goes.
  let newHost: HostChatInfo | null = null;
  let newLocal: { repoId: string; slotId: number | null; worktreePath: string | null } = { repoId: RAW_CHAT_REPO_ID, slotId: null, worktreePath: null };
  if (toHost) {
    const kind = shape;
    let ws: HostWorkspaceResult | null = null;
    if (kind !== 'scratch') {
      ws = await hostRequest<HostWorkspaceResult>(
        toHost, 'POST', `/v1/chats/${encodeURIComponent(chatId)}/unpack`,
        {
          workspace: { kind, repoId: targetHostRepo!.id, branch: kind === 'worktree' ? branch : null, baseBranch: targetHostRepo!.defaultBase },
          work,
        } satisfies HostUnpackBody,
        300_000,
      );
    }
    const slotPrefix = ws?.kind === 'slot'
      ? await hostRequest<HostSlotsInfo>(toHost, 'GET', `/v1/repos/${encodeURIComponent(targetHostRepo!.id)}/slots`).then((s) => s.slotPrefix).catch(() => null)
      : null;
    newHost = {
      hostId: toHost.id,
      hostName: toHost.name,
      repoId: targetHostRepo?.id ?? null,
      kind,
      branch: kind === 'worktree' ? ws?.branch ?? branch : null,
      baseBranch: targetHostRepo?.defaultBase ?? null,
      slotId: ws?.slotId ?? null,
      slotPrefix,
      cwd: ws?.cwd ?? null,
      lastSeq: 0,
    };
  } else if (shape === 'worktree') {
    newLocal = await unpackHere(chat, targetLocalRepo!, branch!, work!);
  } else if (shape === 'root') {
    newLocal = { repoId: targetLocalRepo!.id, slotId: null, worktreePath: null };
  }

  // ---- The work is in place: the chat lives there now.
  relocateChat(chatId, { ...newLocal, host: newHost, branch: shape === 'worktree' ? branch : null });

  // ---- Release what it left, its work kept in a stash there.
  await releaseOld(chat, fromHost, localRepo).catch((err: unknown) => {
    dlog('chat.move.release-failed', { chatId, from: from.label, error: message(err) });
  });

  const moved = getChat(chatId) ?? fail('the chat vanished while moving');
  const what = shape === 'worktree'
    ? ` with "${branch}"${work?.patchBase64 ? ' and its uncommitted changes' : ''}`
    : leftBehind
      ? ` without a repository — "${repoId}" isn't there. Its work stays on ${from.label}, on branch "${branch}" (uncommitted changes stashed)`
      : '';
  const note = appendMessage({
    chatId,
    role: 'system',
    kind: 'system',
    body: {
      text: `switch: Moved from ${from.label} to ${to.label}${what} · your next message starts a fresh session there, primed with this conversation.`,
    },
  });
  AgentHost.emit({ type: 'message-added', chatId, message: note, ts: Date.now() });
  AgentHost.emit({ type: 'chat-updated', chatId, chat: moved, ts: Date.now() });
  dlog('chat.move.done', { chatId, from: from.label, to: to.label, shape, branch, bundled: !!work?.bundleBase64, changes: !!work?.patchBase64 });
  return moved;
}

/** A checkout here for the moved branch — a slot, or an ephemeral
 *  worktree, as the repository is set up — with the work in it. */
async function unpackHere(
  chat: ChatRecord,
  repo: RepoRecord,
  branch: string,
  work: PackedWork,
): Promise<{ repoId: string; slotId: number | null; worktreePath: string }> {
  const scm = getSourceControlProvider(repo);
  const repoPath = repo.repoPath || '';
  const baseBranch = repo.defaultBase || 'main';
  await unpackBranch(repoPath, work);
  let slotId: number | null = null;
  let worktreePath: string;
  if (repo.mode === 'ephemeral') {
    worktreePath = ephemeralPathFor({ scm, worktreesDir: worktreesDirForRepo(repo), ticket: chat.ticket, pr: chat.pr, chatId: chat.id });
    await scm.ensureChatWorktree({ repoPath, worktreePath, branch, baseBranch });
  } else {
    const maxSlots = repo.slotCount || 0;
    if (maxSlots < 1) fail(`repository "${repo.id}" has no slots here — set a slot count in Preferences ▸ Repositories`);
    slotId = allocateSlotPreferring(maxSlots, null) ?? fail(`no free slot in "${repo.id}" here — close a chat and try again`);
    worktreePath = slotWorktreePathForRepo(repo, slotId);
    await ensureSlotsMounted(repo);
    await scm.ensureSlotWorktree({ repoPath, worktreePath, parkBranch: scm.parkingBranch(repo.id, slotId), baseBranch });
    await scm.checkoutBranch({ worktreePath, branch, baseBranch });
  }
  try {
    await applyWorkChanges(worktreePath, work);
  } catch (err) {
    // Give back the checkout just made; the chat stays where it was.
    if (slotId != null) {
      await scm.parkSlot({ worktreePath, parkBranch: scm.parkingBranch(repo.id, slotId), stash: false, discard: true }).catch(() => undefined);
    } else {
      await scm.removeChatWorktree({ repoPath, worktreePath, discard: true }).catch(() => undefined);
    }
    throw err;
  }
  return { repoId: repo.id, slotId, worktreePath };
}

/** Park the checkout the chat left, stashing what was in it. */
async function releaseOld(chat: ChatRecord, fromHost: HostRecord | null, localRepo: RepoRecord | null): Promise<void> {
  if (fromHost) {
    if (chat.host?.kind === 'worktree') await releaseHostWorkspace(fromHost, chat.id, true, { moved: true });
    await endHostSession(fromHost, chat.id).catch(() => undefined);
    // Its other chats there no longer see it.
    await setHostChatMeta(fromHost, chat.id, { gone: true });
    return;
  }
  if (!localRepo || !chat.worktreePath) return;
  const scm = getSourceControlProvider(localRepo);
  // The same park / remove as closing the chat, but the stash it keeps is
  // a backup: the work went with the chat, so reopening must not pop it.
  const stashMessage = movedChatStashName(chat.id);
  if (chat.slotId != null) {
    const parkBranch = scm.parkingBranch(localRepo.id, chat.slotId);
    await scm.parkSlot({ worktreePath: chat.worktreePath, parkBranch, stash: true, discard: false, stashMessage });
    scm.refreshParkBranchInBackground({ worktreePath: chat.worktreePath, parkBranch, baseBranch: localRepo.defaultBase || 'main' });
  } else {
    await scm.removeChatWorktree({ repoPath: localRepo.repoPath, worktreePath: chat.worktreePath, stash: true, discard: false, stashMessage });
  }
}

export function registerMoveChatHandler(): void {
  ipcMain.handle(IpcChannel.ChatsMove, (_e, chatId: string, target: MoveChatTarget, opts?: { withoutRepo?: boolean }) => {
    if (typeof chatId !== 'string' || !target || (target.kind !== 'local' && (target.kind !== 'host' || typeof target.hostId !== 'string'))) {
      return { ok: false, error: 'bad move request' } satisfies MoveChatResult;
    }
    return moveChat(chatId, target, { withoutRepo: opts?.withoutRepo === true });
  });
}

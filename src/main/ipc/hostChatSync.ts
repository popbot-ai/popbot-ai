/**
 * What a host's own popbot tools did while this app could not be reached
 * (src/host/localPopbot.ts), brought in when it is back: a chat a host
 * made is adopted here, and one a host closed or reopened is closed or
 * reopened here. Run on every look at a host (ipc/bots.ts › refresh).
 *
 * Settled by telling the host the chat's state as this app now has it
 * (setHostChatMeta), which marks it the desktop's again — so each change
 * is applied once.
 */
import type { HostRosterChat } from '@shared/hostProtocol';
import { RAW_CHAT_REPO_ID, type HostRecord } from '@shared/persistence';
import { AgentHost } from '../agents/AgentHost';
import { setHostChatMeta } from '../agents/hostClient';
import { closeChat, createChat, getChat, listOpenChats } from '../persistence/chats';
import { dlog } from '../diagLog';
import { closeChatWithWorkspace, reopenChatWithWorkspace } from './chats';

export async function syncHostChats(host: HostRecord, roster: HostRosterChat[]): Promise<void> {
  const open = new Set(listOpenChats().map((c) => c.id));
  for (const r of roster) {
    const chat = getChat(r.chatId);
    if (!chat) {
      // Made there while this app was away. A chat this app made and then
      // deleted is gone from the host's list, so is never brought back.
      if (r.createdByHost) adopt(host, r);
      continue;
    }
    if (chat.host?.hostId !== host.id || chat.host.botId || r.changedBy !== 'host') continue;
    const isOpen = open.has(chat.id);
    if (r.open && !isOpen) {
      const res = await reopenChatWithWorkspace(chat.id);
      dlog('hostsync.reopened', { chatId: chat.id, host: host.name, ok: res.ok });
      AgentHost.emit({ type: 'chats-changed', chatId: chat.id, reason: 'reopened', ts: Date.now() });
    } else if (!r.open && isOpen) {
      await closeChatWithWorkspace(chat.id, { stash: true });
      dlog('hostsync.closed', { chatId: chat.id, host: host.name });
      AgentHost.emit({ type: 'chats-changed', chatId: chat.id, reason: 'closed', ts: Date.now() });
    } else {
      // Already as the host has it: just settle it.
      await setHostChatMeta(host, chat.id, { open: r.open });
    }
  }
}

function adopt(host: HostRecord, r: HostRosterChat): void {
  const chat = createChat({
    id: r.chatId,
    name: r.name,
    branch: r.kind === 'worktree' ? r.branch : null,
    type: 'lite',
    slotId: null,
    worktreePath: null,
    repoId: RAW_CHAT_REPO_ID,
    agent: r.agent,
    cloud: null,
    host: {
      hostId: host.id,
      hostName: host.name,
      repoId: r.repoId,
      kind: r.kind,
      branch: r.branch,
      baseBranch: r.baseBranch,
      slotId: r.slotId,
      slotPrefix: null,
      cwd: r.cwd,
      // Its whole log is new here: read it from the start.
      lastSeq: 0,
    },
    claudeModel: r.claudeModel ?? undefined,
    claudeReasoningEffort: r.claudeReasoningEffort ?? undefined,
    codexModel: r.codexModel ?? undefined,
    codexReasoningEffort: r.codexReasoningEffort ?? undefined,
  });
  if (!r.open) closeChat(chat.id);
  dlog('hostsync.adopted', { chatId: chat.id, host: host.name, open: r.open });
  AgentHost.emit({ type: 'chats-changed', chatId: chat.id, reason: 'created', ts: Date.now() });
  void setHostChatMeta(host, chat.id, { name: r.name, open: r.open });
}

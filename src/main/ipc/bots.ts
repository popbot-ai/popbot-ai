/**
 * Bots (the Bots tab). A bot lives on a host — in its config, run by it
 * whether or not this app is open (src/host/bots.ts). This side finds
 * every host's bots, gives each a chat record here under the id its host
 * uses, and keeps those chats attached so their transcripts stay current.
 *
 * A bot's chat is an ordinary host chat with `host.botId` set. It is
 * not in the Chats tab: opening and closing it only shows and hides the
 * column. The bot runs until it is paused or killed.
 */
import { ipcMain } from 'electron';
import { IpcChannel, type BotHostListing, type BotResult } from '@shared/ipc';
import type { HostBotInfo, HostBotInput } from '@shared/hostProtocol';
import { RAW_CHAT_REPO_ID, type ChatRecord, type HostRecord } from '@shared/persistence';
import { AgentHost } from '../agents/AgentHost';
import { hostBotAction, killHostBot, probeHost, saveHostBot } from '../agents/hostClient';
import { closeChat, createChat, deleteChat, getChat, listClosedChats, listOpenChats, renameChat } from '../persistence/chats';
import { getHost, listHosts } from '../persistence/hosts';
import { isDbOpen } from '../persistence/db';
import { dlog } from '../diagLog';

/** How often the hosts are asked about their bots. */
const REFRESH_MS = 30_000;

/** The last answer from each host. */
const listings = new Map<string, BotHostListing>();
let refreshing: Promise<void> | null = null;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Ask every host for its bots; make and attach their chats. */
function refresh(): Promise<void> {
  if (!refreshing) {
    refreshing = refreshNow().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function refreshNow(): Promise<void> {
  if (!isDbOpen()) return;
  const hosts = listHosts();
  for (const id of [...listings.keys()]) if (!hosts.some((h) => h.id === id)) listings.delete(id);
  await Promise.all(hosts.map(async (host) => {
    try {
      const info = await probeHost(host);
      const bots = info.bots ?? [];
      listings.set(host.id, {
        hostId: host.id,
        hostName: host.name,
        reachable: true,
        bots,
        repos: info.repos.map((r) => ({ id: r.id, defaultBase: r.defaultBase })),
      });
      for (const bot of bots) {
        const chat = ensureBotChat(host, bot);
        if (chat) void follow(chat.id);
      }
    } catch (err) {
      const prior = listings.get(host.id);
      listings.set(host.id, {
        hostId: host.id,
        hostName: host.name,
        reachable: false,
        error: message(err).replace(new RegExp(`^${host.name}: `), ''),
        // What it last said, else the bot chats this app already has.
        bots: prior?.bots ?? botsFromChats(host.id),
        repos: prior?.repos ?? [],
      });
    }
  }));
}

/** Keep the bot's chat on its stream, so its transcript here is current
 *  whether or not its column is showing. */
async function follow(chatId: string): Promise<void> {
  if (AgentHost.isAttached(chatId)) return;
  try {
    await AgentHost.attachHostChat(chatId);
  } catch (err) {
    dlog('bots.follow-failed', { chatId, error: message(err) });
    await AgentHost.dispose(chatId).catch(() => undefined);
  }
}

/** The bot's chat record here, made on first sight. It starts closed:
 *  a bot shows in the Bots tab, and its column only when opened. */
function ensureBotChat(host: HostRecord, bot: HostBotInfo): ChatRecord | null {
  const existing = getChat(bot.chatId);
  if (existing) {
    if (existing.host?.hostId !== host.id) {
      // The same bot id on two hosts: one chat id. First one wins.
      dlog('bots.chat-id-taken', { chatId: bot.chatId, host: host.name, holder: existing.host?.hostName ?? 'local' });
      return null;
    }
    if (existing.name !== bot.name) renameChat(existing.id, bot.name);
    return existing;
  }
  const chat = createChat({
    id: bot.chatId,
    name: bot.name,
    repoId: RAW_CHAT_REPO_ID,
    agent: 'claude',
    host: {
      hostId: host.id,
      hostName: host.name,
      repoId: null,
      kind: 'scratch',
      branch: null,
      baseBranch: null,
      slotId: null,
      slotPrefix: null,
      cwd: null,
      lastSeq: 0,
      botId: bot.id,
    },
  });
  closeChat(chat.id);
  dlog('bots.chat-made', { chatId: chat.id, host: host.name, bot: bot.id });
  return getChat(chat.id);
}

/** A host that is off still shows its bots, from their chats here. */
function botsFromChats(hostId: string): HostBotInfo[] {
  return [...listOpenChats(), ...listClosedChats(1000)]
    .filter((c) => c.host?.hostId === hostId && c.host.botId)
    .map((c) => ({
      id: c.host!.botId!,
      name: c.name,
      prompt: '',
      repoId: null,
      triggers: [],
      peers: [],
      githubLogin: null,
      gitName: null,
      gitEmail: null,
      claudeModel: null,
      claudeReasoningEffort: null,
      enabled: true,
      chatId: c.id,
      hasToken: false,
      state: 'idle' as const,
      lastPollAt: null,
      lastError: null,
      watching: [],
    }));
}

/** Every host's bots, for the popbot tools. `fresh` asks the hosts again. */
export async function botListings(fresh: boolean): Promise<BotHostListing[]> {
  if (fresh || listings.size === 0) await refresh();
  return [...listings.values()];
}

/** The bot's chat record here, made if missing — for the popbot tools'
 *  message_bot, which reaches a bot through its chat. */
export function botChat(hostId: string, bot: HostBotInfo): ChatRecord | null {
  const host = getHost(hostId);
  if (!host) return null;
  const chat = ensureBotChat(host, bot);
  if (chat) void follow(chat.id);
  return chat;
}

function hostOr(hostId: string): HostRecord {
  const host = typeof hostId === 'string' ? getHost(hostId) : null;
  if (!host) throw new Error('that host is no longer in Preferences ▸ Hosts');
  return host;
}

async function guarded<T extends object>(fn: () => Promise<T>): Promise<BotResult<T>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

export function registerBotsHandlers(): void {
  ipcMain.handle(IpcChannel.BotsList, async (_e, fresh: boolean) => {
    if (fresh || listings.size === 0) await refresh();
    return [...listings.values()];
  });

  ipcMain.handle(IpcChannel.BotsSave, (_e, hostId: string, botId: string | null, input: HostBotInput) =>
    guarded(async () => {
      const host = hostOr(hostId);
      if (!input || typeof input !== 'object' || typeof input.name !== 'string') throw new Error('a bot needs a name');
      const bot = await saveHostBot(host, typeof botId === 'string' ? botId : null, input);
      dlog('bots.saved', { host: host.name, bot: bot.id, created: !botId });
      await refresh();
      return { bot };
    }));

  // Kill: gone from its host — session, checkout, state — and its chat
  // here with it; nothing else would ever show that chat again.
  ipcMain.handle(IpcChannel.BotsKill, (_e, hostId: string, botId: string) =>
    guarded(async () => {
      const host = hostOr(hostId);
      const chatId = listings.get(hostId)?.bots.find((b) => b.id === botId)?.chatId;
      await killHostBot(host, botId);
      if (chatId && getChat(chatId)) {
        await AgentHost.dispose(chatId);
        deleteChat(chatId);
        AgentHost.emit({ type: 'chats-changed', chatId, reason: 'closed', ts: Date.now() });
      }
      dlog('bots.killed', { host: host.name, bot: botId });
      await refresh();
      return {};
    }));

  ipcMain.handle(IpcChannel.BotsAction, (_e, hostId: string, botId: string, action: 'wake' | 'pause' | 'resume') =>
    guarded(async () => {
      if (action !== 'wake' && action !== 'pause' && action !== 'resume') throw new Error(`no action "${String(action)}"`);
      await hostBotAction(hostOr(hostId), botId, action);
      await refresh();
      return {};
    }));

  ipcMain.handle(IpcChannel.BotsOpen, (_e, hostId: string, botId: string) =>
    guarded(async () => {
      const host = hostOr(hostId);
      let bot = listings.get(hostId)?.bots.find((b) => b.id === botId);
      if (!bot) {
        await refresh();
        bot = listings.get(hostId)?.bots.find((b) => b.id === botId);
      }
      if (!bot) throw new Error(`no bot "${botId}" on ${host.name}`);
      const chat = ensureBotChat(host, bot);
      if (!chat) throw new Error(`another host already has a bot with the id "${botId}"`);
      void follow(chat.id);
      // The renderer reopens it the way it reopens any chat.
      return { chat };
    }));

  setTimeout(() => void refresh(), 5_000).unref?.();
  setInterval(() => void refresh(), REFRESH_MS).unref?.();
}

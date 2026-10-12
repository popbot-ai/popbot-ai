/**
 * Who manages whom — set by the user (the Make manager popup), never by
 * the agents. Only a manager may message and offer files to its workers,
 * interrupting them; everyone else — workers writing to their manager
 * included — writes mail, into the inbox, which anyone may (mailbox.ts).
 *
 * Kept as each manager's list of the chats it manages, in the settings;
 * a manager on a host is told its list there too, for the host's own
 * tools while this app is away (HostChatMeta.manages).
 */
import { AgentHost } from '../agents/AgentHost';
import { setHostChatMeta } from '../agents/hostClient';
import { getChat } from '../persistence/chats';
import { getHost } from '../persistence/hosts';
import { getSetting, setSetting } from '../persistence/settings';

const KEY = 'chats.manages';

export type Relation = 'worker' | 'manager';

export function allManages(): Record<string, string[]> {
  return getSetting<Record<string, string[]>>(KEY) ?? {};
}

export function managesOf(chatId: string): string[] {
  return allManages()[chatId] ?? [];
}

/** What `to` is to `from`: its worker, its manager, or nothing. */
export function relation(from: string, to: string): Relation | null {
  const all = allManages();
  if (all[from]?.includes(to)) return 'worker';
  if (all[to]?.includes(from)) return 'manager';
  return null;
}

export function setManages(chatId: string, workers: string[]): void {
  const clean = [...new Set(workers.filter((id) => id && id !== chatId))];
  const all = { ...allManages() };
  if (clean.length) all[chatId] = clean;
  else delete all[chatId];
  setSetting(KEY, all);
  const chat = getChat(chatId);
  if (chat?.host && !chat.host.botId) {
    const host = getHost(chat.host.hostId);
    if (host) void setHostChatMeta(host, chatId, { manages: clean });
  }
  AgentHost.emit({ type: 'chats-changed', chatId, reason: 'relations', ts: Date.now() });
}

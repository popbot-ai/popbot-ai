/**
 * The desktop's mailboxes: kept in its database, notices delivered into a
 * chat the way the user's own messages are (AgentHost.send) — a turn of
 * its own when idle, the next input when busy. See mailbox.ts for the
 * rules. Started with the popbot tools (popbotTools.ts).
 */
import { AgentHost } from '../agents/AgentHost';
import { getChat, listOpenChats } from '../persistence/chats';
import { isDbOpen } from '../persistence/db';
import { dlog } from '../diagLog';
import { Mailbox, type MailDelivery } from './mailbox';
import { relation } from './relations';
import { sqliteMailStore } from './sqliteMailStore';

/** When each chat last started a turn, from the agent events. */
const turnStarts = new Map<string, number>();

function open(chatId: string): boolean {
  return listOpenChats().some((c) => c.id === chatId);
}

const delivery: MailDelivery = {
  async notify(chatId, notice) {
    if (!isDbOpen() || !delivery.canReceive(chatId)) return false;
    try {
      await AgentHost.send(chatId, notice.text, undefined, {
        chatId: notice.fromChatId ?? 'popbot',
        chatName: notice.fromName,
        waiting: false,
        summary: notice.summary,
        notice: true,
      });
      return true;
    } catch (err) {
      dlog('mailbox.notify-failed', { chatId, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },
  lastTurnStartAt: (chatId) => turnStarts.get(chatId) ?? 0,
  // An open chat, not a bot's (bots keep their own messaging).
  canReceive: (chatId) => {
    const chat = getChat(chatId);
    return !!chat && !chat.host?.botId && open(chatId);
  },
  chatName: (chatId) => getChat(chatId)?.name ?? null,
  relation: (from, to) => relation(from, to),
};

let mailbox: Mailbox | null = null;

export function desktopMailbox(): Mailbox {
  if (!mailbox) {
    mailbox = new Mailbox(sqliteMailStore, delivery);
    AgentHost.onEvent((event) => {
      if (event.type === 'turn-start') turnStarts.set(event.chatId, event.ts);
    });
    mailbox.start();
  }
  return mailbox;
}

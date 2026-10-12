/**
 * A host's own mailboxes, for its chats while no desktop can be reached
 * (src/host/localPopbot.ts): the same rules as the desktop's
 * (src/main/mailbox/mailbox.ts), kept in `<workspaces>/mailbox.json`, a
 * notice delivered as the host's own message to the chat. A desktop that
 * comes back takes them over (GET /v1/mailbox, then POST /v1/mailbox/taken
 * — src/main/ipc/hostChatSync.ts), so its own mailbox has everything.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Mailbox, MemoryMailStore, type MailDelivery, type MailMessage } from '../main/mailbox/mailbox';
import { dlog } from '../main/diagLog';
import type { HostConfig } from './config';
import type { HostSessions } from './sessions';

export interface HostMailbox {
  mailbox: Mailbox;
  store: MemoryMailStore;
  /** Hand everything over to a desktop that came back. */
  takeAll(): MailMessage[];
  /** The desktop has them now. */
  taken(ids: string[]): void;
}

export function createHostMailbox(config: HostConfig, sessions: HostSessions): HostMailbox {
  const path = join(config.workspacesDir, 'mailbox.json');
  let initial: Array<MailMessage & { deleted?: boolean }> = [];
  if (existsSync(path)) {
    try {
      initial = JSON.parse(readFileSync(path, 'utf8')) as typeof initial;
    } catch (err) {
      dlog('host.mailbox.read-failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const save = (all: Array<MailMessage & { deleted?: boolean }>): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(all));
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      dlog('host.mailbox.write-failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };
  const store = new MemoryMailStore(initial, save);
  const delivery: MailDelivery = {
    async notify(chatId, notice) {
      if (!delivery.canReceive(chatId)) return false;
      try {
        await sessions.wake(chatId);
        await sessions.prompt(chatId, notice.text, { id: notice.fromChatId ?? 'popbot', name: notice.fromName, summary: notice.summary });
        return true;
      } catch (err) {
        dlog('host.mailbox.notify-failed', { chatId, error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },
    lastTurnStartAt: (chatId) => sessions.lastTurnStartAt(chatId),
    canReceive: (chatId) => sessions.roster.get(chatId)?.open === true,
    chatName: (chatId) => sessions.roster.get(chatId)?.name ?? null,
    relation: (from, to) => sessions.roster.relation(from, to),
  };
  const mailbox = new Mailbox(store, delivery);
  return {
    mailbox,
    store,
    takeAll: () => store.saved(),
    taken: (ids) => {
      for (const id of ids) store.drop(id);
    },
  };
}

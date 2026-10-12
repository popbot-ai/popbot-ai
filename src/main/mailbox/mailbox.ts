/**
 * Agent-to-agent messages, by mailbox (the popbot tools send_to_chat,
 * reply, list_mailbox, read_message, delete_message).
 *
 * A message never goes into an agent's conversation. What does is a
 * one-line notice that something is waiting; the agent reads what it
 * wants with its own tools, so the text lands in its tool results — never
 * mistaken for its user's words — and it can delete what it doesn't care
 * about from the 50-character summary alone. A message may be a summary
 * with no body at all.
 *
 * Two kinds of thing are sent, told differently on purpose:
 *
 *   A message (send_to_chat, or a file offered: files and messages are one
 *   system) goes only from a manager to its worker — who manages whom is
 *   the user's to say (relations.ts) — and interrupts the worker at once,
 *   with its summary: "Freddy sent you a message: Do you have build.log?
 *   (read_message m_12)". The manager is a semi-user it should heed, so it
 *   drops what it is doing; the text it reads when it asks for it.
 *
 *   Everything else waits in the inbox — a reply; mail (send_mail: any
 *   chat to any other, a file attached or not); PopBot's own notes — so
 *   the manager, busy with long work, is not pulled off it by every
 *   answer. It hears, no sooner than FIRST_NOTICE_MS after the first
 *   arrived, only a count, then again every REMIND_MS while anything is
 *   waiting:
 *
 *     after 30s   "You have 1 response waiting in your inbox."
 *     each 1m     "You still have 1 response waiting in your inbox."
 *     near expiry "You still have 1 response waiting in your inbox,
 *                  1 msg is about to expire."
 *
 *   Never a second notice while the last one has not been taken up yet
 *   (the agent has not started a turn since), so a busy agent has one
 *   waiting, not one per minute.
 *
 * Every message expires TTL_MS after it arrived, read or not: a mailbox
 * stays small, and nobody is reminded forever.
 *
 * The rules are here; where messages are kept (the desktop's database, a
 * host's file) and how a notice reaches an agent are the caller's.
 * Electron-free: the host runs it too, for its chats while no desktop
 * can be reached (src/host/localPopbot.ts).
 */
import { randomBytes } from 'node:crypto';

export interface MailMessage {
  id: string;
  /** The chat whose mailbox it is in. */
  toChatId: string;
  /** The chat that sent it; null for PopBot's own notes. */
  fromChatId: string | null;
  /** Who it is from, as shown: the sender's own name if it gave one,
   *  else its chat's name. */
  fromName: string;
  /** At most SUMMARY_MAX characters: all the receiver needs to decide. */
  summary: string;
  /** Optional: a summary may be the whole message. */
  body: string | null;
  /** The message this answers, for a reply. */
  replyTo: string | null;
  createdAt: number;
  readAt: number | null;
}

export const SUMMARY_MAX = 50;
/** A waiting message is mentioned no sooner than this after it arrived. */
export const FIRST_NOTICE_MS = 30_000;
/** Then again this often, while anything is unread. */
export const REMIND_MS = 60_000;
/** Every message is gone this long after it arrived. */
export const TTL_MS = 5 * 60_000;
/** A notice says a message is about to expire once it is this close. */
const EXPIRY_WARN_MS = 2 * 60_000;
/** A notice nobody took up this long is assumed lost, not still queued —
 *  shorter than TTL_MS, so waiting mail is still told about in time. */
const NOTICE_STALE_MS = 2 * 60_000;

export interface MailStore {
  insert(m: MailMessage): void;
  /** One message, unless deleted. */
  get(id: string): MailMessage | null;
  /** A mailbox, newest first, deleted ones left out. */
  list(chatId: string): MailMessage[];
  markRead(id: string, at: number): void;
  remove(id: string): void;
  /** Every mailbox with something unread: how much, how many of it are
   *  replies, since when, and how many arrived before `expiringBefore`. */
  unread(expiringBefore: number): UnreadBox[];
  /** Delete everything that arrived before `before`; how many. */
  expire(before: number): number;
}

export interface UnreadBox {
  chatId: string;
  count: number;
  replies: number;
  oldest: number;
  expiring: number;
}

export interface MailNotice {
  /** What the agent is sent — the notice, never a message's text. */
  text: string;
  /** How the chat shows it, folded. */
  summary: string;
  fromChatId: string | null;
  fromName: string;
}

export interface MailDelivery {
  /** Put a notice into the chat's conversation — a turn of its own when
   *  idle, its next input when busy. False when it cannot take one now
   *  (closed, gone, a bot), so it is tried again later. */
  notify(chatId: string, notice: MailNotice): Promise<boolean>;
  /** When the chat last started a turn (0: never, as far as known). */
  lastTurnStartAt(chatId: string): number;
  /** The chat exists and may be messaged. */
  canReceive(chatId: string): boolean;
  /** A chat's name, for a sender that gave none. */
  chatName(chatId: string): string | null;
  /** What `to` is to `from`, as the user set it: its worker, its
   *  manager, or nothing — and nothing may not be written to. */
  relation(from: string, to: string): 'worker' | 'manager' | null;
}

export class MailError extends Error {}

function fail(message: string): never {
  throw new MailError(message);
}

/** One line, at most SUMMARY_MAX characters. */
export function cleanSummary(summary: string): string {
  const line = summary.replace(/\s+/g, ' ').trim();
  if (!line) fail('a message needs a summary — one short line saying what it is');
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

function newId(): string {
  return `m_${randomBytes(5).toString('hex')}`;
}

export class Mailbox {
  /** When each chat was last sent a notice. */
  private readonly lastNotice = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly store: MailStore,
    private readonly delivery: MailDelivery,
    private readonly opts: { firstNoticeMs?: number; remindMs?: number; ttlMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(tickMs = 10_000): void {
    if (this.timer) return;
    // A failing tick (the database closing as the app quits) is dropped,
    // never an unhandled rejection.
    this.timer = setInterval(() => void this.tick().catch(() => undefined), tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private fromName(fromChatId: string | null, given?: string | null): string {
    return given?.trim() || (fromChatId ? this.delivery.chatName(fromChatId) : null) || fromChatId || 'PopBot';
  }

  /**
   * A new message: into the target's mailbox, and the target told at once
   * that it is there (not what it says) - unless the sender is the
   * target's own target, which reaches it only by mailbox.
   */
  async send(input: { to: string; from: string | null; senderName?: string | null; summary: string; body?: string | null }): Promise<MailMessage & { interrupted: boolean }> {
    if (input.from && input.to === input.from) fail('that is your own chat');
    if (!this.delivery.canReceive(input.to)) fail(`no chat ${input.to} to send to (list_chats shows them)`);
    // Only a manager messages its workers (as the user linked them);
    // everyone else writes mail (mail(): anyone's inbox).
    const rel = input.from ? this.delivery.relation(input.from, input.to) : 'worker';
    if (rel !== 'worker') {
      fail(
        `only a manager can message its workers, and ${this.delivery.chatName(input.to) ?? input.to} is not yours ` +
        '(list_chats relationship). To reach it, write mail with send_mail; to answer a message, use reply.',
      );
    }
    const message = this.put({ ...input, replyTo: null });
    // Taken before the notice goes in: a turn it starts at once must count
    // as after it.
    const noticeAt = this.now();
    const told = await this.delivery.notify(input.to, {
      // The target sees the summary: it is meant to heed whoever sent it,
      // and a summary may be all there is. The text it still has to ask for.
      text: `${message.fromName} sent you a message: ${message.summary}${message.body
        ? ` (popbot read_message ${message.id}; answer with popbot reply)`
        : ` (${message.id}; nothing more to read; answer with popbot reply)`}`,
      summary: message.summary,
      fromChatId: message.fromChatId,
      fromName: message.fromName,
    });
    if (told) {
      this.lastNotice.set(input.to, noticeAt);
      // A summary-only message was all in the notice: it is read.
      if (!message.body) this.store.markRead(message.id, this.now());
    }
    return { ...message, interrupted: told };
  }

  /** An answer to a message in the caller's mailbox: into the sender's
   *  mailbox, to be mentioned when it suits the sender (see above). */
  reply(input: { messageId: string; from: string; senderName?: string | null; summary: string; body?: string | null }): MailMessage {
    const original = this.store.get(input.messageId) ?? fail(`no message ${input.messageId} in your mailbox`);
    if (original.toChatId !== input.from) fail(`no message ${input.messageId} in your mailbox`);
    if (!original.fromChatId) fail('that message is from PopBot itself; it takes no reply');
    // Answering it is reading it.
    if (!original.readAt) this.store.markRead(original.id, this.now());
    return this.put({ to: original.fromChatId, from: input.from, senderName: input.senderName, summary: input.summary, body: input.body, replyTo: original.id });
  }

  /** Mail: from any chat to any other, into its inbox — told the way a
   *  worker's answers are (the count, in time), never interrupting. */
  mail(input: { to: string; from: string | null; senderName?: string | null; summary: string; body?: string | null }): MailMessage {
    if (input.from && input.to === input.from) fail('that is your own chat');
    if (!this.delivery.canReceive(input.to)) fail(`no chat ${input.to} to send to (list_chats shows them)`);
    return this.put({ ...input, replyTo: null });
  }

  /** PopBot's own note to a chat — mentioned the way replies are. */
  post(input: { to: string; from: string | null; senderName?: string | null; summary: string; body?: string | null }): MailMessage {
    return this.put({ ...input, replyTo: null });
  }

  list(chatId: string): MailMessage[] {
    return this.store.list(chatId);
  }

  read(chatId: string, id: string): MailMessage {
    const m = this.store.get(id);
    if (!m || m.toChatId !== chatId) fail(`no message ${id} in your mailbox`);
    if (!m.readAt) this.store.markRead(id, this.now());
    return { ...m, readAt: m.readAt ?? this.now() };
  }

  delete(chatId: string, ids: string[]): { deleted: string[]; missing: string[] } {
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const m = this.store.get(id);
      if (!m || m.toChatId !== chatId) missing.push(id);
      else {
        this.store.remove(id);
        deleted.push(id);
      }
    }
    return { deleted, missing };
  }

  /** Expire what is old; mention what waits, where it is time to (see the
   *  rules above). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const ttl = this.opts.ttlMs ?? TTL_MS;
      this.store.expire(now - ttl);
      const firstNoticeMs = this.opts.firstNoticeMs ?? FIRST_NOTICE_MS;
      const remindMs = this.opts.remindMs ?? REMIND_MS;
      for (const box of this.store.unread(now - (ttl - EXPIRY_WARN_MS))) {
        if (now - box.oldest < firstNoticeMs) continue;
        const last = this.lastNotice.get(box.chatId) ?? 0;
        if (last && now - last < remindMs) continue;
        // The last notice is still waiting its turn: do not stack another.
        if (last && this.delivery.lastTurnStartAt(box.chatId) < last && now - last < NOTICE_STALE_MS) continue;
        if (!this.delivery.canReceive(box.chatId)) continue;
        // "still": it was already told about what is waiting.
        const still = !!last && box.oldest <= last;
        const told = await this.delivery.notify(box.chatId, {
          text: `[PopBot, not from the user] ${inboxLine(box, still)} Read ${box.count === 1 ? 'it' : 'them'} with the popbot tool list_mailbox when convenient.`,
          summary: `${box.count} in your inbox`,
          fromChatId: null,
          fromName: 'Inbox',
        });
        if (told) this.lastNotice.set(box.chatId, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private put(input: { to: string; from: string | null; senderName?: string | null; summary: string; body?: string | null; replyTo: string | null }): MailMessage {
    const body = input.body?.trim() ? input.body : null;
    const message: MailMessage = {
      id: newId(),
      toChatId: input.to,
      fromChatId: input.from,
      fromName: this.fromName(input.from, input.senderName),
      summary: cleanSummary(input.summary),
      body,
      replyTo: input.replyTo,
      createdAt: this.now(),
      readAt: null,
    };
    this.store.insert(message);
    return message;
  }
}

/** "You (still) have 2 responses waiting in your inbox, 1 msg is about to expire." */
export function inboxLine(box: UnreadBox, still: boolean): string {
  const noun = box.replies === box.count ? 'response' : 'message';
  const what = `${box.count} ${noun}${box.count === 1 ? '' : 's'}`;
  const expiring = box.expiring > 0 ? `, ${box.expiring} msg${box.expiring === 1 ? ' is' : 's are'} about to expire` : '';
  return `You ${still ? 'still have' : 'have'} ${what} waiting in your inbox${expiring}.`;
}


/** What list_mailbox shows of a message: enough to decide, no body —
 *  and whether it is from the reader's worker, its manager, or another. */
export function mailListing(
  m: MailMessage,
  relationTo: (fromChatId: string) => 'worker' | 'manager' | null,
): { id: string; from: string; fromChat: string | null; relationship: 'WORKER' | 'MANAGER' | 'OTHER'; summary: string; hasBody: boolean; replyTo: string | null; at: string; expires: string; read: boolean } {
  const rel = m.fromChatId ? relationTo(m.fromChatId) : null;
  return {
    id: m.id,
    from: m.fromName,
    fromChat: m.fromChatId,
    relationship: rel === 'worker' ? 'WORKER' : rel === 'manager' ? 'MANAGER' : 'OTHER',
    summary: m.summary,
    hasBody: !!m.body,
    replyTo: m.replyTo,
    at: new Date(m.createdAt).toISOString(),
    expires: new Date(m.createdAt + TTL_MS).toISOString(),
    read: !!m.readAt,
  };
}

/** A store in memory, for a host that keeps its own (with a save hook)
 *  and for tests. */
export class MemoryMailStore implements MailStore {
  protected readonly messages = new Map<string, MailMessage & { deleted?: boolean }>();

  constructor(initial: Array<MailMessage & { deleted?: boolean }> = [], private readonly onChange?: (all: Array<MailMessage & { deleted?: boolean }>) => void) {
    for (const m of initial) this.messages.set(m.id, m);
  }

  all(): MailMessage[] {
    return [...this.messages.values()].filter((m) => !m.deleted);
  }

  /** Everything, deleted ones included: what a host saves. */
  saved(): Array<MailMessage & { deleted?: boolean }> {
    return [...this.messages.values()];
  }

  insert(m: MailMessage): void {
    this.messages.set(m.id, m);
    this.changed();
  }

  get(id: string): MailMessage | null {
    const m = this.messages.get(id);
    return m && !m.deleted ? m : null;
  }

  list(chatId: string): MailMessage[] {
    return this.all().filter((m) => m.toChatId === chatId).sort((a, b) => b.createdAt - a.createdAt);
  }

  markRead(id: string, at: number): void {
    const m = this.messages.get(id);
    if (m) {
      m.readAt = at;
      this.changed();
    }
  }

  remove(id: string): void {
    const m = this.messages.get(id);
    if (m && !m.deleted) {
      m.deleted = true;
      this.changed();
    }
  }

  /** Forget it altogether (a host's, once a desktop has it). */
  drop(id: string): void {
    if (this.messages.delete(id)) this.changed();
  }

  expire(before: number): number {
    let n = 0;
    for (const m of this.messages.values()) {
      if (!m.deleted && m.createdAt < before) {
        m.deleted = true;
        n += 1;
      }
    }
    if (n) this.changed();
    return n;
  }

  unread(expiringBefore: number): UnreadBox[] {
    const boxes = new Map<string, UnreadBox>();
    for (const m of this.all()) {
      if (m.readAt) continue;
      const box = boxes.get(m.toChatId) ?? { chatId: m.toChatId, count: 0, replies: 0, oldest: m.createdAt, expiring: 0 };
      box.count += 1;
      if (m.replyTo) box.replies += 1;
      if (m.createdAt < expiringBefore) box.expiring += 1;
      box.oldest = Math.min(box.oldest, m.createdAt);
      boxes.set(m.toChatId, box);
    }
    return [...boxes.values()];
  }

  private changed(): void {
    this.onChange?.(this.saved());
  }
}

/**
 * What a host remembers of the ordinary chats it runs, so it can work
 * with no desktop connected: their names and whether they are open (for
 * its own popbot tools — localPopbot.ts), and how each was last started,
 * so it can start one again itself when another chat on the host
 * messages it.
 *
 * One folder per chat under `<workspaces>/chats/<chatId>/`: `chat.json`
 * (this record) and `events.jsonl` (its event log — see sessions.ts). A
 * bot's chat is not here; the bots keep their own (bots.ts).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostChatMeta, HostSpawnBody } from '@shared/hostProtocol';
import { dlog } from '../main/diagLog';

export interface RosterChat {
  id: string;
  name: string;
  /** Closed: listed only on request, never woken. */
  open: boolean;
  /** Who last opened or closed it — the desktop, or the host's own tools
   *  while it could not be reached (a change the desktop then applies). */
  changedBy: 'desktop' | 'host';
  changedAt: number;
  /** Made by the host's own tools: a desktop adopts it when it is back. */
  createdByHost: boolean;
  /** How the desktop last started it. */
  body: HostSpawnBody;
  /** The native session to resume — the latest the agent reported. */
  sessionId: string | null;
  lastActiveAt: number;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class ChatRoster {
  private readonly chats = new Map<string, RosterChat>();

  constructor(private readonly dir: string) {
    this.load();
  }

  logPath(chatId: string): string {
    return join(this.dir, chatId, 'events.jsonl');
  }

  get(chatId: string): RosterChat | null {
    return this.chats.get(chatId) ?? null;
  }

  list(): RosterChat[] {
    return [...this.chats.values()];
  }

  /** It was started — by the desktop, or by the host waking it: remember
   *  how, so the host can again. */
  spawned(chatId: string, body: HostSpawnBody, by: 'desktop' | 'host' = 'desktop'): void {
    if (!SAFE_ID.test(chatId)) return;
    const prior = this.chats.get(chatId);
    // The host wakes only open chats, and leaves who opened it as it was.
    const keep = by === 'host' && prior;
    this.put({
      id: chatId,
      name: body.chatName?.trim() || prior?.name || chatId,
      open: true,
      changedBy: keep ? prior.changedBy : 'desktop',
      changedAt: keep ? prior.changedAt : prior?.open === false ? Date.now() : prior?.changedAt ?? Date.now(),
      createdByHost: prior?.createdByHost ?? false,
      body: { ...body, sessionId: null },
      // The desktop's choice, a fresh one included; the agent reports
      // the id it settles on (sessionId below).
      sessionId: body.sessionId ?? null,
      lastActiveAt: Date.now(),
    });
  }

  sessionId(chatId: string, sessionId: string): void {
    const chat = this.chats.get(chatId);
    if (chat && chat.sessionId !== sessionId) this.put({ ...chat, sessionId });
  }

  touch(chatId: string): void {
    const chat = this.chats.get(chatId);
    // Written at most once a minute: it orders list_chats, nothing more.
    if (chat && Date.now() - chat.lastActiveAt > 60_000) this.put({ ...chat, lastActiveAt: Date.now() });
  }

  /** A chat the host's own tools made, while no desktop could be reached. */
  created(chatId: string, body: HostSpawnBody): RosterChat {
    const chat: RosterChat = {
      id: chatId,
      name: body.chatName?.trim() || chatId,
      open: true,
      changedBy: 'host',
      changedAt: Date.now(),
      createdByHost: true,
      body: { ...body, sessionId: null },
      sessionId: null,
      lastActiveAt: Date.now(),
    };
    this.put(chat);
    return chat;
  }

  /** The host's own tools closed or reopened it. */
  setOpen(chatId: string, open: boolean): void {
    const chat = this.chats.get(chatId);
    if (chat && chat.open !== open) this.put({ ...chat, open, changedBy: 'host', changedAt: Date.now() });
  }

  meta(chatId: string, meta: HostChatMeta): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    if (meta.gone) {
      this.chats.delete(chatId);
      rmSync(join(this.dir, chatId), { recursive: true, force: true });
      dlog('host.roster.gone', { chatId });
      return;
    }
    this.put({
      ...chat,
      ...(typeof meta.name === 'string' && meta.name.trim() ? { name: meta.name.trim() } : {}),
      // The desktop has it now, whoever changed it last.
      ...(typeof meta.open === 'boolean' ? { open: meta.open, changedBy: 'desktop' as const, changedAt: Date.now() } : {}),
    });
  }

  private put(chat: RosterChat): void {
    this.chats.set(chat.id, chat);
    try {
      const folder = join(this.dir, chat.id);
      mkdirSync(folder, { recursive: true });
      const path = join(folder, 'chat.json');
      writeFileSync(`${path}.tmp`, JSON.stringify(chat, null, 2));
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      dlog('host.roster.write-failed', { chatId: chat.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private load(): void {
    if (!existsSync(this.dir)) return;
    for (const id of readdirSync(this.dir)) {
      if (!SAFE_ID.test(id)) continue;
      const path = join(this.dir, id, 'chat.json');
      if (!existsSync(path)) continue;
      try {
        const chat = JSON.parse(readFileSync(path, 'utf8')) as Partial<RosterChat>;
        if (!chat || chat.id !== id || !chat.body || typeof chat.name !== 'string') continue;
        this.chats.set(id, {
          ...(chat as RosterChat),
          open: chat.open !== false,
          changedBy: chat.changedBy === 'host' ? 'host' : 'desktop',
          changedAt: typeof chat.changedAt === 'number' ? chat.changedAt : 0,
          createdByHost: chat.createdByHost === true,
        });
      } catch (err) {
        dlog('host.roster.read-failed', { chatId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

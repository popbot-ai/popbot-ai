import { randomUUID } from 'node:crypto';
import type { MessageKind, MessageRecord, MessageRole } from '@shared/persistence';
import { db } from './db';
import { searchMessagesSql, type SqlPredicates } from './fts';

interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  kind: string;
  body: string;
  created_at: number;
  updated_at: number;
}

function rowToRecord(r: MessageRow): MessageRecord {
  return {
    id: r.id,
    chatId: r.chat_id,
    role: r.role as MessageRole,
    kind: r.kind as MessageKind,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * List a chat's messages oldest-first. When `tail` is set, only the
 * most recent `tail` messages are loaded — used by the thumbnail
 * cards which only render the last few activity lines anyway and
 * shouldn't pay the cost of pulling thousand-message transcripts
 * across IPC just to show 6 lines.
 */
export function listMessages(chatId: string, tail?: number): MessageRecord[] {
  if (tail != null && tail > 0) {
    // Pull the last N in DESC order (cheap with the index), then flip
    // back to ASC to match the unbounded behavior callers expect.
    const rows = db()
      .prepare<[string, number], MessageRow>(
        'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(chatId, tail);
    rows.reverse();
    return rows.map(rowToRecord);
  }
  const rows = db()
    .prepare<[string], MessageRow>(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(chatId);
  return rows.map(rowToRecord);
}

/**
 * The `limit` messages just before a given one (oldest-first) — the next
 * page of history above what a chat view has loaded. A long chat is
 * opened at its tail and read back a page at a time, never whole.
 */
export function listMessagesBefore(chatId: string, before: { createdAt: number; id: string }, limit: number): MessageRecord[] {
  const rows = db()
    .prepare<[string, number, number, string, number], MessageRow>(
      `SELECT * FROM messages WHERE chat_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(chatId, before.createdAt, before.createdAt, before.id, Math.max(1, Math.min(limit, 5_000)));
  rows.reverse();
  return rows.map(rowToRecord);
}

/** How many rows a chat has (index-only). */
export function countMessages(chatId: string): number {
  return db()
    .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
    .get(chatId)?.n ?? 0;
}

/** Rows `offset`… of a chat (listMessages order), at most `limit` — a
 *  window read without loading the rest of the chat. */
export function listMessagesRange(chatId: string, offset: number, limit: number): MessageRecord[] {
  return db()
    .prepare<[string, number, number], MessageRow>(
      `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
    )
    .all(chatId, Math.max(0, limit), Math.max(0, offset))
    .map(rowToRecord);
}

/** Messages created at or after `since`, oldest-first. */
export function listMessagesSince(chatId: string, since: number): MessageRecord[] {
  return db()
    .prepare<[string, number], MessageRow>(
      'SELECT * FROM messages WHERE chat_id = ? AND created_at >= ? ORDER BY created_at ASC, id ASC',
    )
    .all(chatId, since)
    .map(rowToRecord);
}

/** Has the chat a message of this role at all? (Without reading them.) */
export function hasMessageWithRole(chatId: string, role: MessageRole): boolean {
  return !!db()
    .prepare<[string, string], { one: number }>('SELECT 1 AS one FROM messages WHERE chat_id = ? AND role = ? LIMIT 1')
    .get(chatId, role);
}

/** The newest message of a kind (and role, when given), if any. */
export function lastMessageOfKind(chatId: string, kind: MessageKind, role?: MessageRole): MessageRecord | null {
  // The user's rows through idx_messages_user_at, which a bound role
  // can't use: otherwise every agent row since the last prompt is read.
  const row = role === 'user'
    ? db()
      .prepare<[string, string], MessageRow>(
        "SELECT * FROM messages WHERE chat_id = ? AND kind = ? AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(chatId, kind)
    : role
    ? db()
      .prepare<[string, string, string], MessageRow>(
        'SELECT * FROM messages WHERE chat_id = ? AND kind = ? AND role = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(chatId, kind, role)
    : db()
      .prepare<[string, string], MessageRow>(
        'SELECT * FROM messages WHERE chat_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(chatId, kind);
  return row ? rowToRecord(row) : null;
}

/** User rows whose body contains `needle` (a reply id, say). */
export function userMessagesContaining(chatId: string, needle: string): MessageRecord[] {
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db()
    .prepare<[string, string], MessageRow>(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'user' AND body LIKE ? ESCAPE '\\' ORDER BY created_at ASC",
    )
    .all(chatId, `%${escaped}%`)
    .map(rowToRecord);
}

/**
 * The conversation's text turns (user and agent) changed after `since`,
 * for priming a session from the transcript: the first `head` of them,
 * the newest `tail`, and how many there are in all — the middle of a
 * long chat is never read.
 */
export function textTurnsSince(
  chatId: string,
  since: number,
  opts: { head: number; tail: number },
): { head: MessageRecord[]; tail: MessageRecord[]; total: number } {
  // Through idx_messages_text_turns (v29): the chat's text rows only —
  // the whole chat, tool rows and all, is never walked.
  const where = "chat_id = ? AND kind = 'text' AND role IN ('user', 'agent') AND updated_at > ?";
  const from = 'messages INDEXED BY idx_messages_text_turns';
  const total = (db()
    .prepare<[string, number], { n: number }>(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`)
    .get(chatId, since)?.n) ?? 0;
  const head = opts.head > 0
    ? db().prepare<[string, number, number], MessageRow>(`SELECT * FROM ${from} WHERE ${where} ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(chatId, since, opts.head).map(rowToRecord)
    : [];
  const tail = db()
    .prepare<[string, number, number], MessageRow>(`SELECT * FROM ${from} WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(chatId, since, opts.tail)
    .reverse()
    .map(rowToRecord);
  return { head, tail, total };
}

export interface MessageSearchHit {
  message: MessageRecord;
  /** bm25 score: lower is a better match. */
  rank: number;
}

/**
 * Full-text search over message bodies (see fts.ts). `match` is an FTS5
 * MATCH expression — build it with {@link ftsQueryFor} — or null to list
 * by the predicates alone, newest first. Scoped to `chatIds` when given;
 * archived chats' messages only with `includeClosed`. Throws on FTS5
 * syntax errors in a raw query.
 */
export function searchMessages(
  match: string | null,
  opts: { chatIds?: string[]; includeClosed?: boolean; limit?: number; predicates?: SqlPredicates } = {},
): MessageSearchHit[] {
  const chatIds = opts.chatIds ?? [];
  const predicates = opts.predicates ?? { where: [], params: [] };
  const rows = db()
    .prepare<unknown[], MessageRow & { rank: number }>(
      searchMessagesSql({
        chatIdCount: chatIds.length,
        includeClosed: opts.includeClosed === true,
        useFts: match !== null,
        extraWhere: predicates.where,
      }),
    )
    .all(...(match !== null ? [match] : []), ...chatIds, ...predicates.params, opts.limit ?? 50);
  return rows.map((r) => ({ message: rowToRecord(r), rank: r.rank }));
}

/** A message's position in its chat — the index listMessages would give
 *  it — so a search hit can be read in context with get_chat_transcript. */
export function indexOfMessage(m: Pick<MessageRecord, 'id' | 'chatId' | 'createdAt'>): number {
  // Two counts so the big one is index-only; only rows sharing its
  // timestamp are read for their id.
  const row = db()
    .prepare<[string, number, string, number, string], { n: number }>(
      `SELECT (SELECT COUNT(*) FROM messages WHERE chat_id = ? AND created_at < ?)
            + (SELECT COUNT(*) FROM messages WHERE chat_id = ? AND created_at = ? AND id < ?) AS n`,
    )
    .get(m.chatId, m.createdAt, m.chatId, m.createdAt, m.id);
  return row?.n ?? 0;
}

export function getMessage(id: string): MessageRecord | null {
  const row = db().prepare<[string], MessageRow>('SELECT * FROM messages WHERE id = ?').get(id);
  return row ? rowToRecord(row) : null;
}

/** Whether a chat has any non-system message — anything the user or
 *  agent actually said. Used by boot-time recovery to distinguish a
 *  brand-new chat (no real activity, nothing to recover) from one
 *  that lost its session pin and genuinely needs to be reattached.
 *  Stops at the first such row. */
export function hasAgentOrUserMessages(chatId: string): boolean {
  return !!db()
    .prepare<[string], { x: number }>(
      `SELECT 1 AS x FROM messages WHERE chat_id = ? AND role IN ('user', 'agent') LIMIT 1`,
    )
    .get(chatId);
}

export interface AppendMessageArgs {
  id?: string;
  chatId: string;
  role: MessageRole;
  kind: MessageKind;
  body: unknown;
}

export function appendMessage(args: AppendMessageArgs): MessageRecord {
  const now = Date.now();
  const id = args.id ?? 'msg_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  db()
    .prepare(
      'INSERT INTO messages (id, chat_id, role, kind, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, args.chatId, args.role, args.kind, body, now, now);
  return {
    id,
    chatId: args.chatId,
    role: args.role,
    kind: args.kind,
    body,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Drop every persisted diagnostic row (`error:` / `warning:` / `notice:`
 * system messages) from the transcripts.
 *
 * Diagnostics are ephemeral now — they live in renderer memory and
 * vanish on the next reply. This clears the ones written by older
 * builds, which otherwise greet you with the last five failures every
 * time you reopen a chat, long after they stopped mattering.
 *
 * Returns how many rows were removed.
 */
export function purgePersistedDiagnostics(): number {
  const res = db()
    .prepare(
      `DELETE FROM messages
        WHERE kind = 'system'
          AND role = 'system'
          AND (
            json_extract(body, '$.text') LIKE 'error:%'
            OR json_extract(body, '$.text') LIKE 'warning:%'
            OR json_extract(body, '$.text') LIKE 'notice:%'
          )`,
    )
    .run();
  return res.changes;
}

export function deleteMessage(id: string): void {
  db().prepare('DELETE FROM messages WHERE id = ?').run(id);
}

export function updateMessageBody(id: string, body: unknown): void {
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  db()
    .prepare('UPDATE messages SET body = ?, updated_at = ? WHERE id = ?')
    .run(serialized, Date.now(), id);
}

/**
 * When the user last said something in each chat — the newest `user`
 * row's created_at, keyed by chat id. Drives review re-engagement: a
 * prompt from the user is the signal that they looked again, whereas
 * the chat's last_active_at is bumped by the agent's own activity and
 * so would count an original review that merely finished after the
 * author pushed as a re-review. One seek per chat into
 * idx_messages_user_at (v29), which holds only the user's rows — the end
 * of that run is the answer, however many agent rows came after.
 */
export function lastUserMessageAtByChat(chatIds: string[]): Map<string, number> {
  const stmt = db().prepare<[string], { at: number | null }>(
    "SELECT MAX(created_at) AS at FROM messages WHERE chat_id = ? AND role = 'user'",
  );
  const out = new Map<string, number>();
  for (const id of chatIds) {
    const at = stmt.get(id)?.at;
    if (at != null) out.set(id, at);
  }
  return out;
}

/**
 * Duplicate a chat's transcript into another chat — the fork's copy of
 * the conversation. Rows keep their timestamps (ordering, relative
 * times, and the provider-context watermarks all compare against them)
 * and get fresh ids (message ids are global primary keys). Returns how
 * many rows were copied.
 */
export function copyMessages(fromChatId: string, toChatId: string): number {
  const conn = db();
  const rows = conn
    .prepare<[string], MessageRow>(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(fromChatId);
  const insert = conn.prepare(
    'INSERT INTO messages (id, chat_id, role, kind, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  conn.transaction(() => {
    for (const r of rows) {
      insert.run(
        'msg_' + randomUUID().replace(/-/g, '').slice(0, 12),
        toChatId,
        r.role,
        r.kind,
        r.body,
        r.created_at,
        r.updated_at,
      );
    }
  })();
  return rows.length;
}

import { randomUUID } from 'node:crypto';
import type { MessageKind, MessageRecord, MessageRole } from '@shared/persistence';
import { db } from './db';

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

export function getMessage(id: string): MessageRecord | null {
  const row = db().prepare<[string], MessageRow>('SELECT * FROM messages WHERE id = ?').get(id);
  return row ? rowToRecord(row) : null;
}

/** Count non-system messages for a chat — i.e. anything the user or
 *  agent actually said. Used by boot-time recovery to distinguish a
 *  brand-new chat (no real activity, nothing to recover) from one
 *  that lost its session pin and genuinely needs to be reattached. */
export function countAgentOrUserMessages(chatId: string): number {
  const row = db()
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND role IN ('user', 'agent')`,
    )
    .get(chatId);
  return row?.n ?? 0;
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

export function updateMessageBody(id: string, body: unknown): void {
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  db()
    .prepare('UPDATE messages SET body = ?, updated_at = ? WHERE id = ?')
    .run(serialized, Date.now(), id);
}

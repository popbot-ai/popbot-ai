/** The desktop's mailboxes, in its database (schema v28). */
import { db } from '../persistence/db';
import type { MailMessage, MailStore, UnreadBox } from './mailbox';

interface Row {
  id: string;
  to_chat_id: string;
  from_chat_id: string | null;
  from_name: string;
  summary: string;
  body: string | null;
  reply_to: string | null;
  created_at: number;
  read_at: number | null;
}

function toMessage(r: Row): MailMessage {
  return {
    id: r.id,
    toChatId: r.to_chat_id,
    fromChatId: r.from_chat_id,
    fromName: r.from_name,
    summary: r.summary,
    body: r.body,
    replyTo: r.reply_to,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

export const sqliteMailStore: MailStore = {
  insert(m) {
    db()
      .prepare(
        `INSERT OR IGNORE INTO mailbox (id, to_chat_id, from_chat_id, from_name, summary, body, reply_to, created_at, read_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.toChatId, m.fromChatId, m.fromName, m.summary, m.body, m.replyTo, m.createdAt, m.readAt);
  },
  get(id) {
    const row = db().prepare<[string], Row>('SELECT * FROM mailbox WHERE id = ? AND deleted_at IS NULL').get(id);
    return row ? toMessage(row) : null;
  },
  list(chatId) {
    return db()
      .prepare<[string], Row>('SELECT * FROM mailbox WHERE to_chat_id = ? AND deleted_at IS NULL ORDER BY created_at DESC')
      .all(chatId)
      .map(toMessage);
  },
  markRead(id, at) {
    db().prepare('UPDATE mailbox SET read_at = ? WHERE id = ? AND read_at IS NULL').run(at, id);
  },
  remove(id) {
    db().prepare('UPDATE mailbox SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
  },
  expire(before) {
    return db().prepare('UPDATE mailbox SET deleted_at = ? WHERE deleted_at IS NULL AND created_at < ?').run(Date.now(), before).changes;
  },
  unread(expiringBefore) {
    return db()
      .prepare<[number], UnreadBox>(
        `SELECT to_chat_id AS chatId, COUNT(*) AS count,
            SUM(CASE WHEN reply_to IS NOT NULL THEN 1 ELSE 0 END) AS replies,
            MIN(created_at) AS oldest,
            SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END) AS expiring
          FROM mailbox WHERE deleted_at IS NULL AND read_at IS NULL GROUP BY to_chat_id`,
      )
      .all(expiringBefore);
  },
};

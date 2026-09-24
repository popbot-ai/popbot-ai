/**
 * Full-text search over message text: an FTS5 table beside `messages`,
 * kept current by triggers, so a fragment of an identifier or an error
 * message finds the chat it was in — open or archived — in milliseconds
 * instead of a LIKE scan over every body.
 *
 * Trigram tokenizer, deliberately: transcripts are half code, and what
 * people remember is a fragment (`ndAndWa`, `ECONNRE`), not a word. The
 * index holds every three-character run, case-folded, so a plain query
 * is a case-insensitive substring match with an index behind it. The
 * price is an index about three times the text and a three-character
 * minimum per query.
 *
 * The indexed text is derived from the JSON body in SQL (json_extract),
 * so the backends and appendMessage know nothing about it: text and
 * system rows contribute their text; tool rows their name, arguments and
 * result; permission rows the tool and arguments. Streaming text is
 * flushed to the DB every 250 ms and the update trigger re-indexes the
 * row each time — a few milliseconds of work per flush, and the index is
 * never behind.
 *
 * Pure SQL and helpers, no DB handle: db.ts runs the migration, and the
 * integration check runs the same SQL against a scratch database.
 */

import type { SearchFilters } from '@shared/searchQuery';

/** Trigram tokens are three characters; shorter queries match nothing. */
export const MIN_FTS_QUERY_CHARS = 3;

/** Plain text of a message row, for the index. `r` is the row alias. */
function indexedText(r: string): string {
  return `CASE
    WHEN NOT json_valid(${r}.body) THEN ''
    WHEN ${r}.kind = 'tool' THEN
      coalesce(json_extract(${r}.body, '$.name'), '') || ' ' ||
      coalesce(json_extract(${r}.body, '$.args'), '') || ' ' ||
      coalesce(json_extract(${r}.body, '$.result'), '')
    WHEN ${r}.kind = 'permission' THEN
      coalesce(json_extract(${r}.body, '$.tool'), '') || ' ' ||
      coalesce(json_extract(${r}.body, '$.args'), '')
    ELSE coalesce(json_extract(${r}.body, '$.text'), '')
  END`;
}

/**
 * The migration: the FTS table, the triggers that maintain it, and a
 * backfill of every existing row. `messages_fts.rowid` is `messages.rowid`
 * (messages has a TEXT primary key, so its rowid is implicit but stable —
 * PopBot never VACUUMs).
 */
export const FTS_MIGRATION_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text,
    chat_id UNINDEXED,
    tokenize = 'trigram'
  );
  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text, chat_id)
      VALUES (new.rowid, ${indexedText('new')}, new.chat_id);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF body, kind ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.rowid;
    INSERT INTO messages_fts(rowid, text, chat_id)
      VALUES (new.rowid, ${indexedText('new')}, new.chat_id);
  END;
  INSERT INTO messages_fts(rowid, text, chat_id)
    SELECT m.rowid, ${indexedText('m')}, m.chat_id FROM messages m;
`;

export type FtsQueryMode = 'text' | 'fts';

/**
 * The MATCH expression for a search. `text` (the default) treats the
 * query as a literal substring: quoted as one phrase, which with trigram
 * tokens is exactly a case-insensitive substring match. `fts` passes
 * FTS5 syntax through ("phrase", AND, OR, NOT, NEAR(…)). Null when the
 * query is too short to match anything.
 */
export function ftsQueryFor(query: string, mode: FtsQueryMode = 'text'): string | null {
  const q = query.trim();
  if (!q) return null;
  if (mode === 'fts') return q;
  if (q.length < MIN_FTS_QUERY_CHARS) return null;
  return `"${q.replace(/"/g, '""')}"`;
}

/** Extra predicates on the message (`m`) / chat (`c`) join, with their
 *  parameters in order. */
export interface SqlPredicates {
  where: string[];
  params: unknown[];
}

/**
 * The query-language tags (see shared/searchQuery.ts) as predicates.
 * They trim the rows the full-text match (or, without text, the whole
 * table) produces; none of them needs an index of its own.
 */
export function filterPredicates(f: SearchFilters, now: number = Date.now()): SqlPredicates {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.ticket === true) where.push('c.ticket IS NOT NULL');
  else if (typeof f.ticket === 'string') { where.push('c.ticket = ? COLLATE NOCASE'); params.push(f.ticket); }
  if (f.cr === true) where.push('c.pr IS NOT NULL');
  else if (typeof f.cr === 'number') { where.push('c.pr = ?'); params.push(f.cr); }
  if (f.lastMs) { where.push('m.created_at >= ?'); params.push(now - f.lastMs); }
  if (f.from && f.from.length > 0) {
    const parts: string[] = [];
    for (const who of f.from) {
      if (who === 'user') parts.push("m.role = 'user'");
      else if (who === 'agent') parts.push("(m.role = 'agent' AND m.kind = 'text')");
      else if (who === 'tool') parts.push("m.kind = 'tool'");
      else if (who === 'system') parts.push("m.role = 'system'");
    }
    if (parts.length > 0) where.push(`(${parts.join(' OR ')})`);
  }
  if (f.tool) { where.push("m.kind = 'tool' AND json_valid(m.body) AND json_extract(m.body, '$.name') LIKE ?"); params.push(`%${f.tool}%`); }
  if (f.agent) { where.push('c.agent = ?'); params.push(f.agent); }
  if (f.in === 'open') where.push('c.closed_at IS NULL');
  else if (f.in === 'archive') where.push('c.closed_at IS NOT NULL');
  if (f.chat) { where.push('c.name LIKE ?'); params.push(`%${f.chat}%`); }
  if (f.repo) { where.push('c.repo_id = ?'); params.push(f.repo); }
  return { where, params };
}

/**
 * The search statement. With `useFts` (the normal case) the parameters
 * are: the MATCH expression, the chat ids (when `chatIdCount` > 0), the
 * extra predicates' params, then the limit; best matches first (bm25),
 * ties by recency. Without it — tags but no text — the MATCH parameter
 * is omitted and the newest rows come first.
 */
export function searchMessagesSql(opts: {
  chatIdCount: number;
  includeClosed: boolean;
  useFts?: boolean;
  extraWhere?: string[];
}): string {
  const useFts = opts.useFts !== false;
  const chatFilter = opts.chatIdCount > 0
    ? `AND m.chat_id IN (${Array.from({ length: opts.chatIdCount }, () => '?').join(', ')})`
    : '';
  const closedFilter = opts.includeClosed ? '' : 'AND c.closed_at IS NULL';
  const extra = (opts.extraWhere ?? []).map((w) => `AND ${w}`).join('\n       ');
  return useFts
    ? `
    SELECT m.id, m.chat_id, m.role, m.kind, m.body, m.created_at, m.updated_at,
           bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      JOIN chats c ON c.id = m.chat_id
     WHERE messages_fts MATCH ?
       AND c.deleted_at IS NULL
       ${closedFilter}
       ${chatFilter}
       ${extra}
     ORDER BY rank, m.created_at DESC
     LIMIT ?`
    : `
    SELECT m.id, m.chat_id, m.role, m.kind, m.body, m.created_at, m.updated_at,
           0 AS rank
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
     WHERE c.deleted_at IS NULL
       ${closedFilter}
       ${chatFilter}
       ${extra}
     ORDER BY m.created_at DESC
     LIMIT ?`;
}

/** Chats with at least one matching message — for the archive search box. */
export const CHATS_WITH_MATCH_SQL = 'SELECT DISTINCT chat_id FROM messages_fts WHERE messages_fts MATCH ?';

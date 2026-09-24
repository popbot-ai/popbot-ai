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

/**
 * The search statement. Parameters, in order: the MATCH expression, then
 * the chat ids (when `chatIdCount` > 0), then the limit. Best matches
 * first (bm25); ties by recency.
 */
export function searchMessagesSql(opts: { chatIdCount: number; includeClosed: boolean }): string {
  const chatFilter = opts.chatIdCount > 0
    ? `AND m.chat_id IN (${Array.from({ length: opts.chatIdCount }, () => '?').join(', ')})`
    : '';
  const closedFilter = opts.includeClosed ? '' : 'AND c.closed_at IS NULL';
  return `
    SELECT m.id, m.chat_id, m.role, m.kind, m.body, m.created_at, m.updated_at,
           bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      JOIN chats c ON c.id = m.chat_id
     WHERE messages_fts MATCH ?
       AND c.deleted_at IS NULL
       ${closedFilter}
       ${chatFilter}
     ORDER BY rank, m.created_at DESC
     LIMIT ?`;
}

/** Chats with at least one matching message — for the archive search box. */
export const CHATS_WITH_MATCH_SQL = 'SELECT DISTINCT chat_id FROM messages_fts WHERE messages_fts MATCH ?';

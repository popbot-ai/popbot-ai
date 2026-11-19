/**
 * Keeps the database from growing without bound. Chats are mostly tool
 * output — command results, file reads, patches — and the conversation
 * around it is a sliver: on a 20 GB database, every prompt and reply in
 * every chat came to 51 MB. So:
 *
 *   - A chat's tool output is trimmed to a short head once it is older
 *     than its newest KEEP_ROWS rows, or older than the retention set in
 *     Preferences (toolRetention: 20 days by default; off keeps it all).
 *     The call itself — command, file path — stays.
 *   - Search indexes the conversation only (fts.ts, v30); the tool rows an
 *     older index holds are taken out.
 *   - codex_thread_events, a log of every Codex event that nothing ever
 *     read (13 GB on one machine), is emptied and dropped.
 *
 * It runs on a worker thread of its own (janitorWorker.ts), never the
 * main thread, and in slices: each does what fits in its time budget and
 * commits, so the main thread is never kept waiting long to write. The
 * offline compactor (scripts/compact-db.mjs) runs the same work with no
 * budget, then VACUUMs.
 */
import type Database from 'better-sqlite3';
import { conversationRow } from './fts';
import { clampToolResultTtlDays, type MessageBodyTool, type ToolRetentionSettings } from '@shared/persistence';

/** Rows of a chat kept whole — about what a chat view ever holds. */
export const KEEP_ROWS = 1_000;
/** What a trimmed tool row keeps of its output; output this short or
 *  shorter is left alone (rewriting it gains nothing). */
const RESULT_HEAD = 2_048;
const RESULT_MIN_TRIM = 4_096;
/** What it keeps of each long argument (a whole file passed to Write). */
const ARG_HEAD = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const FTS_DONE_KEY = 'janitor.ftsUnindexedTo';

type Conn = Database.Database;

/** Trim one tool body. Null when there is nothing to trim. */
export function trimToolBody(body: MessageBodyTool & { trimmed?: boolean }): (MessageBodyTool & { trimmed: true }) | null {
  if (body.trimmed) return null;
  let changed = false;
  let result = body.result;
  if (typeof result === 'string' && result.length > RESULT_MIN_TRIM) {
    result = `${result.slice(0, RESULT_HEAD)}\n\n[trimmed by PopBot retention: ${result.length - RESULT_HEAD} more bytes dropped]`;
    changed = true;
  }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body.args ?? {})) {
    if (typeof v === 'string' && v.length > ARG_HEAD + 100) {
      args[k] = `${v.slice(0, ARG_HEAD)}… [${v.length - ARG_HEAD} more characters trimmed]`;
      changed = true;
    } else if (v !== null && typeof v === 'object' && JSON.stringify(v).length > RESULT_HEAD) {
      const s = JSON.stringify(v);
      args[k] = `${s.slice(0, ARG_HEAD)}… [${s.length - ARG_HEAD} more characters trimmed]`;
      changed = true;
    } else {
      args[k] = v;
    }
  }
  if (!changed) return null;
  return { ...body, args, ...(result !== undefined ? { result } : {}), trimmed: true };
}

function tableExists(conn: Conn, name: string): boolean {
  return !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function getSettingOf<T>(conn: Conn, key: string): T | null {
  const row = conn.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(key);
  try { return row ? (JSON.parse(row.value) as T) : null; } catch { return null; }
}

function getNumberSetting(conn: Conn, key: string): number {
  const n = Number(getSettingOf<number>(conn, key) ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function setNumberSetting(conn: Conn, key: string, value: number): void {
  conn
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), Date.now());
}

/** Empty the old Codex event log, a row at a time (a row can be megabytes); drop it once empty. */
function dropCodexEvents(conn: Conn, deadline: number): boolean {
  if (!tableExists(conn, 'codex_thread_events')) return false;
  const del = conn.prepare(
    'DELETE FROM codex_thread_events WHERE rowid IN (SELECT rowid FROM codex_thread_events ORDER BY rowid LIMIT 1)',
  );
  while (Date.now() < deadline) {
    if (del.run().changes === 0) {
      conn.exec('DROP TABLE codex_thread_events');
      return false;
    }
  }
  return true;
}

/** Take rows that aren't the conversation (tool output, messages sent in
 *  by other chats and PopBot) out of the search index, walking messages
 *  by rowid.
 *  FTS5 does much of a delete's work when the transaction commits —
 *  after the deadline is checked — so it gets a quarter of the slice. */
function unindexToolRows(conn: Conn, sliceDeadline: number): boolean {
  if (!tableExists(conn, 'messages_fts')) return false;
  const deadline = Math.min(sliceDeadline, Date.now() + Math.max(2, (sliceDeadline - Date.now()) / 4));
  const maxRow = conn.prepare<[], { m: number | null }>('SELECT MAX(rowid) AS m FROM messages').get()?.m ?? 0;
  let from = getNumberSetting(conn, FTS_DONE_KEY);
  if (from >= maxRow) return false;
  const next = conn.prepare<[number], { rowid: number; keep: number }>(
    `SELECT rowid, ${conversationRow('m')} AS keep FROM messages m WHERE rowid > ? ORDER BY rowid LIMIT 50`,
  );
  const unindex = conn.prepare('DELETE FROM messages_fts WHERE rowid = ?');
  while (Date.now() < deadline && from < maxRow) {
    const rows = next.all(from);
    if (rows.length === 0) { from = maxRow; break; }
    for (const r of rows) {
      if (!r.keep) unindex.run(r.rowid);
      from = r.rowid;
      if (Date.now() >= deadline) break;
    }
  }
  setNumberSetting(conn, FTS_DONE_KEY, from);
  return from < maxRow;
}

/** Where a trim pass has got to: chats are walked by id, a few per
 *  slice. Null between passes. */
let trimCursor: string | null = null;

/** A message sent in by another chat or PopBot, trimmed like tool output.
 *  Null when there is nothing to trim. */
export function trimSentInBody(body: { text?: string; from?: unknown; trimmed?: boolean }): Record<string, unknown> | null {
  if (body.trimmed || !body.from || typeof body.text !== 'string' || body.text.length <= RESULT_MIN_TRIM) return null;
  const text = `${body.text.slice(0, RESULT_HEAD)}\n\n[trimmed by PopBot retention: ${body.text.length - RESULT_HEAD} more bytes dropped]`;
  return { ...body, text, trimmed: true };
}

/** Trim tool output — and messages sent in by other chats and PopBot —
 *  older than each chat's newest KEEP_ROWS rows or the retention age. One pass over every chat, across as many slices as it
 *  takes; true until the pass is through. */
function trimOldToolOutput(conn: Conn, deadline: number, now: number): boolean {
  const retention = getSettingOf<ToolRetentionSettings>(conn, 'toolRetention');
  if (retention?.pruneResults === false) return false;
  const ageCutoff = now - clampToolResultTtlDays(retention?.resultTtlDays) * DAY_MS;
  const chats = conn
    .prepare<[string], { id: string; trimmed_before: number }>(
      'SELECT id, trimmed_before FROM chats WHERE id >= ? ORDER BY id',
    )
    .all(trimCursor ?? '');
  // The created_at of a chat's KEEP_ROWS-th newest row: index-only.
  const cutoffOf = conn.prepare<[string, number], { created_at: number }>(
    'SELECT created_at FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?',
  );
  const batch = conn.prepare<[string, number, number, number, number, number], { rowid: number; created_at: number; kind: string; role: string; body: string }>(
    `SELECT rowid, created_at, kind, role, body FROM messages
      WHERE chat_id = ? AND created_at < ? AND (created_at > ? OR (created_at = ? AND rowid > ?))
      ORDER BY created_at, rowid LIMIT ?`,
  );
  const write = conn.prepare('UPDATE messages SET body = ? WHERE rowid = ?');
  const done = conn.prepare('UPDATE chats SET trimmed_before = ? WHERE id = ?');
  for (const chat of chats) {
    trimCursor = chat.id;
    if (Date.now() >= deadline) return true;
    const cutoff = Math.max(cutoffOf.get(chat.id, KEEP_ROWS - 1)?.created_at ?? 0, ageCutoff);
    if (cutoff <= chat.trimmed_before) continue;
    // Keyset over (created_at, rowid) from where the last pass stopped.
    let at = chat.trimmed_before - 1;
    let row = Number.MAX_SAFE_INTEGER;
    for (;;) {
      if (Date.now() >= deadline) {
        // Part way: rows before `at` are done (those at `at` may not be).
        if (at > chat.trimmed_before) done.run(at, chat.id);
        return true;
      }
      const rows = batch.all(chat.id, cutoff, at, at, row, 20);
      if (rows.length === 0) break;
      for (const r of rows) {
        at = r.created_at;
        row = r.rowid;
        const tool = r.kind === 'tool';
        if (!tool && !(r.kind === 'text' && r.role === 'user')) continue;
        let body: unknown;
        try { body = JSON.parse(r.body); } catch { continue; }
        const trimmed = tool ? trimToolBody(body as MessageBodyTool) : trimSentInBody(body as { text?: string });
        if (trimmed) write.run(JSON.stringify(trimmed), r.rowid);
      }
    }
    done.run(cutoff, chat.id);
  }
  trimCursor = null;
  return false;
}

/**
 * One slice of janitor work, within `budgetMs`. True while there is more
 * to do — call again later.
 */
export function janitorSlice(conn: Conn, budgetMs: number, now: number = Date.now()): boolean {
  const deadline = Date.now() + budgetMs;
  // One transaction a slice: one sync to disk, not one per row. IMMEDIATE:
  // it takes the write lock up front, waiting its turn (busy_timeout) — a
  // read upgraded to a write mid-way fails outright if the main thread
  // wrote in between.
  return conn.transaction(() => {
    if (dropCodexEvents(conn, deadline)) return true;
    if (unindexToolRows(conn, deadline)) return true;
    return trimOldToolOutput(conn, deadline, now);
  }).immediate();
}

/** Mark the search index as holding only the conversation (it was rebuilt). */
export function markIndexClean(conn: Conn): void {
  const maxRow = conn.prepare<[], { m: number | null }>('SELECT MAX(rowid) AS m FROM messages').get()?.m ?? 0;
  setNumberSetting(conn, FTS_DONE_KEY, maxRow);
}

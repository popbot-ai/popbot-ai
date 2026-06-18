import type {
  SessionStore,
  SessionKey,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import { db } from '../persistence/db';
import { dlog } from '../diagLog';

/**
 * SQLite-backed implementation of the SDK's `SessionStore` adapter.
 *
 * Storage model: rows are persisted with their original SDK key
 * (`project_key`, `session_id`, `subpath`, `seq`, `uuid`, `payload`)
 * AND tagged with `chat_id` resolved at write time from
 * `chats.session_id`. The KEY insight: query reads now scope on
 * `session_id` (which is globally unique to a single SDK session)
 * rather than `project_key`. That decouples chat memory from cwd —
 * a chat that switches slots between activations still resumes its
 * full history, because we no longer care that `project_key` changed.
 *
 * `chat_id` is the durable association of a session to the chat that
 * owns it; it lets `discoverSessionId` enumerate "all sessions ever
 * owned by this chat" without depending on slot identity.
 *
 * Why opaque payloads: SDK transcript entries are a CLI-internal
 * discriminated union (messages, tool calls, summaries, compaction
 * boundaries, mode markers, …). Treating them as pass-through bytes
 * means SDK upgrades that add entry types pass through us unchanged.
 *
 * Concurrency: SDK spec says append calls within a single process
 * must persist in call order. We use better-sqlite3's synchronous
 * API inside a transaction per `append()` call, which is naturally
 * serialized by Node's event loop. `seq` is `MAX(seq) + 1` over the
 * scoped result set, computed inside the same transaction so two
 * concurrent appends can't collide.
 */
export class SqliteSessionStore implements SessionStore {
  /** Look up the chat that owns a session_id via `chats.session_id`.
   *  Returns null when no chat is pinned to this id (orphan session —
   *  may happen briefly during the spawn race or for sessions that
   *  outlived their chat). */
  private chatIdFor(sessionId: string): string | null {
    const row = db()
      .prepare<[string], { id: string }>(
        'SELECT id FROM chats WHERE session_id = ? LIMIT 1',
      )
      .get(sessionId);
    return row?.id ?? null;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const subpath = key.subpath ?? '';
    const now = Date.now();
    const chatId = this.chatIdFor(key.sessionId);

    const conn = db();
    const insert = conn.prepare(
      `INSERT INTO sdk_session_entries
         (project_key, session_id, subpath, seq, uuid, payload, created_at, chat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_key, session_id, subpath, uuid)
       WHERE uuid IS NOT NULL
       DO NOTHING`,
    );
    // Seq is now scoped on (session_id, subpath) — not project_key —
    // so a chat that moves slots gets a continuous seq across the
    // move rather than two independent counters.
    const nextSeq = conn.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS s
         FROM sdk_session_entries
        WHERE session_id = ? AND subpath = ?`,
    );

    const tx = conn.transaction((batch: SessionStoreEntry[]) => {
      const row = nextSeq.get(key.sessionId, subpath) as { s: number };
      let seq = row.s;
      for (const entry of batch) {
        seq += 1;
        const uuid = typeof entry.uuid === 'string' ? entry.uuid : null;
        const payload = JSON.stringify(entry);
        insert.run(key.projectKey, key.sessionId, subpath, seq, uuid, payload, now, chatId);
      }
    });
    tx(entries);
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const subpath = key.subpath ?? '';
    // Query on session_id alone — globally unique to one SDK session,
    // regardless of which slot it was active in when written.
    // project_key is intentionally NOT in the WHERE clause: that's
    // exactly the cross-slot bleed we're fixing.
    const rows = db()
      .prepare(
        `SELECT payload FROM sdk_session_entries
          WHERE session_id = ? AND subpath = ?
          ORDER BY seq ASC`,
      )
      .all(key.sessionId, subpath) as Array<{ payload: string }>;
    if (rows.length === 0) {
      // Per SDK contract: null means "never written." Empty array would
      // mean "deliberately emptied" which we don't currently produce.
      return null;
    }
    const out: SessionStoreEntry[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.payload) as SessionStoreEntry);
      } catch (err) {
        dlog('sqlite-session-store.load.bad-row', {
          sessionId: key.sessionId,
          subpath,
          error: (err as Error).message,
        });
      }
    }
    return out;
  }

  /** SDK-facing list. project_key-scoped per the SessionStore contract,
   *  but we mostly use {@link listSessionsForChat} for our own calls
   *  (it's chat-keyed and what the slot-independence fix relies on). */
  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const rows = db()
      .prepare(
        `SELECT session_id AS sessionId, MAX(created_at) AS mtime
           FROM sdk_session_entries
          WHERE project_key = ? AND subpath = ''
          GROUP BY session_id`,
      )
      .all(projectKey) as Array<{ sessionId: string; mtime: number }>;
    return rows;
  }

  /** Chat-keyed session list — what discoverSessionId uses to find
   *  resume candidates for a chat regardless of which slot it ever
   *  occupied. Returns sessionIds + their most-recent write time +
   *  entry count.
   *
   *  Ordered by entryCount DESC, mtime DESC so the *richest* session
   *  comes first. Empty respawns (a handful of entries from a fresh
   *  spawn that never produced real conversation) must NEVER outrank
   *  a real working session just because they were touched last —
   *  that was the slot-reuse-leak symptom this whole refactor exists
   *  to fix. */
  listSessionsForChat(chatId: string): Array<{ sessionId: string; mtime: number; entryCount: number }> {
    const rows = db()
      .prepare<[string], { sessionId: string; mtime: number; entryCount: number }>(
        `SELECT session_id AS sessionId, MAX(created_at) AS mtime, COUNT(*) AS entryCount
           FROM sdk_session_entries
          WHERE chat_id = ? AND subpath = ''
          GROUP BY session_id
          ORDER BY entryCount DESC, mtime DESC`,
      )
      .all(chatId);
    return rows;
  }

  /** Hard-delete a specific session. session_id alone is the key —
   *  globally unique per SDK contract, so project_key is irrelevant
   *  for identification (and was the bug source). */
  async delete(key: SessionKey): Promise<void> {
    const subpath = key.subpath ?? '';
    db()
      .prepare(
        `DELETE FROM sdk_session_entries
          WHERE session_id = ? AND subpath = ?`,
      )
      .run(key.sessionId, subpath);
  }

  /** Lets the SDK discover subagent transcripts at resume. */
  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const rows = db()
      .prepare(
        `SELECT DISTINCT subpath FROM sdk_session_entries
          WHERE session_id = ? AND subpath != ''`,
      )
      .all(key.sessionId) as Array<{ subpath: string }>;
    return rows.map((r) => r.subpath);
  }

  /** Hard-delete every session row for a chat. Used by the chat
   *  hard-delete path so deleted chats leave nothing behind. */
  deleteAllForChat(chatId: string): void {
    db()
      .prepare(`DELETE FROM sdk_session_entries WHERE chat_id = ?`)
      .run(chatId);
  }

  /** Legacy back-compat for callers that still pass project_key. */
  deleteAllForProject(projectKey: string): void {
    db()
      .prepare(`DELETE FROM sdk_session_entries WHERE project_key = ?`)
      .run(projectKey);
  }
}

/** Singleton instance. The SDK shares one store across every
 *  `query()` call — `key` namespaces everything. */
export const sqliteSessionStore = new SqliteSessionStore();

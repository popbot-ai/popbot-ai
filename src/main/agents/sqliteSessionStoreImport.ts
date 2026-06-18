import { importSessionToStore } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { sqliteSessionStore } from './sqliteSessionStore';
import { sdkSessionJsonlPath } from './AgentHost';
import { db } from '../persistence/db';
import { dlog } from '../diagLog';

/**
 * One-time migration to backfill SqliteSessionStore from any existing
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` files referenced
 * by chats already in our DB.
 *
 * Why: pre-sessionStore, the CLI's local JSONL was the only durable
 * copy of conversation context. Chats created before sessionStore landed
 * have transcripts on disk but nothing in `sdk_session_entries`. Without
 * this migration, the first time we resume one of those chats the
 * SDK's `load()` would return null and the chat would lose its memory
 * — exactly the bug we're trying to retire.
 *
 * Idempotent — guarded by a settings-key flag so we don't re-import
 * on every boot. The SDK's `importSessionToStore` is also idempotent
 * per-uuid via SqliteSessionStore.append's ON CONFLICT, so re-running
 * by hand is safe.
 *
 * Best-effort per chat: if a single import fails (JSONL corrupt,
 * cwd-encoded path doesn't exist, etc.) we log and continue. The chat
 * falls back to "claude has no memory of past turns" on next resume,
 * which is the *current* behavior we're trying to fix — so partial
 * success is still strictly better than not running at all.
 */

const FLAG_KEY = 'sdk-session-store.import-complete-v1';

interface ChatRow {
  id: string;
  session_id: string | null;
  worktree_path: string | null;
}

export async function importExistingJsonlsIfNeeded(): Promise<void> {
  const conn = db();
  const flag = conn
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(FLAG_KEY) as { value: string } | undefined;
  if (flag) {
    dlog('sqlite-session-store.import.skipped', { reason: 'already-done' });
    return;
  }

  const chats = conn
    .prepare(
      `SELECT id, session_id, worktree_path FROM chats
        WHERE session_id IS NOT NULL AND worktree_path IS NOT NULL`,
    )
    .all() as ChatRow[];

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (const chat of chats) {
    if (!chat.session_id || !chat.worktree_path) continue;
    const jsonlPath = sdkSessionJsonlPath(chat.worktree_path, chat.session_id);
    if (!jsonlPath || !existsSync(jsonlPath)) {
      skipped += 1;
      continue;
    }
    try {
      await importSessionToStore(chat.session_id, sqliteSessionStore, {
        dir: chat.worktree_path,
      });
      imported += 1;
      dlog('sqlite-session-store.import.ok', {
        chatId: chat.id,
        sessionId: chat.session_id,
        jsonlPath,
      });
    } catch (err) {
      failed += 1;
      dlog('sqlite-session-store.import.failed', {
        chatId: chat.id,
        sessionId: chat.session_id,
        jsonlPath,
        error: (err as Error).message,
      });
    }
  }

  // Mark complete regardless of partial failures — re-running won't
  // help (the failures are deterministic), and we don't want to retry
  // the whole table on every boot.
  conn
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(
      FLAG_KEY,
      JSON.stringify({ at: Date.now(), imported, skipped, failed }),
      Date.now(),
    );
  dlog('sqlite-session-store.import.done', { imported, skipped, failed, total: chats.length });
}

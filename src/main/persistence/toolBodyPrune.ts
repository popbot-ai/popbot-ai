/**
 * Tool-result retention: a recurring sweep that shortens the `result`
 * text of old `tool` messages.
 *
 * Why this exists, with numbers from a real install: a 9.0 GB database
 * whose single largest contributor was tool output. 177,290 `tool` rows
 * held 1.44 GB of body, 1.27 GB of that in the `result` field alone, and
 * `Bash` results were 1.18 GB of it across 142,199 rows. Because the FTS
 * trigger indexes `$.result`, every one of those bytes is stored a second
 * and third time in `messages_fts_content` and `messages_fts_data`
 * (4.24 GB between them). Trimming a result therefore reclaims roughly
 * three times what the body itself holds.
 *
 * What it does NOT do: delete messages, touch `args`/`name`/`isError`,
 * or change anything inside the retention window. A trimmed row keeps a
 * readable head plus a marker saying how much went, so a transcript
 * never silently lies about what a command printed.
 *
 * Space is returned to SQLite's free list, not to the filesystem — the
 * file stops growing but does not shrink without a VACUUM, which needs
 * roughly the size of the database in scratch space and minutes of
 * exclusive access. That stays a deliberate, separate operation.
 */
import {
  clampToolResultTtlDays,
  type ToolRetentionSettings,
} from '@shared/persistence';
import { db, isDbOpen } from './db';
import { getSetting } from './settings';
import { dlog } from '../diagLog';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keep this much of the head of a trimmed result. Enough to see what a
 *  command did and how it started failing; far below the 8 KB average so
 *  the sweep actually reclaims something. */
export const TOOL_RESULT_HEAD_BYTES = 2048;

/** Results at or below this are left alone whatever their age — the
 *  overhead of rewriting the row and reindexing it exceeds the gain. */
export const TOOL_RESULT_MIN_TRIM_BYTES = 4096;

/** Rows per transaction. Bounded so the sweep can't hold a long write
 *  lock or balloon the WAL on a database this size. */
const BATCH = 500;

/** Read live from Preferences, like the attachment sweep, so a changed
 *  setting takes effect on the next pass without a restart. */
function settings(): { enabled: boolean; ttlMs: number } {
  const s = getSetting<ToolRetentionSettings>('toolRetention');
  return {
    enabled: s?.pruneResults !== false,
    ttlMs: clampToolResultTtlDays(s?.resultTtlDays) * DAY_MS,
  };
}

export interface PruneResult {
  scanned: number;
  trimmed: number;
  bytesFreed: number;
}

/**
 * Shorten old tool results. Returns what it did so callers can log it.
 *
 * `json_set` rewrites only the `result` member, so the row keeps its
 * toolUseId, name, args and isError — the UI still renders the call, it
 * just no longer carries megabytes of stdout. The UPDATE fires the
 * existing FTS trigger, which re-indexes the row from the shortened
 * body; that is what reclaims the index copies.
 */
export function pruneOldToolResults(now = Date.now()): PruneResult {
  const out: PruneResult = { scanned: 0, trimmed: 0, bytesFreed: 0 };
  if (!isDbOpen()) return out;
  const { enabled, ttlMs } = settings();
  if (!enabled) return out;
  const cutoff = now - ttlMs;

  const d = db();
  // Pre-filter on length() in SQL so the scan never materialises a
  // multi-megabyte body just to measure it.
  const find = d.prepare<[number, number], { id: string; len: number }>(
    `SELECT id, length(json_extract(body, '$.result')) AS len
       FROM messages
      WHERE kind = 'tool'
        AND created_at < ?
        AND json_valid(body)
        AND length(json_extract(body, '$.result')) > ?
      LIMIT ${BATCH}`,
  );
  const trim = d.prepare<[number, number, string]>(
    `UPDATE messages
        SET body = json_set(
              body,
              '$.result',
              substr(json_extract(body, '$.result'), 1, ?)
                || char(10) || char(10)
                || '[trimmed by PopBot retention: ' || ? || ' more bytes dropped]'
            )
      WHERE id = ?`,
  );

  // Batch until a pass finds nothing. Each batch is its own transaction,
  // so an interrupted sweep leaves the database consistent and simply
  // resumes next time.
  for (;;) {
    const rows = find.all(cutoff, TOOL_RESULT_MIN_TRIM_BYTES);
    if (rows.length === 0) break;
    const run = d.transaction((batch: typeof rows) => {
      for (const r of batch) {
        const dropped = r.len - TOOL_RESULT_HEAD_BYTES;
        if (dropped <= 0) continue;
        trim.run(TOOL_RESULT_HEAD_BYTES, dropped, r.id);
        out.trimmed += 1;
        out.bytesFreed += dropped;
      }
    });
    run(rows);
    out.scanned += rows.length;
    // A batch that trimmed nothing would loop forever on the same rows.
    if (out.trimmed === 0) break;
  }

  if (out.trimmed > 0) {
    dlog('messages.tool-results-pruned', {
      trimmed: out.trimmed,
      mbFreed: +(out.bytesFreed / 1e6).toFixed(1),
      ttlDays: ttlMs / DAY_MS,
    });
  }
  return out;
}

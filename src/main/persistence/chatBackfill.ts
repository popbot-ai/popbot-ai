import type { ChatRecord } from '@shared/persistence';
import { setChatTicketIfMissing, setChatPrIfMissing, getChat } from './chats';
import { db } from './db';
import { dlog } from '../diagLog';

/**
 * Parse a Linear identifier (e.g. `ENG-20512`, `OPS-7`) out of a free-
 * form string. Linear IDs are 2–5 uppercase letters, hyphen, digits.
 * Returns the FIRST match — chat names like "ENG-20512 · ENG-20513"
 * almost never happen and a single match is what every consumer wants.
 */
export function parseTicketFromText(text: string): string | null {
  if (!text) return null;
  const m = /\b([A-Z]{2,5}-\d+)\b/.exec(text);
  return m ? m[1] : null;
}

/**
 * Parse a PR number out of a free-form string. Matches `PR #1234`,
 * `pr #1234`, `#1234`, etc. Anchored on a `#` followed by digits to
 * avoid pulling out arbitrary numbers (Linear identifiers, version
 * numbers, etc.).
 */
export function parsePrFromText(text: string): number | null {
  if (!text) return null;
  // `PR #N` is preferred — accept loose spacing/case.
  const pr = /\bPR\s*#\s*(\d+)\b/i.exec(text);
  if (pr) return Number(pr[1]);
  // Bare `#N` is OK as a fallback (covers PR titles like "#1234 fix
  // foo"). Avoid matching mid-word digits by requiring a leading
  // word boundary on the `#`.
  const hash = /(^|\s)#(\d+)\b/.exec(text);
  if (hash) return Number(hash[2]);
  return null;
}

/**
 * Inspect a chat's name (and optionally a fetched PR's title/body)
 * and backfill `chat.ticket` / `chat.pr` if either is currently null
 * and we can parse a value out. Returns the chat after backfill.
 *
 * Idempotent: only writes when the column is null. We never overwrite
 * a value the user / a previous parse already set.
 */
export function backfillChatFields(chatId: string, opts?: {
  prTitle?: string;
  prBody?: string;
}): ChatRecord | null {
  const chat = getChat(chatId);
  if (!chat) return null;

  let didChange = false;

  // Ticket: chat name first, then any PR text we have.
  if (chat.ticket === null) {
    const candidate =
      parseTicketFromText(chat.name)
      ?? parseTicketFromText(opts?.prTitle ?? '')
      ?? parseTicketFromText(opts?.prBody ?? '');
    if (candidate !== null) {
      const wrote = setChatTicketIfMissing(chatId, candidate);
      if (wrote) {
        dlog('chat-backfill.ticket', { chatId, ticket: candidate, source: 'parse' });
        didChange = true;
      }
    }
  }

  // PR number: parse from the chat name. We don't try to derive a PR
  // number from PR text (chicken-and-egg).
  if (chat.pr === null) {
    const candidate = parsePrFromText(chat.name);
    if (candidate !== null) {
      const wrote = setChatPrIfMissing(chatId, candidate);
      if (wrote) {
        dlog('chat-backfill.pr', { chatId, pr: candidate, source: 'parse' });
        didChange = true;
      }
    }
  }

  return didChange ? getChat(chatId) : chat;
}

/**
 * One-shot at boot: scan every non-deleted chat and backfill
 * ticket/pr from the chat name where missing. Idempotent + cheap
 * (single SQL scan, only updates rows that have a parseable value).
 */
export function backfillAllChats(): void {
  const rows = db()
    .prepare(
      `SELECT id, name, ticket, pr FROM chats
        WHERE deleted_at IS NULL
          AND (ticket IS NULL OR pr IS NULL)`,
    )
    .all() as Array<{ id: string; name: string; ticket: string | null; pr: number | null }>;
  let touched = 0;
  for (const r of rows) {
    if (r.ticket === null) {
      const t = parseTicketFromText(r.name);
      if (t && setChatTicketIfMissing(r.id, t)) touched += 1;
    }
    if (r.pr === null) {
      const n = parsePrFromText(r.name);
      if (n !== null && setChatPrIfMissing(r.id, n)) touched += 1;
    }
  }
  dlog('chat-backfill.boot', { scanned: rows.length, touched });
}

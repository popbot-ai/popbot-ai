/**
 * Transcript search: the query's tags (shared/searchQuery.ts) become SQL
 * predicates, the FTS index narrows the rows to the text (see
 * persistence/fts.ts), then the text around each hit is cut from the row
 * itself so `contextChars` means characters, not trigrams. Tags with no
 * text list the newest matching rows instead. Shared by the renderer's
 * Search panel (IPC) and the popbot MCP tool.
 */
import type { TranscriptSearchHit, TranscriptSearchOptions, TranscriptSearchResult } from '@shared/ipc';
import { parseSearchQuery, withSearchDefaults } from '@shared/searchQuery';
import { MIN_FTS_QUERY_CHARS, filterPredicates, ftsQueryFor } from '../persistence/fts';
import { getChat, listOpenChats } from '../persistence/chats';
import { indexOfMessage, searchMessages } from '../persistence/messages';
import { searchTranscript, transcriptEntries } from '../mcp/transcript';

export function searchTranscripts(query: string, opts: TranscriptSearchOptions = {}): TranscriptSearchResult {
  const mode = opts.mode ?? 'text';
  const contextChars = opts.contextChars ?? 200;
  const maxResults = Math.max(1, opts.maxResults ?? 20);
  const parsed = parseSearchQuery(query);
  const text = parsed.text;
  // Tags alone list the newest rows they select; text needs the index.
  const match = text ? ftsQueryFor(text, mode) : null;
  if (!match && (text || !parsed.hasFilters)) {
    return { ok: false, error: `the search needs at least ${MIN_FTS_QUERY_CHARS} characters (or a filter tag such as ticket: or last:week)` };
  }
  // An explicit in: tag decides the archive scope; else the caller's option.
  const includeClosed = parsed.filters.in ? parsed.filters.in !== 'open' : opts.includeClosed === true;

  let rows;
  try {
    rows = searchMessages(match, {
      chatIds: opts.chatIds,
      includeClosed,
      // User and agent messages unless from: says otherwise — tool output
      // and patches are most of the bytes and rarely what's being sought.
      predicates: filterPredicates(withSearchDefaults(parsed.filters)),
      limit: Math.max(50, maxResults * 3),
    });
  } catch (err) {
    return { ok: false, error: `bad search query: ${err instanceof Error ? err.message : String(err)}` };
  }

  const openIds = new Set(listOpenChats().map((c) => c.id));
  const names = new Map<string, string>();
  const hits: TranscriptSearchHit[] = [];
  for (const { message } of rows) {
    if (hits.length >= maxResults) break;
    if (!names.has(message.chatId)) names.set(message.chatId, getChat(message.chatId)?.name ?? message.chatId);
    const entry = transcriptEntries([message], { includeTools: true })[0];
    if (!entry) continue;
    const base = {
      chatId: message.chatId,
      chatName: names.get(message.chatId)!,
      closed: !openIds.has(message.chatId),
      messageId: message.id,
      index: indexOfMessage(message),
      role: message.role,
      kind: message.kind,
      ts: message.createdAt,
    };
    if (!match || mode === 'fts') {
      // No text, or operators that can't be located as one substring:
      // show the row's start.
      hits.push({ ...base, offset: 0, before: '', match: entry.text.slice(0, contextChars * 2), after: '' });
      continue;
    }
    for (const m of searchTranscript([entry], text, { contextChars, maxResults: maxResults - hits.length, caseSensitive: opts.caseSensitive })) {
      hits.push({ ...base, offset: m.offset, before: m.before, match: m.match, after: m.after });
    }
  }
  return { ok: true, hits };
}

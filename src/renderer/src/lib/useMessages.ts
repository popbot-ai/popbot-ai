import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MessageBodyText,
  MessageBodyTool,
  MessageRecord,
} from '@shared/persistence';
import { subscribeAgentEvents } from './agentEventBus';

/**
 * Loads a chat's messages from the DB and patches them in place as
 * agent events arrive — no per-event refetch.
 *
 * Live edits we apply (mirroring the AgentHost persistence flow so the
 * renderer view stays consistent with the DB without a round-trip):
 *   text-delta  → append to the matching text row's body.text
 *   tool-use    → upsert a tool row keyed by toolUseId
 *   tool-result → merge result + isError into the matching tool row
 *   permission-request → upsert a permission row
 *
 * On message-start / message-end we just trust the event and let the
 * AgentHost-side row insertion show up via the next stream tick.
 */
/**
 * @param tail when set, only the last N messages are loaded from the
 *   DB on mount. Live agent events still patch in normally; this only
 *   bounds the initial backfill. Used by thumbnail cards (which only
 *   render the last few activity lines) to avoid hauling thousand-
 *   message transcripts across IPC + holding them in JS memory N times.
 */
/** Marks a row that exists only in renderer memory — a diagnostic that
 *  must never reach the DB and must not outlive the next real reply. */
const EPHEMERAL_PREFIX = 'eph_';
let ephemeralSeq = 0;
const dropEphemeral = (rows: MessageRecord[]): MessageRecord[] =>
  rows.some((m) => m.id.startsWith(EPHEMERAL_PREFIX))
    ? rows.filter((m) => !m.id.startsWith(EPHEMERAL_PREFIX))
    : rows;

/** A chat view opens at its newest messages and reads older history back
 *  a page at a time (loadOlder) — a long chat is never loaded whole. */
export const MESSAGE_PAGE = 500;
/** A chat that grows past this many loaded messages while it runs … */
export const TRIM_ABOVE = 1000;
/** … drops back to its newest this many (older ones reload on scroll). */
export const TRIM_TO = 500;

export function useMessages(chatId: string | undefined, tail?: number) {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  // More above what is loaded (a full first page, or a full last page).
  const [hasOlder, setHasOlder] = useState(false);
  const olderInFlight = useRef<Promise<number> | null>(null);
  const messagesRef = useRef<MessageRecord[]>([]);
  messagesRef.current = messages;
  // Paging applies to the full view only; a thumbnail asks for its few.
  const page = tail ?? MESSAGE_PAGE;

  useEffect(() => {
    if (!chatId) {
      setMessages([]);
      setLoading(false);
      setHasOlder(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.popbot.chats.listMessages(chatId, page).then((rows) => {
      if (!cancelled) {
        setMessages(rows);
        setHasOlder(tail === undefined && rows.length >= page);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, tail, page]);

  /** Read the page above the oldest loaded message; resolves to how many
   *  were added at the front (0 when the start of the chat is reached). */
  const loadOlder = useCallback((): Promise<number> => {
    if (!chatId || tail !== undefined) return Promise.resolve(0);
    if (olderInFlight.current) return olderInFlight.current;
    const oldest = messagesRef.current.find((m) => !m.id.startsWith(EPHEMERAL_PREFIX));
    if (!oldest) return Promise.resolve(0);
    const run = window.popbot.chats
      .listMessagesBefore(chatId, { createdAt: oldest.createdAt, id: oldest.id }, MESSAGE_PAGE)
      .then((rows) => {
        if (rows.length < MESSAGE_PAGE) setHasOlder(false);
        const have = new Set(messagesRef.current.map((m) => m.id));
        const fresh = rows.filter((m) => !have.has(m.id));
        if (fresh.length === 0) return 0;
        setMessages((prev) => [...fresh, ...prev]);
        return fresh.length;
      })
      .finally(() => {
        olderInFlight.current = null;
      });
    olderInFlight.current = run;
    return run;
  }, [chatId, tail]);

  useEffect(() => {
    if (!chatId) return;
    const off = subscribeAgentEvents((event) => {
      if (event.chatId !== chatId) return;
      setMessages((prev) => {
        switch (event.type) {
          case 'message-added': {
            if (prev.some((m) => m.id === event.message.id)) return prev;
            return [...prev, event.message];
          }
          case 'message-removed': {
            return prev.filter((m) => m.id !== event.messageId);
          }
          // Diagnostics live here and ONLY here — they are never written
          // to the DB. A timeout that resolved itself isn't part of the
          // conversation, so it must not survive the reply that fixed
          // it, let alone still be sitting there on reload tomorrow.
          case 'error': {
            return [
              ...prev,
              {
                id: `${EPHEMERAL_PREFIX}${event.ts}_${ephemeralSeq++}`,
                chatId: event.chatId,
                role: 'system',
                kind: 'system',
                body: JSON.stringify({
                  text: `${event.level ?? 'error'}: ${event.message}`,
                } satisfies MessageBodyText),
                createdAt: event.ts,
                updatedAt: event.ts,
              },
            ];
          }
          // Compaction progress is shown the way diagnostics are:
          // "Compacting…" and a failure are ephemeral rows (dropped by the
          // outcome, or by the next reply), while the completed note comes
          // from AgentHost as a persisted row via message-added.
          case 'compaction': {
            const kept = dropEphemeral(prev);
            if (event.phase === 'done') return kept;
            const text = event.phase === 'started'
              ? 'compacting:'
              : `compactfail: ${event.error ?? ''}`;
            return [
              ...kept,
              {
                id: `${EPHEMERAL_PREFIX}${event.ts}_${ephemeralSeq++}`,
                chatId: event.chatId,
                role: 'system',
                kind: 'system',
                body: JSON.stringify({ text } satisfies MessageBodyText),
                createdAt: event.ts,
                updatedAt: event.ts,
              },
            ];
          }
          case 'message-start': {
            // A real reply is starting — every diagnostic that preceded
            // it is now moot (that's what "resolved" looks like), so
            // clear them out rather than leaving them above the answer.
            const kept = dropEphemeral(prev);
            // AgentHost has inserted a row; reflect it locally so we don't
            // wait for a refetch. If the row already exists (race), keep it.
            if (kept.some((m) => m.id === event.messageId)) return kept;
            return [
              ...kept,
              {
                id: event.messageId,
                chatId: event.chatId,
                role: event.role,
                kind: 'text',
                body: JSON.stringify({ text: '' } satisfies MessageBodyText),
                createdAt: event.ts,
                updatedAt: event.ts,
              },
            ];
          }
          case 'text-delta': {
            // The streaming row is at (or near) the end: look from there,
            // and copy the list once rather than visiting every row.
            let at = -1;
            for (let i = prev.length - 1; i >= 0; i -= 1) {
              if (prev[i].id === event.messageId) { at = i; break; }
            }
            if (at < 0) return prev;
            const m = prev[at];
            const next = prev.slice();
            next[at] = {
              ...m,
              body: JSON.stringify({ text: parseTextBody(m.body).text + event.delta } satisfies MessageBodyText),
              updatedAt: event.ts,
            };
            return next;
          }
          case 'tool-use': {
            const id = 'tool_' + event.toolUseId;
            const existing = prev.find((m) => m.id === id);
            if (!existing) {
              return [
                ...prev,
                {
                  id,
                  chatId: event.chatId,
                  role: 'agent',
                  kind: 'tool',
                  body: JSON.stringify({
                    toolUseId: event.toolUseId,
                    name: event.name,
                    args: event.args,
                  } satisfies MessageBodyTool),
                  createdAt: event.ts,
                  updatedAt: event.ts,
                },
              ];
            }
            // Merge: tool-use can fire twice (partial + finalized). Prefer
            // non-empty incoming values.
            return prev.map((m) => {
              if (m.id !== id) return m;
              const pb = parseToolBody(m.body);
              return {
                ...m,
                body: JSON.stringify({
                  ...pb,
                  name: event.name || pb.name,
                  args: Object.keys(event.args).length > 0 ? event.args : pb.args,
                } satisfies MessageBodyTool),
                updatedAt: event.ts,
              };
            });
          }
          case 'tool-result': {
            const id = 'tool_' + event.toolUseId;
            return prev.map((m) => {
              if (m.id !== id) return m;
              const body = parseToolBody(m.body);
              return {
                ...m,
                body: JSON.stringify({
                  ...body,
                  result: event.text,
                  isError: event.isError,
                } satisfies MessageBodyTool),
                updatedAt: event.ts,
              };
            });
          }
          case 'permission-request': {
            const id = 'perm_' + event.permissionId;
            if (prev.some((m) => m.id === id)) return prev;
            return [
              ...prev,
              {
                id,
                chatId: event.chatId,
                role: 'system',
                kind: 'permission',
                body: JSON.stringify({
                  permissionId: event.permissionId,
                  tool: event.tool,
                  args: event.args,
                  reason: event.reason,
                }),
                createdAt: event.ts,
                updatedAt: event.ts,
              },
            ];
          }
          case 'permission-decided': {
            const id = 'perm_' + event.permissionId;
            return prev.map((m) => {
              if (m.id !== id) return m;
              try {
                const body = JSON.parse(m.body) as Record<string, unknown>;
                return {
                  ...m,
                  body: JSON.stringify({ ...body, decision: event.decision }),
                  updatedAt: event.ts,
                };
              } catch {
                return m;
              }
            });
          }
          default:
            return prev;
        }
      });
    });
    return off;
  }, [chatId]);

  /** Forget all but the newest `keep` loaded messages: a long-running chat
   *  must not hold its whole growth in memory. They are still there to
   *  read back (loadOlder). */
  const trimOlder = useCallback((keep: number) => {
    if (tail !== undefined) return;
    setMessages((prev) => (prev.length > keep ? prev.slice(-keep) : prev));
    setHasOlder(true);
  }, [tail]);

  return { messages, loading, hasOlder, loadOlder, trimOlder };
}

function parseTextBody(body: string): MessageBodyText {
  try {
    return JSON.parse(body);
  } catch {
    return { text: '' };
  }
}

function parseToolBody(body: string): MessageBodyTool {
  try {
    return JSON.parse(body);
  } catch {
    return { toolUseId: '', name: '', args: {} };
  }
}

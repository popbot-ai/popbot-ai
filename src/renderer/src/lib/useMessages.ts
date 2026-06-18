import { useEffect, useState } from 'react';
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
export function useMessages(chatId: string | undefined, tail?: number) {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!chatId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.popbot.chats.listMessages(chatId, tail).then((rows) => {
      if (!cancelled) {
        setMessages(rows);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
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
          case 'message-start': {
            // AgentHost has inserted a row; reflect it locally so we don't
            // wait for a refetch. If the row already exists (race), keep it.
            if (prev.some((m) => m.id === event.messageId)) return prev;
            return [
              ...prev,
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
            return prev.map((m) => {
              if (m.id !== event.messageId) return m;
              const body = parseTextBody(m.body);
              return {
                ...m,
                body: JSON.stringify({ text: body.text + event.delta } satisfies MessageBodyText),
                updatedAt: event.ts,
              };
            });
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

  return { messages, loading };
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

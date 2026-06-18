import { useCallback, useEffect, useState } from 'react';
import type { ChatRecord } from '@shared/persistence';
import type { ChatStatus } from '@shared/domain';
import type { CloseChatOptions, CreateChatInput, CreateChatResult, ReopenChatResult } from '@shared/ipc';
import { playPing } from './ping';
import { subscribeAgentEvents } from './agentEventBus';

const SESSION_STATUS_TO_CHAT_STATUS: Record<string, ChatStatus> = {
  running: 'run',
  idle: 'idle',
  paused: 'wait',
  errored: 'err',
  complete: 'done',
};

/**
 * Loads the open-chats list from main, subscribes to agent events to
 * roll forward chat metadata (status, snippet, tokens) without a full
 * refetch, and exposes mutators (create / close / refresh).
 *
 * Per CORE_MODEL.md: the chat *list* lives in the DB, but the field
 * updates the user sees during a stream are derived from agent events.
 * We don't refetch the whole list every event; we patch in place.
 */
export function useChats() {
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [closedChats, setClosedChats] = useState<ChatRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [open, closed] = await Promise.all([
      window.popbot.chats.list(),
      window.popbot.chats.listClosed(),
    ]);
    setChats(open);
    setClosedChats(closed);
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    const off = subscribeAgentEvents((event) => {
      setChats((prev) => {
        let touched = false;
        const next: ChatRecord[] = prev.map((c): ChatRecord => {
          if (c.id !== event.chatId) return c;
          touched = true;
          switch (event.type) {
            case 'session-status': {
              const next = SESSION_STATUS_TO_CHAT_STATUS[event.status] ?? c.status;
              // Mirror the main-side guard: end-of-turn 'idle' must not
              // clobber a 'wait' set by the question-detect or perm flow.
              if (next === 'idle' && c.status === 'wait') return c;
              if (next === 'wait' && c.status !== 'wait') playPing();
              return {
                ...c,
                status: next,
                lastActiveAt: event.ts,
              };
            }
            case 'usage':
              return { ...c, tokensUsed: event.tokens.used, tokensBudget: event.tokens.budget };
            case 'permission-request':
              if (c.status !== 'wait') playPing();
              return { ...c, status: 'wait' satisfies ChatStatus, snippet: `needs you: ${event.tool}`, lastActiveAt: event.ts };
            case 'message-end':
              return { ...c, lastActiveAt: event.ts };
            default:
              return c;
          }
        });
        return touched ? next : prev;
      });
    });
    return off;
  }, []);

  const create = useCallback(async (input: CreateChatInput): Promise<CreateChatResult> => {
    const result = await window.popbot.chats.create(input);
    if (result.ok) {
      // Append → new chat lands at the right of the column + thumbnail
      // strip, matching the listOpenChats ASC ordering on reload.
      setChats((prev) => [...prev, result.chat]);
    }
    return result;
  }, []);

  const close = useCallback(async (chatId: string, opts?: CloseChatOptions) => {
    await window.popbot.chats.close(chatId, opts);
    setChats((prev) => {
      const found = prev.find((c) => c.id === chatId);
      if (found) {
        setClosedChats((p) => [{ ...found, slotId: null, worktreePath: null, lastActiveAt: Date.now() }, ...p]);
      }
      return prev.filter((c) => c.id !== chatId);
    });
  }, []);

  const reopen = useCallback(async (chatId: string): Promise<ReopenChatResult> => {
    const result = await window.popbot.chats.reopen(chatId);
    if (result.ok) {
      setClosedChats((prev) => prev.filter((c) => c.id !== chatId));
      setChats((prev) => [result.chat, ...prev.filter((c) => c.id !== chatId)]);
    }
    return result;
  }, []);

  const attachSlot = useCallback(async (chatId: string): Promise<CreateChatResult> => {
    const result = await window.popbot.chats.attachSlot(chatId);
    if (result.ok) {
      const updated = result.chat;
      setChats((prev) => prev.map((c) => (c.id === chatId ? updated : c)));
    }
    return result;
  }, []);

  const remove = useCallback(async (chatId: string) => {
    await window.popbot.chats.delete(chatId);
    setChats((prev) => prev.filter((c) => c.id !== chatId));
    setClosedChats((prev) => prev.filter((c) => c.id !== chatId));
  }, []);

  return { chats, closedChats, loading, refresh, create, close, reopen, attachSlot, remove };
}

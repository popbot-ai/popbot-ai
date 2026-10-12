import { useCallback, useEffect, useState } from 'react';
import { subscribeAgentEvents } from './agentEventBus';

export type AutoContinueMode = 'forever' | 'until-complete';

/** Each chat's auto-continue mode, kept current — including when a chat
 *  that finished its work switches its own off. */
export function useAutoContinue(): {
  modes: Record<string, AutoContinueMode>;
  setMode: (chatId: string, mode: AutoContinueMode | null) => Promise<void>;
} {
  const [modes, setModes] = useState<Record<string, AutoContinueMode>>({});
  const load = useCallback(async () => {
    setModes(await window.popbot.chats.getAutoContinue());
  }, []);
  useEffect(() => {
    void load();
    return subscribeAgentEvents((event) => {
      if (event.type === 'chats-changed' && event.reason === 'auto-continue') void load();
    });
  }, [load]);
  const setMode = useCallback(async (chatId: string, mode: AutoContinueMode | null) => {
    setModes((prev) => {
      const next = { ...prev };
      if (mode) next[chatId] = mode;
      else delete next[chatId];
      return next;
    });
    await window.popbot.chats.setAutoContinue(chatId, mode);
  }, []);
  return { modes, setMode };
}

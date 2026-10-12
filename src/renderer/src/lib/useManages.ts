import { useCallback, useEffect, useState } from 'react';
import { subscribeAgentEvents } from './agentEventBus';

/** Who manages whom (each manager's chat id → the chats it manages), kept
 *  current as it changes anywhere. */
export function useManages(): {
  manages: Record<string, string[]>;
  setManages: (chatId: string, workers: string[]) => Promise<void>;
} {
  const [manages, setState] = useState<Record<string, string[]>>({});
  const load = useCallback(async () => {
    setState(await window.popbot.chats.getManages());
  }, []);
  useEffect(() => {
    void load();
    return subscribeAgentEvents((event) => {
      if (event.type === 'chats-changed' && event.reason === 'relations') void load();
    });
  }, [load]);
  const setManages = useCallback(async (chatId: string, workers: string[]) => {
    // Shown at once; main confirms with a relations change.
    setState((prev) => ({ ...prev, [chatId]: workers }));
    await window.popbot.chats.setManages(chatId, workers);
  }, []);
  return { manages, setManages };
}

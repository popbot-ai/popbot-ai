/**
 * Single shared subscription to `pb:agent:event` for the whole app.
 *
 * Each `useChats` / `useMessages` instance used to call
 * `window.popbot.agent.onEvent(handler)` directly, registering its
 * own `ipcRenderer.on(...)`. With more than ~10 active subscribers
 * Node emitted `MaxListenersExceededWarning` and every event was
 * fanning out through 10+ JS callbacks regardless of relevance.
 *
 * This module installs exactly ONE IPC listener and dispatches to
 * registered handlers in JS. Same external shape (`subscribe(fn)
 * → unsubscribe`) so callers don't change.
 */
import type { AgentEvent } from '@shared/agent';

type Handler = (event: AgentEvent) => void;

const handlers = new Set<Handler>();
let installed = false;
let unbindIpc: (() => void) | null = null;

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  unbindIpc = window.popbot.agent.onEvent((event) => {
    // Snapshot to avoid mutation-during-iteration if a handler
    // unsubscribes itself.
    for (const h of [...handlers]) {
      try {
        h(event);
      } catch (err) {
        // Don't let a single misbehaving handler break the rest.
        // eslint-disable-next-line no-console
        console.error('agent-event handler threw', err);
      }
    }
  });
}

export function subscribeAgentEvents(handler: Handler): () => void {
  ensureInstalled();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0 && unbindIpc) {
      unbindIpc();
      unbindIpc = null;
      installed = false;
    }
  };
}

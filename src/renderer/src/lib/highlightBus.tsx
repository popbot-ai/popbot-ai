/**
 * Tiny app-level pubsub for "jump to + pulse" actions triggered by
 * notifications. Anything in the renderer can:
 *
 *   - Register a handler for a `targetKind` ("review", "linear-issue",
 *     etc.) that knows how to navigate (switch tab, scroll, mark a
 *     row to pulse).
 *
 *   - Subscribe to the latest `currentTarget` so a rendered row can
 *     compare its own data-pulse-id and toggle a class for the pulse
 *     animation.
 *
 * Notifications with `goto.type === 'internal'` flow through here.
 * Notifications with `goto.type === 'external'` bypass and call
 * `window.open(url)` directly.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface HighlightTarget {
  kind: string;
  id: string;
  /** Nonce so consumers can re-trigger on repeat clicks of the same
   *  notification. Without this the second click would set the same
   *  target object and observers wouldn't see a change. */
  nonce: number;
}

type HighlightHandler = (id: string) => void;

interface HighlightContextValue {
  /** Most-recent active target. Consumers compare and pulse when their
   *  data-pulse-id matches. Auto-cleared after `ttlMs`. */
  current: HighlightTarget | null;
  /** Register a per-kind handler that knows how to navigate. Returns
   *  an unsubscribe. Newest registration wins (last mount under a tab
   *  takes precedence over earlier mounts). */
  registerHandler(kind: string, fn: HighlightHandler): () => void;
  /** Fire a highlight from outside the notification flow. */
  highlight(kind: string, id: string): void;
}

const HighlightContext = createContext<HighlightContextValue | null>(null);

const TTL_MS = 1800;

export function HighlightProvider({ children }: { children: ReactNode }): JSX.Element {
  const [current, setCurrent] = useState<HighlightTarget | null>(null);
  const handlers = useRef<Map<string, HighlightHandler>>(new Map());
  const nonceRef = useRef(0);
  const ttlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const registerHandler = useCallback((kind: string, fn: HighlightHandler) => {
    handlers.current.set(kind, fn);
    return () => {
      // Only clear if the entry is still ours — guards against unmount
      // races when a newer registration has already replaced it.
      if (handlers.current.get(kind) === fn) handlers.current.delete(kind);
    };
  }, []);

  const highlight = useCallback((kind: string, id: string) => {
    nonceRef.current += 1;
    const handler = handlers.current.get(kind);
    if (handler) handler(id);
    setCurrent({ kind, id, nonce: nonceRef.current });
    if (ttlTimer.current) clearTimeout(ttlTimer.current);
    ttlTimer.current = setTimeout(() => setCurrent(null), TTL_MS);
  }, []);

  useEffect(() => () => {
    if (ttlTimer.current) clearTimeout(ttlTimer.current);
  }, []);

  const value = useMemo<HighlightContextValue>(() => ({
    current,
    registerHandler,
    highlight,
  }), [current, registerHandler, highlight]);

  return <HighlightContext.Provider value={value}>{children}</HighlightContext.Provider>;
}

export function useHighlight(): HighlightContextValue {
  const ctx = useContext(HighlightContext);
  if (!ctx) throw new Error('useHighlight: HighlightProvider missing');
  return ctx;
}

/** Hook for individual rows: returns true when the active target
 *  matches `kind:id` so the row should render its pulse animation.
 *  Re-fires for repeat clicks because of the nonce in the target. */
export function usePulseActive(kind: string, id: string | number | null | undefined): boolean {
  const { current } = useHighlight();
  if (!current || id == null) return false;
  return current.kind === kind && current.id === String(id);
}

/** Hook for individual rows that ALSO want to scroll into view when
 *  they're the active target. Returns a ref to attach to the row's
 *  outermost element. */
export function usePulseScrollIntoView(
  kind: string,
  id: string | number | null | undefined,
): React.MutableRefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null);
  const { current } = useHighlight();
  useEffect(() => {
    if (!current || id == null) return;
    if (current.kind !== kind || current.id !== String(id)) return;
    const el = ref.current;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [current, kind, id]);
  return ref;
}

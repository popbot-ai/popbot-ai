import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListReviewsResult, ReviewItem } from '@shared/reviews';

export type ReviewsStatus =
  | { kind: 'loading' }
  | { kind: 'gh-not-found' }
  | { kind: 'gh-not-authed' }
  | { kind: 'no-repo' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; reviews: ReviewItem[]; refreshing: boolean };

interface Options {
  /** How often to silently re-fetch. Defaults to 60s. */
  intervalMs?: number;
  /** Fired with newly-added PR numbers each tick (i.e. PRs not seen on
   *  the previous successful fetch). Used by the toast/beep. */
  onNew?: (newReviews: ReviewItem[]) => void;
}

/**
 * Polls the Reviews IPC, surfaces fresh PRs to a callback, and
 * exposes a manual refresh hook for the panel's button.
 */
export function useReviews({ intervalMs = 60_000, onNew }: Options = {}): {
  status: ReviewsStatus;
  refresh: () => void;
} {
  const [status, setStatus] = useState<ReviewsStatus>({ kind: 'loading' });
  const knownNumbersRef = useRef<Set<number> | null>(null);
  // Hold the latest callback in a ref so we don't have to re-arm the
  // poll interval whenever the parent re-renders with a new closure.
  const onNewRef = useRef<typeof onNew>(onNew);
  onNewRef.current = onNew;

  const tick = useCallback(async (manual: boolean): Promise<void> => {
    if (manual) {
      setStatus((prev) =>
        prev.kind === 'ok' ? { ...prev, refreshing: true } : prev,
      );
    }
    let res: ListReviewsResult;
    try {
      res = await window.popbot.reviews.list();
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
      return;
    }
    if (!res.ok) {
      switch (res.reason) {
        case 'gh-not-found': setStatus({ kind: 'gh-not-found' }); break;
        case 'gh-not-authed': setStatus({ kind: 'gh-not-authed' }); break;
        case 'no-repo': setStatus({ kind: 'no-repo' }); break;
        default: setStatus({ kind: 'error', message: res.error ?? 'unknown' }); break;
      }
      return;
    }
    // Detect new entries (only after we have a baseline — first fetch
    // doesn't fire alerts for pre-existing PRs).
    const known = knownNumbersRef.current;
    const fresh: ReviewItem[] = [];
    if (known) {
      for (const r of res.reviews) {
        if (!known.has(r.number)) fresh.push(r);
      }
    }
    knownNumbersRef.current = new Set(res.reviews.map((r) => r.number));
    setStatus({ kind: 'ok', reviews: res.reviews, refreshing: false });
    if (fresh.length > 0) onNewRef.current?.(fresh);
  }, []);

  // Initial fetch.
  useEffect(() => {
    void tick(false);
  }, [tick]);

  // Background polling.
  useEffect(() => {
    const id = setInterval(() => void tick(false), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, tick]);

  const refresh = useCallback(() => void tick(true), [tick]);
  return { status, refresh };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListReviewsResult, ReviewItem, ReviewProviderInfo } from '@shared/reviews';

export type ReviewsStatus =
  | { kind: 'loading' }
  | { kind: 'gh-not-found' }
  | { kind: 'gh-not-authed' }
  | { kind: 'no-repo' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; reviews: ReviewItem[]; refreshing: boolean };

type ReviewsError =
  | { kind: 'gh-not-found' }
  | { kind: 'gh-not-authed' }
  | { kind: 'error'; message: string };

interface Options {
  /** Fired with newly-added reviews each tick (items not seen on the previous
   *  successful fetch of the SAME provider). Used by the toast/beep. */
  onNew?: (newReviews: ReviewItem[]) => void;
}

/** Stable identity for a review across systems (numbers can collide between
 *  GitHub PRs and Swarm reviews, so namespace by system). */
const keyOf = (r: ReviewItem): string => `${r.scm}:${r.number}`;

/**
 * Polls each review-capable provider on its OWN interval and merges the
 * results into one list. GitHub and Swarm are independent: each provider
 * reports its own `pollIntervalMs` (Swarm deliberately slower to protect a
 * shared p4d), so a slow Perforce cadence never drags GitHub's, and vice
 * versa. Per-provider jitter de-syncs many clients off the same tick.
 *
 * The public shape ({ status, refresh }) is unchanged, so the Reviews panel
 * consumes it exactly as before.
 */
export function useReviews({ onNew }: Options = {}): {
  status: ReviewsStatus;
  refresh: () => void;
} {
  const [status, setStatus] = useState<ReviewsStatus>({ kind: 'loading' });
  const onNewRef = useRef<typeof onNew>(onNew);
  onNewRef.current = onNew;

  // Per-provider state (refs so the poll timers don't re-arm on every render).
  const providersRef = useRef<ReviewProviderInfo[]>([]);
  const slicesRef = useRef<Map<string, ReviewItem[]>>(new Map()); // provider id → last OK reviews
  const errorsRef = useRef<Map<string, ReviewsError>>(new Map()); // provider id → last hard error
  const seenRef = useRef<Map<string, Set<string>>>(new Map()); // provider id → known review keys
  const timersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const refreshingRef = useRef(false);

  /** Merge the per-provider slices into the single displayed status. */
  const recompute = useCallback((): void => {
    const providers = providersRef.current;
    if (providers.length === 0) {
      setStatus({ kind: 'no-repo' });
      return;
    }
    const merged: ReviewItem[] = [];
    let anyData = false;
    for (const p of providers) {
      const slice = slicesRef.current.get(p.id);
      if (slice) {
        merged.push(...slice);
        anyData = true;
      }
    }
    if (!anyData) {
      // Nothing succeeded yet — surface an error only if one occurred (prefer
      // the GitHub auth prompt so its "log in" affordance still shows).
      const errs = [...errorsRef.current.values()];
      const authed = errs.find((e) => e.kind === 'gh-not-authed');
      if (authed) return setStatus({ kind: 'gh-not-authed' });
      const notFound = errs.find((e) => e.kind === 'gh-not-found');
      if (notFound) return setStatus({ kind: 'gh-not-found' });
      if (errs[0]) return setStatus(errs[0]);
      return setStatus({ kind: 'loading' });
    }
    merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    setStatus({ kind: 'ok', reviews: merged, refreshing: refreshingRef.current });
  }, []);

  /** Poll ONE provider and fold its result into the per-provider state. */
  const pollProvider = useCallback(
    async (p: ReviewProviderInfo): Promise<void> => {
      let res: ListReviewsResult;
      try {
        res = await window.popbot.reviews.listFor(p.id);
      } catch (err) {
        errorsRef.current.set(p.id, { kind: 'error', message: (err as Error).message });
        slicesRef.current.delete(p.id);
        recompute();
        return;
      }
      if (res.ok) {
        errorsRef.current.delete(p.id);
        // Fresh detection is per-provider: seed silently on the first successful
        // fetch, then alert on genuinely-new items after.
        const prev = seenRef.current.get(p.id);
        if (prev) {
          const fresh = res.reviews.filter((r) => !prev.has(keyOf(r)));
          if (fresh.length) onNewRef.current?.(fresh);
        }
        seenRef.current.set(p.id, new Set(res.reviews.map(keyOf)));
        slicesRef.current.set(p.id, res.reviews);
      } else if (res.reason === 'no-repo') {
        // Configured but nothing to show (e.g. Swarm not wired / not logged in)
        // — an empty slice, NOT an error, so it can't blank out the other
        // provider's reviews. Deliberately DON'T reset the seen baseline: a
        // transient config/login gap shouldn't make the next successful poll
        // re-alert every existing review as fresh.
        errorsRef.current.delete(p.id);
        slicesRef.current.set(p.id, []);
      } else {
        errorsRef.current.set(
          p.id,
          res.reason === 'gh-not-authed'
            ? { kind: 'gh-not-authed' }
            : res.reason === 'gh-not-found'
              ? { kind: 'gh-not-found' }
              : { kind: 'error', message: res.error ?? 'unknown' },
        );
        slicesRef.current.delete(p.id);
      }
      recompute();
    },
    [recompute],
  );

  /** Arm one interval per provider at its own (jittered) cadence. */
  const armTimers = useCallback(
    (providers: ReviewProviderInfo[]): void => {
      for (const t of timersRef.current.values()) clearInterval(t);
      timersRef.current.clear();
      for (const p of providers) {
        // ±15% jitter so a fleet of clients doesn't all hit the server on the
        // same tick (matters most for a shared p4d behind Swarm).
        const jitter = 0.85 + Math.random() * 0.3;
        const ms = Math.max(1000, Math.round(p.pollIntervalMs * jitter));
        timersRef.current.set(
          p.id,
          setInterval(() => void pollProvider(p), ms),
        );
      }
    },
    [pollProvider],
  );

  /** (Re)load the provider list, arm timers, and poll all once. */
  const load = useCallback(
    async (manual: boolean): Promise<void> => {
      if (manual) {
        refreshingRef.current = true;
        recompute();
      }
      let providers: ReviewProviderInfo[] = [];
      try {
        providers = await window.popbot.reviews.providers();
      } catch {
        providers = [];
      }
      // Drop stale per-provider state for providers that went away.
      const live = new Set<string>(providers.map((p) => p.id));
      for (const id of [...slicesRef.current.keys()]) if (!live.has(id)) slicesRef.current.delete(id);
      for (const id of [...errorsRef.current.keys()]) if (!live.has(id)) errorsRef.current.delete(id);
      providersRef.current = providers;
      armTimers(providers);
      await Promise.all(providers.map((p) => pollProvider(p)));
      if (manual) refreshingRef.current = false;
      recompute();
    },
    [armTimers, pollProvider, recompute],
  );

  useEffect(() => {
    void load(false);
    return () => {
      for (const t of timersRef.current.values()) clearInterval(t);
      timersRef.current.clear();
    };
  }, [load]);

  const refresh = useCallback(() => void load(true), [load]);
  return { status, refresh };
}

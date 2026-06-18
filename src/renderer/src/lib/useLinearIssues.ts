import { useCallback, useEffect, useRef, useState } from 'react';
import type { LinearIssueDto } from '@shared/linear';

export type LinearStatus =
  | { kind: 'loading' }
  | { kind: 'not-configured' }
  | { kind: 'auth-failed' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; issues: LinearIssueDto[]; refreshing: boolean };

/** How often to silently re-fetch the issue list. Long enough that we
 *  don't burn Linear's rate budget, short enough that triaging in the
 *  Linear web UI is reflected in PopBot within a couple of minutes. */
const POLL_INTERVAL_MS = 90_000;

/**
 * Loads the user's active Linear issues via main. Re-fetches on demand
 * (the refresh button) and whenever `version` changes — bump that
 * externally after saving new Linear settings, so the panel reflects
 * the new key/team without a window reload. Also polls every
 * POLL_INTERVAL_MS in the background so the panel stays current.
 */
export function useLinearIssues(version = 0, opts?: {
  /** Fires once with the set of issue identifiers that weren't present
   *  on the previous poll tick. Skipped on the first load (no baseline). */
  onNew?: (fresh: LinearIssueDto[]) => void;
}) {
  const [status, setStatus] = useState<LinearStatus>({ kind: 'loading' });
  // Hold the latest status in a ref so the polling effect can decide
  // whether to skip a tick (e.g. nothing to fetch when not configured)
  // without re-arming the interval on every status change.
  const statusRef = useRef(status);
  statusRef.current = status;
  // Set of issue ids we've already surfaced. Populated on first load
  // so we don't fire onNew for everything that was already there.
  const knownIdsRef = useRef<Set<string> | null>(null);
  const onNewRef = useRef(opts?.onNew);
  onNewRef.current = opts?.onNew;

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setStatus((prev) =>
        prev.kind === 'ok' ? { ...prev, refreshing: true } : prev,
      );
    }
    const res = await window.popbot.linear.listIssues();
    if (res.notConfigured) {
      setStatus({ kind: 'not-configured' });
      return;
    }
    if (res.authFailed) {
      setStatus({ kind: 'auth-failed' });
      return;
    }
    if (res.error) {
      setStatus({ kind: 'error', message: res.error });
      return;
    }
    setStatus({ kind: 'ok', issues: res.issues, refreshing: false });
    // Diff against the previous tick's id set. First load establishes
    // the baseline silently; later loads emit anything new through
    // onNew so the notification subsystem can dispatch.
    const ids = new Set(res.issues.map((i) => i.id));
    const prev = knownIdsRef.current;
    knownIdsRef.current = ids;
    if (prev) {
      const fresh = res.issues.filter((i) => !prev.has(i.id));
      if (fresh.length > 0) onNewRef.current?.(fresh);
    }
  }, []);

  // Initial fetch + re-fetch when settings change.
  useEffect(() => {
    void load(false);
  }, [load, version]);

  // Background polling — skip ticks when there's nothing to fetch
  // (no key, or the key is bad).
  useEffect(() => {
    const id = setInterval(() => {
      const k = statusRef.current.kind;
      if (k === 'not-configured' || k === 'auth-failed' || k === 'loading') return;
      void load(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  return { status, refresh };
}

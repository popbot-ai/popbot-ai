import { useCallback, useEffect, useState } from 'react';
import type { AgentBackendsStatus } from '@shared/ipc';

/**
 * App "readiness" — what's configured and what still needs setting up
 * before the user can actually start a chat.
 *
 * Two hard prerequisites for creating a chat:
 *   1. At least one **agent backend** online (claude or codex CLI).
 *   2. At least one **repository** configured.
 *
 * The empty-chat-pane readiness panel reads this to show a checklist and
 * gate the "New chat" button until both are satisfied.
 */
export interface Readiness {
  loading: boolean;
  backends: AgentBackendsStatus | null;
  /** At least one agent CLI (claude or codex) is online. */
  hasAgent: boolean;
  /** At least one repository is configured. */
  hasRepo: boolean;
  /** Id of the first configured repo (display label), or null. */
  repoName: string | null;
  repoCount: number;
  /** True once both prerequisites are met — a chat can be created. */
  ready: boolean;
  /** Re-probe backends + repos (e.g. after the user closes Preferences). */
  refresh: () => void;
}

export function useReadiness(refreshKey = 0): Readiness {
  const [loading, setLoading] = useState(true);
  const [backends, setBackends] = useState<AgentBackendsStatus | null>(null);
  const [repoCount, setRepoCount] = useState(0);
  const [repoName, setRepoName] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      window.popbot.agent.backendsStatus().catch(() => null),
      window.popbot.repos.list().catch(() => []),
    ]).then(([b, repos]) => {
      if (cancelled) return;
      setBackends(b);
      setRepoCount(repos.length);
      setRepoName(repos[0]?.id ?? null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tick, refreshKey]);

  const hasAgent = !!(backends && (backends.claude.ok || backends.codex.ok));
  const hasRepo = repoCount > 0;
  return {
    loading,
    backends,
    hasAgent,
    hasRepo,
    repoName,
    repoCount,
    ready: hasAgent && hasRepo,
    refresh,
  };
}

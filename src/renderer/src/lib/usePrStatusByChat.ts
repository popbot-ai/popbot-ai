import { useEffect, useRef, useState } from 'react';
import type { ChatRecord } from '@shared/persistence';
import type { GitPrInfo } from '@shared/git';

/** How often to refresh the PR status of every chat with a `pr`
 *  field. Matches `useLinearIssues` cadence so PR + ticket statuses
 *  feel equally fresh in the UI. */
const POLL_INTERVAL_MS = 90_000;

/**
 * Polls `git.detectPr` for every open chat that has a PR number and
 * exposes the results as a `chatId → GitPrInfo` Map.
 *
 * Lifted out of the per-chat `ChatStatusChip` so:
 *   1. The PR status updates on the same cadence as Linear ticket
 *      status (the chip used to fetch once on mount and never again,
 *      so a PR transitioning Open → Merged in GitHub wouldn't surface
 *      until the user closed and reopened the app).
 *   2. Multiple chips for the same chat (runtime strip + GitPanel)
 *      share a single fetch instead of hammering `gh` separately.
 *
 * Re-fetches whenever the set of `(chatId, prNumber)` pairs changes
 * — e.g. a chat is closed, a chat's PR is detected for the first
 * time. Drops cached entries for chats that no longer have a PR.
 */
export function usePrStatusByChat(chats: ChatRecord[]): Map<string, GitPrInfo> {
  const [byId, setById] = useState<Map<string, GitPrInfo>>(() => new Map());

  // Poll EVERY open chat that could plausibly have a PR — anything
  // with an explicit chat.pr OR a worktreePath. The latter covers
  // tickets in Code Review / Ready to Test / Ready to Deploy states
  // where the PR exists in GitHub but chat.pr was never set: detectPr
  // looks at the current branch in the worktree, finds the PR, and
  // the chip surfaces. Chats without either drop out cleanly because
  // detectPr returns null. Cost: one `gh pr view` per chat per
  // POLL_INTERVAL_MS — a handful of calls, all cached by gh.
  const sig = chats
    .filter((c) => c.pr !== null || c.worktreePath !== null)
    .map((c) => `${c.id}:${c.pr ?? '-'}:${c.worktreePath ?? '-'}`)
    .sort()
    .join(',');

  // Hold the latest signature in a ref so the poll interval can
  // notice if the set changed between ticks without re-arming the
  // setInterval on every render.
  const sigRef = useRef(sig);
  sigRef.current = sig;
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async (): Promise<void> => {
      const targets = chatsRef.current.filter(
        (c) => c.pr !== null || c.worktreePath !== null,
      );
      const results = await Promise.all(
        targets.map(async (chat) => {
          try {
            const r = await window.popbot.git.detectPr(chat.id);
            if (r.ok && r.pr) return [chat.id, r.pr] as const;
          } catch {
            // ignore; per-chat failure shouldn't take the rest down
          }
          return null;
        }),
      );
      if (cancelled) return;
      // Replace map atomically. Any chat that failed (or that no
      // longer has a PR) drops out — UI just doesn't show the chip.
      setById(new Map(results.filter((r): r is readonly [string, GitPrInfo] => r !== null)));
    };
    void fetchAll();
    const id = setInterval(() => void fetchAll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // sig captures the set of pollable chats; re-arm only on changes there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return byId;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitStatusResultOrErr } from '@shared/git';

/**
 * Polls `pb:git:status` for the supplied chat every `intervalMs`.
 * Pass `null` to disable (e.g. when the panel is closed). Returns
 * the latest snapshot plus a manual `refresh()` to call after the
 * user commits / reverts / etc.
 */
export function useGitStatus(
  chatId: string | null,
  intervalMs = 2500,
): {
  data: GitStatusResultOrErr | null;
  loading: boolean;
  /** Re-fetch now; await it to know when the new snapshot is applied. */
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<GitStatusResultOrErr | null>(null);
  const [loading, setLoading] = useState(false);
  // Avoid races between back-to-back chat switches: only the latest
  // chatId's response gets applied to state.
  const reqIdRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    if (!chatId) return;
    const myReq = ++reqIdRef.current;
    setLoading(true);
    try {
      const res = await window.popbot.git.status(chatId);
      if (myReq === reqIdRef.current) setData(res);
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    if (!chatId) {
      setData(null);
      return;
    }
    void fetchOnce();
    const t = setInterval(() => void fetchOnce(), intervalMs);
    return () => clearInterval(t);
  }, [chatId, intervalMs, fetchOnce]);

  return { data, loading, refresh: fetchOnce };
}

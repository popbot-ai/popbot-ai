import { useCallback, useEffect, useState } from 'react';
import type { NotificationRecord } from '@shared/notifications';

/**
 * Live notification list + unread count, sourced from the main-process
 * notifications table. Patches in `notification-added` pushes so the
 * bell badge updates without a refetch.
 */
export function useNotifications(limit = 50): {
  items: NotificationRecord[];
  unread: number;
  markAllRead: () => Promise<void>;
  /** Hard-delete every notification — backs the bell's "Clear all". */
  clearAll: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  /** Most-recent first; bounded by `limit`. Re-render-stable. */
} {
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [unread, setUnread] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.popbot.notifications.list(limit),
      window.popbot.notifications.unreadCount(),
    ]).then(([list, count]) => {
      if (cancelled) return;
      setItems(list);
      setUnread(count);
    });
    const off = window.popbot.notifications.onAdded((rec) => {
      setItems((prev) => [rec, ...prev].slice(0, limit));
      if (rec.readAt == null) setUnread((n) => n + 1);
    });
    return () => { cancelled = true; off(); };
  }, [limit]);

  const markAllRead = useCallback(async () => {
    await window.popbot.notifications.markAllRead();
    setItems((prev) => prev.map((n) => (n.readAt == null ? { ...n, readAt: Date.now() } : n)));
    setUnread(0);
  }, []);

  const clearAll = useCallback(async () => {
    await window.popbot.notifications.clearAll();
    setItems([]);
    setUnread(0);
  }, []);

  const markRead = useCallback(async (id: string) => {
    await window.popbot.notifications.markRead(id);
    setItems((prev) => prev.map((n) => (n.id === id && n.readAt == null ? { ...n, readAt: Date.now() } : n)));
    setUnread((n) => Math.max(0, n - 1));
  }, []);

  return { items, unread, markAllRead, clearAll, markRead };
}

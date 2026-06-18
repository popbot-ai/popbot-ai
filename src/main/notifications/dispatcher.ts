/**
 * Singleton dispatcher for the notification system.
 */
import { BrowserWindow } from 'electron';
import { IpcChannel } from '@shared/ipc';
import {
  defaultDedupKey,
  type NotificationRecord,
  type NotifyInput,
} from '@shared/notifications';
import { hasRecentDedup, insertNotification } from '../persistence/notifications';
import { isDbOpen } from '../persistence/db';

const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

export function notify(input: NotifyInput): NotificationRecord | null {
  if (!isDbOpen()) return null;
  const dedupKey = defaultDedupKey(input);
  const window = input.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  if (hasRecentDedup(dedupKey, window)) return null;

  const rec = insertNotification({
    kind: input.kind,
    urgency: input.urgency ?? 'med',
    source: input.source ?? '',
    title: input.title,
    subtitle: input.subtitle ?? '',
    summary: input.summary ?? '',
    actor: input.actor ?? null,
    actions: input.actions ?? [],
    dedupKey,
  });

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.NotificationAdded, rec);
  }
  return rec;
}

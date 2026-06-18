import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { NotifyInput } from '@shared/notifications';
import {
  deleteAllNotifications,
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from '../persistence/notifications';
import { notify } from '../notifications/dispatcher';

export function registerNotificationsHandlers(): void {
  ipcMain.handle(IpcChannel.NotificationsList, (_e, limit?: number) => listNotifications(limit));
  ipcMain.handle(IpcChannel.NotificationsUnreadCount, () => unreadCount());
  ipcMain.handle(IpcChannel.NotificationsMarkAllRead, () => markAllRead());
  ipcMain.handle(IpcChannel.NotificationsClearAll, () => deleteAllNotifications());
  ipcMain.handle(IpcChannel.NotificationsMarkRead, (_e, id: string) => markRead(id));
  ipcMain.handle(IpcChannel.NotificationsDispatch, (_e, input: NotifyInput) => notify(input));
}

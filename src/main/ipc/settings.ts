import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import { dlog } from '../diagLog';
import { deleteSetting, getAllSettings, getSetting, setSetting } from '../persistence/settings';

export function registerSettingsHandlers(): void {
  // Renderer diagnostics land in the same log as main's, so a UI
  // problem can be traced alongside what main saw of it.
  ipcMain.on(IpcChannel.DiagLog, (_e, tag: unknown, data: unknown) => {
    if (typeof tag !== 'string') return;
    dlog(`renderer.${tag.slice(0, 60)}`, (data && typeof data === 'object' ? data : {}) as Record<string, unknown>);
  });
  ipcMain.handle(IpcChannel.SettingsGet, (_e, key: string) => getSetting(key));
  ipcMain.handle(IpcChannel.SettingsSet, (_e, key: string, value: unknown) => setSetting(key, value));
  ipcMain.handle(IpcChannel.SettingsGetAll, () => getAllSettings());
  ipcMain.handle(IpcChannel.SettingsDelete, (_e, key: string) => deleteSetting(key));
}

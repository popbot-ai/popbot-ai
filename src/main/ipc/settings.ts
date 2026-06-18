import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import { deleteSetting, getAllSettings, getSetting, setSetting } from '../persistence/settings';

export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannel.SettingsGet, (_e, key: string) => getSetting(key));
  ipcMain.handle(IpcChannel.SettingsSet, (_e, key: string, value: unknown) => setSetting(key, value));
  ipcMain.handle(IpcChannel.SettingsGetAll, () => getAllSettings());
  ipcMain.handle(IpcChannel.SettingsDelete, (_e, key: string) => deleteSetting(key));
}

/**
 * Minimal Electron stub for unit tests. Main-process modules import
 * `electron` at module load even when the function under test doesn't
 * touch it (e.g. `check.ts` imports `app` but `isNewer` never calls it).
 * Vitest aliases `electron` to this file so those modules import cleanly
 * without a running Electron runtime. Extend as tests need more surface.
 */
export const app = {
  getVersion: () => '0.0.0',
  getName: () => 'PopBot',
  setName: () => undefined,
  getPath: () => '/tmp',
  isPackaged: false,
  on: () => undefined,
  whenReady: () => Promise.resolve(),
  commandLine: { appendSwitch: () => undefined },
  disableHardwareAcceleration: () => undefined,
};

export class BrowserWindow {
  static getAllWindows(): unknown[] { return []; }
}

export const ipcMain = {
  handle: () => undefined,
  on: () => undefined,
};

export const shell = { openExternal: () => Promise.resolve() };

export default { app, BrowserWindow, ipcMain, shell };

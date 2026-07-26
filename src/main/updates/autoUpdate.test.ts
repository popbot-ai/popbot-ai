import { describe, it, expect, beforeEach, vi } from 'vitest';

// The staged-update record is the fix for a real miss: `UpdateDownloaded` is
// a fire-and-forget broadcast, so an update staged while no renderer was
// listening left an installer on disk with nothing in the UI pointing at it.
// These tests pin the persisted-state behavior that replaces the old
// per-run in-memory flag.

let appVersion = '0.1.1';
const store = new Map<string, unknown>();

vi.mock('electron', () => ({
  app: { getVersion: () => appVersion, isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('electron-updater', () => ({
  default: { autoUpdater: { on: vi.fn(), quitAndInstall: vi.fn() } },
}));

vi.mock('../diagLog', () => ({ dlog: vi.fn() }));

vi.mock('../persistence/settings', () => ({
  getSetting: (k: string) => (store.has(k) ? store.get(k) : null),
  setSetting: (k: string, v: unknown) => void store.set(k, v),
  deleteSetting: (k: string) => void store.delete(k),
}));

const STAGED_KEY = 'updates.stagedVersion';

const { getStagedUpdate, quitAndInstallUpdate } = await import('./autoUpdate');
const { autoUpdater } = (await import('electron-updater')).default;

beforeEach(() => {
  store.clear();
  appVersion = '0.1.1';
  vi.mocked(autoUpdater.quitAndInstall).mockClear();
});

describe('getStagedUpdate', () => {
  it('returns null when nothing is staged', () => {
    expect(getStagedUpdate()).toBeNull();
  });

  it('surfaces a staged update newer than the running version', () => {
    store.set(STAGED_KEY, '0.1.2');
    expect(getStagedUpdate()).toEqual({ version: '0.1.2', name: 'PopBot v0.1.2' });
  });

  it('survives a restart — the record is what the next launch reads', () => {
    // Simulates the reported bug: 0.1.2 downloaded while no window listened,
    // app restarted. The in-memory flag is gone; the record is not.
    store.set(STAGED_KEY, '0.1.2');
    expect(getStagedUpdate()?.version).toBe('0.1.2');
  });

  it('clears a record the running version already caught up to', () => {
    // The update applied — offering "restart to install" forever would be a
    // dead end, so the stale record is dropped on read.
    store.set(STAGED_KEY, '0.1.2');
    appVersion = '0.1.2';
    expect(getStagedUpdate()).toBeNull();
    expect(store.has(STAGED_KEY)).toBe(false);
  });

  it('clears a record older than the running version', () => {
    // e.g. the user installed a newer build by hand over the staged one.
    store.set(STAGED_KEY, '0.1.2');
    appVersion = '0.2.0';
    expect(getStagedUpdate()).toBeNull();
    expect(store.has(STAGED_KEY)).toBe(false);
  });

  it('ignores a malformed record rather than throwing', () => {
    store.set(STAGED_KEY, 42);
    expect(getStagedUpdate()).toBeNull();
    store.set(STAGED_KEY, '');
    expect(getStagedUpdate()).toBeNull();
  });
});

describe('quitAndInstallUpdate', () => {
  it('installs from the persisted record, not a per-run flag', () => {
    // The session that clicks "Restart and install" is often not the one
    // that downloaded — this is the case the old flag got wrong.
    store.set(STAGED_KEY, '0.1.2');
    quitAndInstallUpdate();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('is a no-op when nothing is staged', () => {
    quitAndInstallUpdate();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('is a no-op when the staged record is stale', () => {
    store.set(STAGED_KEY, '0.1.2');
    appVersion = '0.1.2';
    quitAndInstallUpdate();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});

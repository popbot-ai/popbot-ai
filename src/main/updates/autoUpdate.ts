/**
 * In-app auto-update engine (electron-updater).
 *
 * In packaged builds, polls GitHub releases via electron-updater, silently
 * downloads a newer version in the background, and — once staged — pushes
 * `UpdateDownloaded` so the renderer can offer "Restart to install"
 * (quitAndInstall via the `UpdatesInstall` IPC).
 *
 * Auto-install requires the build to be signed + notarized — macOS rejects
 * unsigned updates. When electron-updater can't proceed (no app-update.yml,
 * network error, etc.) we fall back to the lightweight GitHub notifier
 * (check.ts) and push `UpdateAvailable` with the release-page URL so the
 * user can download the new build manually.
 *
 * Disabled in dev (no app-update.yml; local builds report 0.0.0).
 */
import { app, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { IpcChannel } from '@shared/ipc';
import type { UpdateInfo, UpdateProgress, UpdateReady } from '@shared/updates';
import { dlog } from '../diagLog';
import { fetchLatest, isNewer } from './check';

// electron-updater is CommonJS — default-import then destructure.
const { autoUpdater } = electronUpdater;

const STARTUP_DELAY_MS = 30 * 1000;
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

let startupTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let downloaded = false;
let firedManualFallback = false;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * Surface the latest release as a manual download. Used when the in-app
 * updater can't apply the update itself (no metadata, network error, etc.).
 * Fires at most once per run, and never after a successful download.
 */
async function manualFallback(): Promise<void> {
  if (firedManualFallback || downloaded) return;
  const latest = await fetchLatest();
  if (!latest) return;
  const current = app.getVersion();
  const latestVer = latest.tag.replace(/^v/, '');
  if (!isNewer(latestVer, current)) return;
  firedManualFallback = true;
  const info: UpdateInfo = {
    current,
    latest: latestVer,
    htmlUrl: latest.htmlUrl,
    name: latest.name,
  };
  broadcast(IpcChannel.UpdateAvailable, info);
}

export function startAutoUpdater(): void {
  // No app-update.yml in dev, and local builds report 0.0.0 — bail.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err: Error) => {
    dlog('update.error', { error: err.message });
    void manualFallback();
  });
  autoUpdater.on('download-progress', (p: { percent: number }) => {
    const progress: UpdateProgress = { percent: Math.round(p.percent) };
    broadcast(IpcChannel.UpdateProgress, progress);
  });
  autoUpdater.on('update-downloaded', (info: { version: string; releaseName?: string | null }) => {
    downloaded = true;
    dlog('update.downloaded', { version: info.version });
    const ready: UpdateReady = {
      version: info.version,
      name: info.releaseName ?? `PopBot v${info.version}`,
    };
    broadcast(IpcChannel.UpdateDownloaded, ready);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      dlog('update.check.failed', { error: err instanceof Error ? err.message : String(err) });
      void manualFallback();
    });
  };

  startupTimer = setTimeout(check, STARTUP_DELAY_MS);
  pollTimer = setInterval(check, POLL_INTERVAL_MS);
}

export function stopAutoUpdater(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** Quit and install the staged update. No-op if nothing's downloaded. */
export function quitAndInstallUpdate(): void {
  if (!downloaded) return;
  // isSilent=false (show the Windows installer UI), isForceRunAfter=true
  // (relaunch the app once the update is applied).
  autoUpdater.quitAndInstall(false, true);
}

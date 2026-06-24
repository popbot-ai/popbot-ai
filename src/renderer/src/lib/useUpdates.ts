import { useCallback, useEffect, useState } from 'react';
import type { UpdateInfo, UpdateReady } from '@shared/updates';

/**
 * Subscribe to the main-process auto-updater.
 *
 * - `available`: a newer release exists but can't be installed in-app
 *   (unsigned build / updater error) — show a manual "Download" link.
 * - `progress`: percent downloaded while electron-updater pulls the update
 *   in the background (null when not downloading).
 * - `downloaded`: an update has been staged — show "Restart to install",
 *   which calls `install()` (quit + relaunch into the new version).
 */
export function useUpdates(): {
  available: UpdateInfo | null;
  progress: number | null;
  downloaded: UpdateReady | null;
  dismiss(): void;
  install(): void;
} {
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState<UpdateReady | null>(null);

  useEffect(() => {
    const offAvailable = window.popbot.updates.onAvailable(setAvailable);
    const offProgress = window.popbot.updates.onProgress((p) => setProgress(p.percent));
    const offDownloaded = window.popbot.updates.onDownloaded((info) => {
      setProgress(null);
      setDownloaded(info);
    });
    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
    };
  }, []);

  // Stable identities: App.tsx uses these in useEffect deps, and a fresh
  // function each render would re-fire the toast effect on every commit
  // (a self-sustaining render loop while an update is pending).
  const dismiss = useCallback(() => setAvailable(null), []);
  const install = useCallback(() => window.popbot.updates.install(), []);

  return { available, progress, downloaded, dismiss, install };
}

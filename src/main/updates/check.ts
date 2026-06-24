/**
 * Lightweight update-check ping.
 *
 * Hits the public GitHub releases API for `popbot-ai/popbot-ai` once on
 * startup (after a small delay) and then every few hours. If the tag is
 * newer than the running app's version, push an `UpdateAvailable` event
 * to every renderer so they can show a toast with a "Download" link.
 *
 * The repo is public, so we use the raw HTTPS releases API (no `gh`, no
 * auth token) — works for every user out of the box. If the request
 * fails (offline, rate-limited, no releases yet) the check silently
 * no-ops; the app still runs fine.
 *
 * No download / install logic — that path needs code signing +
 * notarization (electron-updater) which we don't yet have. This
 * surfaces the release page so the user can grab the new build
 * themselves.
 */
import { app, BrowserWindow } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { UpdateInfo, UpdateCheckResult } from '@shared/updates';

const REPO = 'popbot-ai/popbot-ai';
const STARTUP_DELAY_MS = 30 * 1000;
const POLL_INTERVAL_MS = 10 * 60 * 1000;
/** Once we've shown a toast for a given version, don't re-fire for the
 *  same version until this much time has passed. A newer version
 *  bypasses the cooldown — see checkOnce(). */
const QUIET_MS = 3 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let lastNotifiedVersion: string | null = null;
let lastNotifiedAt = 0;

function parseSemver(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(candidate: string, baseline: string): boolean {
  const c = parseSemver(candidate);
  const b = parseSemver(baseline);
  if (!c || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (c[i] > b[i]) return true;
    if (c[i] < b[i]) return false;
  }
  return false;
}

interface LatestRelease { tag: string; name: string; htmlUrl: string }

async function fetchLatest(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub rejects API requests without a User-Agent.
        'User-Agent': 'PopBot',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const obj = (await res.json()) as { tag_name?: string; name?: string; html_url?: string };
    if (typeof obj.tag_name !== 'string' || typeof obj.html_url !== 'string') return null;
    return { tag: obj.tag_name, name: obj.name ?? obj.tag_name, htmlUrl: obj.html_url };
  } catch {
    return null;
  }
}

/**
 * On-demand check used by the About dialog. Unlike the background poller
 * this runs in dev too and always returns a result (with `error` set when
 * the network call couldn't complete) so the UI can show a clear status.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion();
  const latest = await fetchLatest();
  if (!latest) {
    return {
      current,
      latest: null,
      updateAvailable: false,
      htmlUrl: null,
      name: null,
      error: "Couldn't reach GitHub to check for updates.",
    };
  }
  const latestVer = latest.tag.replace(/^v/, '');
  return {
    current,
    latest: latestVer,
    updateAvailable: isNewer(latestVer, current),
    htmlUrl: latest.htmlUrl,
    name: latest.name,
  };
}

async function checkOnce(): Promise<void> {
  const latest = await fetchLatest();
  if (!latest) return;
  const latestVer = latest.tag.replace(/^v/, '');
  const current = app.getVersion();
  if (!isNewer(latestVer, current)) return;
  // A new version since we last notified always fires immediately.
  // Same version we've already surfaced waits out the cooldown so we
  // don't nag every 10 minutes.
  const newVersion = latestVer !== lastNotifiedVersion;
  const cooldownExpired = Date.now() - lastNotifiedAt > QUIET_MS;
  if (!newVersion && !cooldownExpired) return;
  lastNotifiedVersion = latestVer;
  lastNotifiedAt = Date.now();
  const info: UpdateInfo = {
    current,
    latest: latestVer,
    htmlUrl: latest.htmlUrl,
    name: latest.name,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.UpdateAvailable, info);
  }
}

export function startUpdateChecker(): void {
  // No point in dev — local builds report 0.0.0 and would always trigger.
  if (!app.isPackaged) return;
  startupTimer = setTimeout(() => { void checkOnce(); }, STARTUP_DELAY_MS);
  timer = setInterval(() => { void checkOnce(); }, POLL_INTERVAL_MS);
}

export function stopUpdateChecker(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

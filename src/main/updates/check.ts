/**
 * Lightweight update-check ping.
 *
 * Hits `gh api repos/proofofplay/popbot-tool/releases/latest` once on startup
 * (after a small delay) and then every few hours. If the tag is newer
 * than the running app's version, push an `UpdateAvailable` event to
 * every renderer so they can show a toast with a "Download" link.
 *
 * Why `gh` and not raw https? It piggybacks on the gh CLI auth the
 * Reviews tab already needs — the popbot repo may be private and the
 * raw releases API would 404 without a token. If `gh` is missing or
 * unauthed, the check silently no-ops; the app still runs fine.
 *
 * No download / install logic — that path needs code signing +
 * notarization (electron-updater) which we don't yet have. This
 * surfaces the release page so the user can grab the new .dmg
 * themselves.
 */
import { app, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IpcChannel } from '@shared/ipc';
import type { UpdateInfo } from '@shared/updates';

const execFileP = promisify(execFile);

const REPO = 'proofofplay/popbot-tool';
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
    const { stdout } = await execFileP(
      'gh',
      [
        'api',
        `repos/${REPO}/releases/latest`,
        '--jq', '{tag: .tag_name, name: .name, htmlUrl: .html_url}',
      ],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    const obj = JSON.parse(stdout) as Partial<LatestRelease>;
    if (typeof obj.tag !== 'string' || typeof obj.htmlUrl !== 'string') return null;
    return { tag: obj.tag, name: obj.name ?? obj.tag, htmlUrl: obj.htmlUrl };
  } catch {
    return null;
  }
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

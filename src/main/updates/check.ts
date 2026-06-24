/**
 * Lightweight "is there a newer stable build" helper, backed by a small
 * version pointer on the R2 download host (written by the release workflow).
 *
 * Two consumers:
 *  - the About dialog's on-demand "Check for updates" (`checkForUpdates`),
 *    which works everywhere including dev and unsigned builds; and
 *  - the auto-updater's manual-download fallback (`fetchLatest`), used when
 *    electron-updater can't install in-app (see autoUpdate.ts).
 *
 * Plain public HTTPS GET (no auth); failures (offline, not published yet)
 * silently no-op. Main-process fetch, so no CORS concerns.
 */
import { app } from 'electron';
import type { UpdateCheckResult } from '@shared/updates';

/** Stable-channel version pointer, e.g. {"version":"0.0.19"}. */
const STABLE_VERSION_URL = 'https://download.popbot.app/stable/version.json';
/** Where to send users for a manual download (the marketing/download site). */
const DOWNLOAD_PAGE = 'https://popbot.app';

function parseSemver(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, baseline: string): boolean {
  const c = parseSemver(candidate);
  const b = parseSemver(baseline);
  if (!c || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (c[i] > b[i]) return true;
    if (c[i] < b[i]) return false;
  }
  return false;
}

export interface LatestRelease { tag: string; name: string; htmlUrl: string }

export async function fetchLatest(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(STABLE_VERSION_URL, {
      headers: { 'User-Agent': 'PopBot', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const obj = (await res.json()) as { version?: string };
    if (typeof obj.version !== 'string') return null;
    return { tag: `v${obj.version}`, name: `PopBot v${obj.version}`, htmlUrl: DOWNLOAD_PAGE };
  } catch {
    return null;
  }
}

/**
 * On-demand check used by the About dialog. Runs in dev too and always
 * returns a result (with `error` set when the network call couldn't
 * complete) so the UI can show a clear status.
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
      error: "Couldn't reach the update server.",
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

/**
 * Lightweight GitHub-releases helpers.
 *
 * Two consumers:
 *  - the About dialog's on-demand "Check for updates" (`checkForUpdates`),
 *    which works everywhere including dev and unsigned builds; and
 *  - the auto-updater's manual-download fallback (`fetchLatest`), used when
 *    electron-updater can't install in-app (see autoUpdate.ts).
 *
 * Uses the raw public releases API (no `gh`, no auth token) so it works for
 * every user out of the box; failures (offline, rate-limited, no releases)
 * silently no-op.
 */
import { app } from 'electron';
import type { UpdateCheckResult } from '@shared/updates';

const REPO = 'popbot-ai/popbot-ai';

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

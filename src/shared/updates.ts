/** Payload for the main → renderer "a newer release is available" push. */
export interface UpdateInfo {
  /** The version this app is running (no `v` prefix). */
  current: string;
  /** The latest release tag minus the `v` prefix. */
  latest: string;
  /** GitHub release page — opened externally when the toast is clicked. */
  htmlUrl: string;
  /** Release name as set on GitHub (e.g. "PopBot v0.0.4"). */
  name: string;
}

/** electron-updater download progress push. */
export interface UpdateProgress {
  /** Percent downloaded, 0–100. */
  percent: number;
}

/** Payload for the "update downloaded, ready to install" push. */
export interface UpdateReady {
  /** The version that was downloaded and staged (no `v` prefix). */
  version: string;
  /** Release name, if known (e.g. "PopBot v0.0.18"). */
  name: string;
}

/** Result of an on-demand update check (Help ▸ About ▸ Check for updates). */
export interface UpdateCheckResult {
  /** The version this app is running (no `v` prefix). */
  current: string;
  /** Latest release version, or null if the check couldn't complete. */
  latest: string | null;
  /** True when `latest` is strictly newer than `current`. */
  updateAvailable: boolean;
  /** GitHub release page for the latest release, if known. */
  htmlUrl: string | null;
  /** Latest release name, if known. */
  name: string | null;
  /** Present when the check failed (offline, rate-limited, no releases). */
  error?: string;
}

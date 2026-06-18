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

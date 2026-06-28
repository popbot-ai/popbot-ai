/**
 * Perforce-specific shared types surfaced to the renderer (the P4 panel).
 * The common review payload (status/diff/commit) reuses the git types in
 * `@shared/git`; this module adds only what's Perforce-shaped — the shelf.
 */

/**
 * True when a Perforce error message means "you're not authenticated" — an
 * expired/missing login ticket. The P4 panel uses this (on a failed status or
 * action) to pop the login prompt instead of just showing the raw error.
 * Shared so main (tagging) and renderer (detection) agree on the patterns.
 */
export function isP4AuthError(text: string | null | undefined): boolean {
  if (!text) return false;
  return /password \(P4PASSWD\) invalid or unset|session has expired|please login again|perforce password.*not set|invalid\/unset|not logged in/i.test(
    text,
  );
}

/** A shelved changelist — the bottom section of the P4 panel. */
export interface P4Shelf {
  /** Shelved changelist number (the "ref" for unshelve/delete). */
  change: string;
  /** First line of the shelf description. */
  description: string;
  /** Unix-ms time the change was shelved. */
  time: number;
}

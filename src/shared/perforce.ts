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

/** One shelved file (the shelf section lists files, not changelists). */
export interface P4ShelfFile {
  /** Provider path key (`depot/...`). */
  path: string;
  /** edit / add / delete, mapped to the shared status enum. */
  status: import('./git').GitFileStatus;
  /** The shelved changelist this file belongs to (the unshelve/delete ref). */
  change: string;
}

/** A unshelve/delete selection: files (`paths`, provider keys) picked from one
 *  shelved changelist (`change`). The panel groups the checked shelf files by
 *  their changelist into these items. */
export interface P4ShelfItem {
  change: string;
  paths: string[];
}

/** A shelved changelist + the files it holds — the bottom section of the P4
 *  panel renders the FILES (flattened across shelves), not the changelists. */
export interface P4Shelf {
  /** Shelved changelist number (the "ref" for unshelve/delete). */
  change: string;
  /** First line of the shelf description. */
  description: string;
  /** Unix-ms time the change was shelved. */
  time: number;
  /** The files shelved in this changelist. */
  files: P4ShelfFile[];
}

/**
 * Perforce-specific shared types surfaced to the renderer (the P4 panel).
 * The common review payload (status/diff/commit) reuses the git types in
 * `@shared/git`; this module adds only what's Perforce-shaped — the shelf.
 */

/** A shelved changelist — the bottom section of the P4 panel. */
export interface P4Shelf {
  /** Shelved changelist number (the "ref" for unshelve/delete). */
  change: string;
  /** First line of the shelf description. */
  description: string;
  /** Unix-ms time the change was shelved. */
  time: number;
}

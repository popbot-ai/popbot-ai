/**
 * Pending PRs surfaced in the Reviews tab. The main process pulls
 * these via the `gh` CLI; the renderer polls + diffs to fire alerts.
 */

/** Which review system surfaced an item — GitHub PRs vs Helix Swarm reviews.
 *  The Reviews panel renders both in one list and branches on this for the
 *  per-item action (open PR / open Swarm review, spawn review-pr / review-cl). */
export type ReviewSystem = 'github' | 'swarm';

export interface ReviewItem {
  /** Which review system this came from. */
  scm: ReviewSystem;
  /** PR number (GitHub) or review id (Swarm) within the repo/server. */
  number: number;
  title: string;
  url: string;
  /** GitHub login of the PR author. */
  author: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  /** ISO timestamps from the GitHub API. */
  createdAt: string;
  updatedAt: string;
  /** Why we surfaced this PR — a chat may match multiple rules; we
   *  union flags so the UI can badge accordingly. */
  flags: {
    /** I (the configured `gh` user) am explicitly requested as a reviewer. */
    requestedReviewer: boolean;
    /** No reviews of any kind have been left yet. */
    noReviewsYet: boolean;
    /** I've already reviewed this PR — but I'm a *current* requested
     *  reviewer again, meaning the author pushed fixes and clicked
     *  "Re-request review". Renderer surfaces a distinct RE-REVIEW
     *  chip and the badge / notification system treats this as a
     *  fresh work event so the user can't miss it. */
    reReview: boolean;
  };
}

export type ListReviewsResult =
  | { ok: true; reviews: ReviewItem[] }
  | { ok: false; reason: 'gh-not-found' | 'gh-not-authed' | 'no-repo' | 'error'; error?: string };

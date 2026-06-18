/**
 * Pending PRs surfaced in the Reviews tab. The main process pulls
 * these via the `gh` CLI; the renderer polls + diffs to fire alerts.
 */

export interface ReviewItem {
  /** PR number within the repo. */
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

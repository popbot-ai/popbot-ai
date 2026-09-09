/**
 * Pending PRs surfaced in the Reviews tab. The main process pulls
 * these via the `gh` CLI; the renderer polls + diffs to fire alerts.
 */

import type { SourceControlProviderId } from './sourceControl';

/** Which review system surfaced an item — GitHub PRs vs Helix Swarm reviews.
 *  The Reviews panel renders both in one list and branches on this for the
 *  per-item action (open PR / open Swarm review, spawn review-pr / review-cl). */
export type ReviewSystem = 'github' | 'swarm';

/** A review-capable provider the panel should poll — on its OWN cadence, so
 *  GitHub and Swarm are polled independently (Swarm slower, to protect p4d). */
export interface ReviewProviderInfo {
  /** The SourceControl provider id backing this review source. */
  id: SourceControlProviderId;
  /** Review-system tag (matches {@link ReviewItem.scm}). */
  system: ReviewSystem;
  /** This provider's poll interval in ms. */
  pollIntervalMs: number;
}

/**
 * How wide a net the Reviews panel casts.
 *   - 'requested'  — only reviews that name me as a reviewer.
 *   - 'unreviewed' — those PLUS ones nobody has reviewed yet (default).
 * Applied provider-agnostically, so it covers GitHub PRs and Swarm
 * reviews alike. Manually pinned reviews are exempt — pinning is an
 * explicit "show me this one regardless".
 */
export type ReviewScope = 'requested' | 'unreviewed';
export const DEFAULT_REVIEW_SCOPE: ReviewScope = 'unreviewed';

/**
 * Why a review is in front of you, in priority order. The distinction
 * that matters is `direct` vs `team`: GitHub's `review-requested:@me`
 * ALSO matches PRs that merely asked a team you belong to, which in a
 * repo that requests the whole frontend team on everything means ~300
 * of 500 open PRs "want you". Being personally named is the rare,
 * meaningful signal, so it gets its own tier.
 */
export type ReviewTier =
  /** You are named as a reviewer, personally. */
  | 'direct'
  /** Authored by someone on your team (Preferences ▸ Code reviews). */
  | 'team'
  /** Authored by someone inside the org — staff or contractors. Not your
   *  team, but still colleagues whose work you want to cover. */
  | 'org'
  /** Outside / open-source contributors. Worth a different default:
   *  reviewing these is optional in a way colleagues' work isn't, so
   *  they're opt-in unless the author has been vetted. */
  | 'external';

export const REVIEW_TIER_ORDER: readonly ReviewTier[] = ['direct', 'team', 'org', 'external'];

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
  /** Which bucket this belongs in — see ReviewTier. */
  tier?: ReviewTier;
  /** Reviewers named on the PR personally (not via a team). Drives the
   *  'direct' tier and the reviewer tooltip. */
  requestedLogins?: string[];
  /** GitHub's reviewDecision is APPROVED — someone has signed off, so
   *  it no longer needs a reviewer found for it. */
  approved?: boolean;
  /** A real person (not coderabbitai / a bot) has already left a review
   *  of any kind — so it's been picked up, and is no longer unreviewed
   *  work looking for an owner. */
  humanReviewed?: boolean;
  /** When you last engaged with this PR (your GitHub review, or the last
   *  time you touched its chat), as epoch ms. 0 when never. Drives
   *  re-review detection. */
  engagedAt?: number;
  /** Merged or closed. Only ever set on pinned reviews (the queue
   *  searches are `is:open`), so a pin can be retired once it lands. */
  closed?: boolean;
  /** You pinned it, or reviewed it (which pins it) — the ones you're
   *  actively on. Sorts to the top OF ITS CATEGORY rather than into a
   *  section of its own, so each category leads with its live work. */
  pinned?: boolean;
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

/** A user-pinned review, as persisted under the `panela.pinned.prs`
 *  setting. Namespaced by system so GitHub PR #27 and Swarm review #27
 *  don't collide. */
export interface PinnedReview {
  scm: ReviewSystem;
  number: number;
}

/** Map a review system to the SCM provider id the reviews IPC expects. */
export function providerIdForReviewSystem(system: ReviewSystem): SourceControlProviderId {
  return system === 'swarm' ? 'perforce' : 'git';
}

/** The user-configurable mute lists (Preferences ▸ Code reviews). */
export interface ReviewIgnoreRules {
  ignoreTitlePatterns?: string[];
  ignoreAuthors?: string[];
}

/**
 * Titles that announce the PR isn't for review. Every pattern here was
 * taken from real open PRs in the user's queue rather than imagined:
 * "DO NOT MERGE", "[experiment] …", "spike: …", "Draft: …", "(POC)",
 * "DEMO ONLY", "[DRAFT — blocked]".
 */
export const NOT_FOR_REVIEW_TITLE =
  /\b(?:do not (?:merge|submit|review)|dnm|wip|spike|poc|demo only|experiment)\b|^\s*(?:\[?draft\]?\s*[:—-]|\[experiment\])/i;

/** Accounts whose PRs are machine-generated and never need your eyes. */
export const BOT_AUTHOR = /^(?:app\/|.*\[bot\]$)|^(?:comfy-pr-bot|dependabot|renovate|coderabbitai)$/i;

/** Does this PR still want a human review at all? */
export function needsReview(
  review: Pick<ReviewItem, 'title' | 'author' | 'isDraft'>,
): boolean {
  if (review.isDraft) return false;
  if (BOT_AUTHOR.test(review.author)) return false;
  return !NOT_FOR_REVIEW_TITLE.test(review.title);
}

/** Everything needed to place a review in a bucket. */
export interface TierContext {
  /** Your GitHub login. */
  me: string;
  /** Your immediate team (Preferences ▸ Code reviews). */
  team: readonly string[];
  /** Logins belonging to the repo's org — staff and contractors. */
  orgMembers: ReadonlySet<string>;
  /** Outside contributors you've vetted; treated as colleagues. */
  vetted: readonly string[];
}

/** Which bucket a review belongs in. Personal request wins over
 *  everything; after that it's how close the author is to you. */
export function reviewTier(
  review: Pick<ReviewItem, 'author' | 'requestedLogins'>,
  ctx: TierContext,
): ReviewTier {
  const lc = (s: string): string => s.trim().toLowerCase();
  const author = lc(review.author);
  if ((review.requestedLogins ?? []).some((l) => lc(l) === lc(ctx.me))) return 'direct';
  if (ctx.team.some((t) => lc(t) === author)) return 'team';
  if (ctx.orgMembers.has(author)) return 'org';
  if (ctx.vetted.some((v) => lc(v) === author)) return 'org';
  return 'external';
}

/** trim + lowercase + drop empties — how every term is compared. */
function normalizeTerms(list: string[] | undefined): string[] {
  return (list ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Does this review match the user's mute lists?
 *
 * Shared deliberately: the main process applies it when fetching, and
 * Preferences applies it to decide which already-pinned reviews the
 * "apply to the current list" prompt should offer to drop. Two copies
 * of this rule would drift, and the prompt would start offering to
 * remove things the fetch filter would have kept (or vice versa).
 */
export function reviewIsIgnored(
  review: Pick<ReviewItem, 'title' | 'author'>,
  rules: ReviewIgnoreRules,
): boolean {
  const title = review.title.toLowerCase();
  if (normalizeTerms(rules.ignoreTitlePatterns).some((p) => title.includes(p))) return true;
  return normalizeTerms(rules.ignoreAuthors).includes(review.author.toLowerCase());
}

/** Does this review survive the configured scope? */
export function reviewInScope(
  review: Pick<ReviewItem, 'flags'>,
  scope: ReviewScope,
): boolean {
  return scope !== 'requested' || review.flags.requestedReviewer;
}

/**
 * Combine the pinned rows (fetched by number, one lookup each) with the
 * live queue (one search). Pinned rows lead and are flagged `pinned`; a
 * PR present in both becomes ONE row carrying the union of what either
 * fetch learned. The live row is the base — it went through tiering and
 * scoping — and the pin contributes `closed` and its own re-review
 * verdict.
 *
 * Never let one copy erase the other's flags. Every PR you've reviewed
 * is pinned, and a merge that preferred the pin wholesale threw away the
 * live list's RE-REVIEW flag for exactly the rows that needed it.
 */
export function mergePinnedReviews(pinned: ReviewItem[], live: ReviewItem[]): ReviewItem[] {
  const key = (r: Pick<ReviewItem, 'scm' | 'number'>): string => `${r.scm}:${r.number}`;
  const liveByKey = new Map(live.map((r) => [key(r), r]));
  const merged: ReviewItem[] = pinned.map((p) => {
    const l = liveByKey.get(key(p));
    if (!l) return { ...p, pinned: true };
    const later = new Date(p.updatedAt).getTime() > new Date(l.updatedAt).getTime() ? p : l;
    const engagedAt = Math.max(p.engagedAt ?? 0, l.engagedAt ?? 0);
    return {
      ...l,
      pinned: true,
      closed: !!(p.closed || l.closed),
      title: later.title,
      updatedAt: later.updatedAt,
      ...(engagedAt > 0 ? { engagedAt } : {}),
      flags: {
        requestedReviewer: p.flags.requestedReviewer || l.flags.requestedReviewer,
        noReviewsYet: p.flags.noReviewsYet || l.flags.noReviewsYet,
        reReview: p.flags.reReview || l.flags.reReview,
      },
    };
  });
  const pinnedKeys = new Set(pinned.map(key));
  for (const r of live) {
    if (!pinnedKeys.has(key(r))) merged.push(r);
  }
  return merged;
}

/** Shared failure reasons across review systems. `gh-*` are GitHub-specific
 *  (kept for the renderer's existing status handling); Swarm maps its own
 *  failures onto `no-repo` (not configured / not logged in) and `error`. */
export type ReviewFailReason = 'gh-not-found' | 'gh-not-authed' | 'no-repo' | 'error';

export type ListReviewsResult =
  | { ok: true; reviews: ReviewItem[] }
  | { ok: false; reason: ReviewFailReason; error?: string };

/** Result of listing recent open reviews — the WorkItemSearch picker. */
export type ListRecentReviewsResult =
  | { ok: true; prs: ReviewItem[] }
  | { ok: false; reason: ReviewFailReason; error?: string };

/** Result of fetching one review by number/id — the manual "+" pin flow. */
export type GetReviewResult =
  | { ok: true; pr: ReviewItem }
  | { ok: false; reason: 'not-found' | ReviewFailReason; error?: string };

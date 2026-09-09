/**
 * Provider-agnostic Reviews orchestrator.
 *
 * The Reviews panel spans every configured repo regardless of SCM. This module
 * owns the provider-NEUTRAL concerns — which repos exist, grouping them by scm,
 * dispatching to each {@link SourceControlProvider}'s review methods (gated by
 * `capabilities.pullRequests`), and merging the results — so no GitHub/Swarm
 * specifics leak into the IPC layer. The platform code lives with each provider
 * (`../git/reviews` for GitHub, `../p4/swarmReviews` for Swarm).
 */
import { existsSync } from 'node:fs';
import type { SourceControlProviderId } from '@shared/sourceControl';
import {
  DEFAULT_REVIEW_SCOPE,
  reviewInScope,
  type GetReviewResult,
  type ListRecentReviewsResult,
  type ListReviewsResult,
  type ReviewItem,
  type ReviewProviderInfo,
  type ReviewScope,
  type ReviewSystem,
} from '@shared/reviews';
import { getSetting } from '../persistence/settings';
import { listRepos } from '../persistence/repos';
import { getSourceControlProvider } from '../scm';

interface GitSettingsLite {
  repoPath?: string;
}

/**
 * Configured repo paths grouped by scm provider — existing on disk, deduped.
 * The legacy single-repo `git` setting is folded into the git group for
 * back-compat (mirrors the pre-refactor `configuredRepoPaths`).
 */
export function reposByScm(): Map<SourceControlProviderId, string[]> {
  const groups = new Map<SourceControlProviderId, string[]>();
  const add = (scm: SourceControlProviderId, p?: string): void => {
    if (!p || !existsSync(p)) return;
    const arr = groups.get(scm) ?? [];
    if (!arr.includes(p)) arr.push(p);
    groups.set(scm, arr);
  };
  for (const r of listRepos()) add(r.scm ?? 'git', r.repoPath);
  add('git', getSetting<GitSettingsLite>('git')?.repoPath);
  return groups;
}

/** The (scm, paths) groups whose provider supports reviews. */
function reviewGroups(): Array<{ scm: SourceControlProviderId; paths: string[] }> {
  const out: Array<{ scm: SourceControlProviderId; paths: string[] }> = [];
  for (const [scm, paths] of reposByScm()) {
    if (getSourceControlProvider(scm).capabilities.pullRequests) out.push({ scm, paths });
  }
  return out;
}

/** Review-system tag for a provider id (matches ReviewItem.scm). */
const REVIEW_SYSTEM: Partial<Record<SourceControlProviderId, ReviewSystem>> = {
  git: 'github',
  perforce: 'swarm',
};

/**
 * The review-capable providers to poll, each with its OWN cadence — the panel
 * polls them on independent timers (Swarm slower than GitHub, to protect p4d).
 */
export function reviewProviders(): ReviewProviderInfo[] {
  return reviewGroups().map(({ scm }) => ({
    id: scm,
    system: REVIEW_SYSTEM[scm] ?? 'github',
    pollIntervalMs: getSourceControlProvider(scm).reviewPollIntervalMs(),
  }));
}

/**
 * The user's chosen breadth for the panel. Lives alongside the ignore
 * lists under the `reviews` settings blob. Anything unrecognized (or
 * unset) falls back to the historical behaviour.
 */
function reviewScope(): ReviewScope {
  const scope = getSetting<{ scope?: ReviewScope }>('reviews')?.scope;
  return scope === 'requested' || scope === 'unreviewed' ? scope : DEFAULT_REVIEW_SCOPE;
}

/**
 * Narrow a provider's result to reviews that name the user, when that's
 * the configured scope. Applied here rather than inside each provider so
 * GitHub and Swarm honour the setting identically — both already set
 * `flags.requestedReviewer` from their own notion of "I'm a reviewer".
 */
function applyScope(reviews: ReviewItem[]): ReviewItem[] {
  const scope = reviewScope();
  if (scope !== 'requested') return reviews;
  return reviews.filter((r) => reviewInScope(r, scope));
}

/** Pending reviews for ONE provider (the per-provider poll path). */
export async function listPendingReviewsFor(
  scm: SourceControlProviderId,
): Promise<ListReviewsResult> {
  const group = reviewGroups().find((g) => g.scm === scm);
  if (!group) return { ok: false, reason: 'no-repo' };
  const result = await getSourceControlProvider(scm).listPendingReviews(group.paths);
  return result.ok ? { ok: true, reviews: applyScope(result.reviews) } : result;
}

/**
 * Pending reviews across every review-capable provider, merged into one list.
 * A provider's `no-repo` is ignored (it just has nothing configured); a real
 * failure (e.g. `gh-not-authed`) is surfaced only when NOTHING else returned
 * content, so one provider being unauthed can't blank out another's reviews.
 */
export async function listPendingReviews(): Promise<ListReviewsResult> {
  const groups = reviewGroups();
  if (groups.length === 0) return { ok: false, reason: 'no-repo' };
  const results = await Promise.all(
    groups.map(({ scm, paths }) => getSourceControlProvider(scm).listPendingReviews(paths)),
  );
  const reviews: ReviewItem[] = [];
  let firstError: Extract<ListReviewsResult, { ok: false }> | null = null;
  for (const r of results) {
    if (r.ok) reviews.push(...r.reviews);
    else if (!firstError && r.reason !== 'no-repo') firstError = r;
  }
  if (reviews.length === 0 && firstError) return firstError;
  return { ok: true, reviews: applyScope(reviews) };
}

/**
 * Recent open reviews for the WorkItemSearch picker. GitHub-only for now (the
 * picker is a PR fuzzy-search); routed to the git provider explicitly.
 */
export async function listRecentOpenPrs(): Promise<ListRecentReviewsResult> {
  const paths = reposByScm().get('git') ?? [];
  return getSourceControlProvider('git').listRecentReviews(paths);
}

/**
 * One review by number/id — the manual "+" pin. `scm` selects the review
 * system (defaults to git/GitHub for back-compat); the renderer passes
 * 'perforce' to pin a Swarm review by id.
 */
export async function getReviewByNumber(
  prNumber: number,
  scm: SourceControlProviderId = 'git',
): Promise<GetReviewResult> {
  const paths = reposByScm().get(scm) ?? [];
  return getSourceControlProvider(scm).getReview(paths, prNumber);
}

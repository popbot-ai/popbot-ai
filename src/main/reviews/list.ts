/**
 * GitHub PR-review polling for the popbot Reviews tab.
 *
 * We shell out to the `gh` CLI rather than hitting the API directly
 * because (a) auth is already configured for the same `gh` we use
 * elsewhere in popbot (Open PR link, address-CR templates), and
 * (b) it sidesteps token plumbing.
 *
 * Two `gh pr list --search` calls run in parallel:
 *   1. `review-requested:@me`  — PRs explicitly waiting on the user
 *   2. `review:none -draft`    — open PRs with zero reviews of any kind
 * Their results are unioned and tagged with which rule matched.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { ListReviewsResult, ReviewItem } from '@shared/reviews';
import { getSetting } from '../persistence/settings';
import { listRepos } from '../persistence/repos';

const execFileP = promisify(execFile);

interface GitSettingsLite { repoPath?: string }

/**
 * Resolve the repo path the Reviews tab runs `gh` against. Prefers the
 * multi-repo store (the "Add Repository" flow writes there), then falls
 * back to the legacy single-repo `git` setting for back-compat. Returns
 * null when no configured repo path exists on disk → 'no-repo'.
 *
 * Without this, adding a repo via the new store left the legacy
 * `git.repoPath` empty, so Reviews kept asking to "configure a
 * repository" even though one was already added.
 */
function resolveReviewRepoPath(): string | null {
  for (const r of listRepos()) {
    if (r.repoPath && existsSync(r.repoPath)) return r.repoPath;
  }
  const s = getSetting<GitSettingsLite>('git');
  if (s?.repoPath && existsSync(s.repoPath)) return s.repoPath;
  return null;
}

interface ReviewsSettings {
  /** Substrings (case-insensitive) — any match in the PR title drops
   *  it from the surface. Used to hide bot / generated PRs. */
  ignoreTitlePatterns?: string[];
  /** GitHub logins to drop entirely. Useful for muting bot accounts
   *  that open PRs we never want to review (Crowdin, Renovate, etc.). */
  ignoreAuthors?: string[];
}

const DEFAULT_IGNORE_PATTERNS = ['DO NOT SUBMIT', 'Crowdin'];
const DEFAULT_IGNORE_AUTHORS: string[] = [];

const GH_FIELDS = [
  'number',
  'title',
  'url',
  'author',
  'headRefName',
  'baseRefName',
  'isDraft',
  'createdAt',
  'updatedAt',
].join(',');

interface GhPr {
  number: number;
  title: string;
  url: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
}

async function ghPrSearch(cwd: string, search: string): Promise<GhPr[]> {
  const { stdout } = await execFileP(
    'gh',
    ['pr', 'list', '--state', 'open', '--limit', '100', '--search', search, '--json', GH_FIELDS],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as GhPr[];
}

function classifyError(err: unknown): ListReviewsResult {
  const e = err as { code?: string; stderr?: string; message: string };
  if (e.code === 'ENOENT') return { ok: false, reason: 'gh-not-found' };
  const stderr = (e.stderr ?? '').toLowerCase();
  if (stderr.includes('authentication') || stderr.includes('not logged') || stderr.includes('http 401')) {
    return { ok: false, reason: 'gh-not-authed' };
  }
  return { ok: false, reason: 'error', error: e.stderr?.trim() || e.message };
}

interface PanelASearchSettings {
  recentDays?: number;
}
const DEFAULT_SEARCH_DAYS = 30;
const MAX_SEARCH_DAYS = 365;

function searchSinceIsoDate(): string {
  // GitHub's `gh pr list --search "updated:>YYYY-MM-DD"` accepts a
  // bare date. Convert the configured day-count cutoff into that form.
  const cfg = getSetting<PanelASearchSettings>('panela.search') ?? {};
  const days = Math.max(1, Math.min(MAX_SEARCH_DAYS, Math.floor(cfg.recentDays ?? DEFAULT_SEARCH_DAYS)));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // YYYY-MM-DD
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Recent open PRs in the configured repo, with no review-rule
 * filtering. Used by the WorkItemSearch picker so the search box can
 * fuzzy-match PRs the current user isn't asked to review. Filtered
 * by `updated:>YYYY-MM-DD` per the configurable cutoff.
 */
export async function listRecentOpenPrs(): Promise<
  | { ok: true; prs: ReviewItem[] }
  | { ok: false; reason: 'gh-not-found' | 'gh-not-authed' | 'no-repo' | 'error'; error?: string }
> {
  const repoPath = resolveReviewRepoPath();
  if (!repoPath) return { ok: false, reason: 'no-repo' };
  const search = `is:pr is:open updated:>${searchSinceIsoDate()}`;
  try {
    const rows = await ghPrSearch(repoPath, search);
    const prs: ReviewItem[] = rows.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? '',
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      flags: { requestedReviewer: false, noReviewsYet: false, reReview: false },
    }));
    return { ok: true, prs };
  } catch (err) {
    // classifyError narrows the err's text but its declared return
    // type spans the full ListReviewsResult union. The recent-PRs
    // endpoint has a different success shape (`prs` vs `reviews`)
    // so we only forward the error half.
    const classified = classifyError(err);
    if (!classified.ok) return classified;
    // Should be unreachable — the catch block only runs when ghPrSearch threw.
    return { ok: false, reason: 'error', error: 'unexpected success in error path' };
  }
}

/** Fetch a single PR by number from the configured repo. Used by the
 *  manual-pin flow on PanelA — pinning PRs outside the auto-queue.
 *  Returns the same `ReviewItem` shape as `listPendingReviews` so the
 *  renderer can render pinned + queued items identically. The `flags`
 *  bitmap is conservative — we set neither flag, since manual pins
 *  aren't surfaced because of either rule; they're just user-curated. */
export async function getReviewByNumber(prNumber: number): Promise<
  | { ok: true; pr: ReviewItem }
  | { ok: false; reason: 'not-found' | 'gh-not-found' | 'gh-not-authed' | 'no-repo' | 'error'; error?: string }
> {
  const repoPath = resolveReviewRepoPath();
  if (!repoPath) return { ok: false, reason: 'no-repo' };
  try {
    const { stdout } = await execFileP(
      'gh',
      ['pr', 'view', String(prNumber), '--json', GH_FIELDS],
      { cwd: repoPath, maxBuffer: 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as GhPr;
    const pr: ReviewItem = {
      number: data.number,
      title: data.title,
      url: data.url,
      author: data.author?.login ?? '',
      headRefName: data.headRefName,
      baseRefName: data.baseRefName,
      isDraft: data.isDraft,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      flags: { requestedReviewer: false, noReviewsYet: false, reReview: false },
    };
    return { ok: true, pr };
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message: string };
    if (e.code === 'ENOENT') return { ok: false, reason: 'gh-not-found' };
    const stderr = (e.stderr ?? '').toLowerCase();
    if (stderr.includes('no pull request') || stderr.includes('could not resolve to a pullrequest')) {
      return { ok: false, reason: 'not-found' };
    }
    if (stderr.includes('authentication') || stderr.includes('not logged') || stderr.includes('http 401')) {
      return { ok: false, reason: 'gh-not-authed' };
    }
    return { ok: false, reason: 'error', error: e.stderr?.trim() || e.message };
  }
}

export async function listPendingReviews(): Promise<ListReviewsResult> {
  const cwd = resolveReviewRepoPath();
  if (!cwd) return { ok: false, reason: 'no-repo' };
  let requestedFresh: GhPr[] = [];
  let requestedReReview: GhPr[] = [];
  let unreviewed: GhPr[] = [];
  try {
    // Split the requested-reviewer pile so the renderer can badge
    // re-reviews distinctly from first-time review requests:
    //
    //   requested-reviewer ∩ NOT reviewed-by:@me  → fresh request
    //   requested-reviewer ∩ reviewed-by:@me      → re-review (author
    //                                              pushed fixes + clicked
    //                                              "Re-request review")
    //
    // Both ALWAYS-include `-author:@me` so your own PRs never end up
    // in the queue. The `review:none` branch keeps `-reviewed-by:@me`
    // because that rule's premise is "PRs with no reviews of any
    // kind" — once you've reviewed, the rule no longer applies.
    [requestedFresh, requestedReReview, unreviewed] = await Promise.all([
      ghPrSearch(cwd, 'is:pr is:open review-requested:@me -reviewed-by:@me -author:@me'),
      ghPrSearch(cwd, 'is:pr is:open review-requested:@me reviewed-by:@me -author:@me'),
      ghPrSearch(cwd, 'is:pr is:open review:none -is:draft -reviewed-by:@me -author:@me'),
    ]);
  } catch (err) {
    return classifyError(err);
  }

  const byNumber = new Map<number, ReviewItem>();
  const upsert = (pr: GhPr, flag: 'requestedReviewer' | 'noReviewsYet' | 'reReview'): void => {
    const existing = byNumber.get(pr.number);
    if (existing) {
      existing.flags[flag] = true;
      // A re-review also implies the user is a current requested
      // reviewer (it landed in that bucket) — preserve both flags so
      // the row badges correctly regardless of which one the renderer
      // checks first.
      if (flag === 'reReview') existing.flags.requestedReviewer = true;
      return;
    }
    byNumber.set(pr.number, {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? '',
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      flags: {
        requestedReviewer: flag === 'requestedReviewer' || flag === 'reReview',
        noReviewsYet: flag === 'noReviewsYet',
        reReview: flag === 'reReview',
      },
    });
  };
  for (const pr of requestedFresh) upsert(pr, 'requestedReviewer');
  for (const pr of requestedReReview) upsert(pr, 'reReview');
  for (const pr of unreviewed) upsert(pr, 'noReviewsYet');

  // Filter the "no reviews yet" pile down to PRs whose title carries
  // an ENG-##### Linear-style ticket tag — that's the universe of
  // work we triage; the rest is bot-spam / infra. PRs where the user
  // is explicitly named as a reviewer always pass through regardless,
  // since they were directly addressed.
  // Then apply the configurable ignore list (substring match against
  // the PR title) — kills bot PRs (Crowdin, DO NOT SUBMIT, etc.)
  // even when they otherwise match the rules above.
  const reviewsSettings = getSetting<ReviewsSettings>('reviews');
  const ignorePatterns = (reviewsSettings?.ignoreTitlePatterns ?? DEFAULT_IGNORE_PATTERNS)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const ignoreAuthors = new Set(
    (reviewsSettings?.ignoreAuthors ?? DEFAULT_IGNORE_AUTHORS)
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  );
  const matchesIgnoreTitle = (title: string): boolean => {
    const t = title.toLowerCase();
    return ignorePatterns.some((p) => t.includes(p));
  };
  const reviews = [...byNumber.values()]
    .filter((r) => r.flags.requestedReviewer || /\bENG-\d+\b/i.test(r.title))
    .filter((r) => !matchesIgnoreTitle(r.title))
    .filter((r) => !ignoreAuthors.has(r.author.toLowerCase()))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return { ok: true, reviews };
}

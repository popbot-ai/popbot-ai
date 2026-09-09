/**
 * GitHub PR-review polling — the git provider's review source (colocated
 * with the git platform code; the Perforce/Swarm equivalent lives under
 * `../p4/`). The provider-agnostic Reviews orchestrator + panel consume
 * these through the common review interface.
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
import { promisify } from 'node:util';
import {
  BOT_AUTHOR,
  needsReview,
  REVIEW_TIER_ORDER,
  reviewIsIgnored,
  reviewTier,
  type GetReviewResult,
  type ListRecentReviewsResult,
  type ListReviewsResult,
  type ReviewItem,
} from '@shared/reviews';
import { getSetting } from '../persistence/settings';
import { listClosedChats, listOpenChats } from '../persistence/chats';
import { lastUserMessageAtByChat } from '../persistence/messages';
import { findAcrossRepos } from './findAcrossRepos';

const execFileP = promisify(execFile);

// Repo enumeration (which paths to span, deduped/existing) is owned by the
// provider-agnostic orchestrator in `../reviews`; every function here takes
// the git repo paths to query as an argument.

interface ReviewsSettings {
  /** Substrings (case-insensitive) — any match in the PR title drops
   *  it from the surface. Used to hide bot / generated PRs. */
  ignoreTitlePatterns?: string[];
  /** GitHub logins to drop entirely. Useful for muting bot accounts
   *  that open PRs we never want to review (Crowdin, Renovate, etc.). */
  ignoreAuthors?: string[];
  /** Your team's GitHub logins (Preferences ▸ Code reviews). PRs they
   *  AUTHOR get their own tier, above the general pile. */
  teamMembers?: string[];
  /** Outside contributors you've vetted — treated as colleagues rather
   *  than as drive-by open-source contributions. */
  vettedAuthors?: string[];
  /** Show outside contributors at all. Off by default: reviewing a
   *  colleague's work is an obligation, reviewing a stranger's is a
   *  choice, and mixing them is what made the queue unreadable. */
  includeOutside?: boolean;
}

const DEFAULT_IGNORE_PATTERNS = ['DO NOT SUBMIT', 'Crowdin'];
const DEFAULT_IGNORE_AUTHORS: string[] = [];

/** Past a week untouched, a PR isn't a live review request any more.
 *  Applied to the team + needs-someone piles; a direct ask to you, and
 *  a re-review (author pushed fixes and asked again), both ignore it. */
const STALE_REVIEW_MS = 7 * 24 * 60 * 60 * 1000;

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
  'state',
  'reviewRequests',
  'latestReviews',
  'reviewDecision',
].join(',');

interface GhPr {
  /** Reviewers named on the PR itself. Team requests come back as
   *  nodes with no `login`, which is the whole point: they're what
   *  `review-requested:@me` silently expands to. */
  reviewRequests?: { nodes?: Array<{ requestedReviewer?: { login?: string } | null }> };
  /** GitHub's own verdict: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED
   *  (null when the repo requires no review). Worth using instead of
   *  counting reviews ourselves — coderabbitai leaves a COMMENTED review
   *  on nearly every PR here, so "has reviews" is meaningless while
   *  reviewDecision correctly still reads REVIEW_REQUIRED. */
  reviewDecision?: string | null;
  /** One entry per reviewer (their latest review). Answers the only
   *  question that matters for triage: has a HUMAN looked at this yet?
   *  Bots don't count — coderabbitai reviews nearly every PR in this
   *  repo, so "has reviews" would be true almost everywhere. */
  latestReviews?: {
    nodes?: Array<{ author?: { login?: string } | null; state?: string; submittedAt?: string }>;
  };
  /** Head commit, for spotting work pushed AFTER your review. */
  commits?: { nodes?: Array<{ commit?: { committedDate?: string } }> };
  /** OPEN / MERGED / CLOSED. The list searches are `is:open` so this
   *  only matters for pinned PRs, which are fetched by number and would
   *  otherwise sit in the panel forever after being merged. */
  state?: string;
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

/** GraphQL PR search — same fields as GH_FIELDS, via the search API. */
const SEARCH_GQL = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt reviewDecision
        author { login }
        headRefName baseRefName
        reviewRequests(first: 10) {
          nodes { requestedReviewer { ... on User { login } } }
        }
        latestReviews(first: 10) { nodes { author { login } state submittedAt } }
      }
    }
  }
}`;

interface GqlSearchResponse {
  data?: { search?: { nodes?: Array<Partial<GhPr> & { author?: { login?: string } | null }> } };
}

const nameWithOwnerCache = new Map<string, string>();

/** Org membership, cached per org for an hour. It changes on the scale
 *  of hiring, not of polling, and the queue refreshes every minute. */
const ORG_MEMBER_TTL_MS = 60 * 60 * 1000;
const orgMemberCache = new Map<string, { at: number; members: Set<string> }>();

/**
 * Everyone inside the org — staff and contractors — lowercased.
 *
 * This is what separates a colleague's PR from a drive-by open-source
 * contribution. Failure returns an EMPTY set, which deliberately makes
 * every author look external; the caller keeps outside contributors
 * visible when membership can't be determined, so a transient `gh`
 * failure can never silently hide colleagues' work.
 */
async function orgMembers(cwd: string, org: string): Promise<Set<string>> {
  const hit = orgMemberCache.get(org);
  if (hit && Date.now() - hit.at < ORG_MEMBER_TTL_MS) return hit.members;
  try {
    const { stdout } = await execFileP(
      'gh',
      ['api', `orgs/${org}/members`, '--paginate', '--jq', '.[].login'],
      { cwd, maxBuffer: 4 * 1024 * 1024 },
    );
    const members = new Set(
      stdout.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean),
    );
    if (members.size > 0) orgMemberCache.set(org, { at: Date.now(), members });
    return members;
  } catch {
    return hit?.members ?? new Set();
  }
}

let ghLoginCache: string | null = null;
/** The authenticated `gh` user. Needed to tell a PR that names YOU from
 *  one that merely named a team you happen to be in. */
async function ghLogin(cwd: string): Promise<string> {
  if (ghLoginCache) return ghLoginCache;
  const { stdout } = await execFileP('gh', ['api', 'user', '--jq', '.login'], {
    cwd,
    maxBuffer: 64 * 1024,
  });
  ghLoginCache = stdout.trim();
  return ghLoginCache;
}

/** Has a real person reviewed this yet — approval, changes-requested,
 *  or even just comments? That's "somebody has picked this up", which
 *  is what takes it off the queue. */
function hasHumanReview(pr: GhPr): boolean {
  return (pr.latestReviews?.nodes ?? []).some((n) => {
    const login = n?.author?.login;
    return !!login && !BOT_AUTHOR.test(login);
  });
}

/**
 * When you last engaged with each PR, by PR number.
 *
 * Starting a review CHAT counts as engaging, even if you never submitted
 * anything on GitHub — that's the common case here, since the work
 * happens in PopBot and the verdict gets posted later (or not at all).
 * Closed chats count too: closing one doesn't mean the PR stopped being
 * yours, and re-opening it is exactly what a re-review prompts.
 */
function chatEngagementByPr(): Map<number, number> {
  const out = new Map<number, number>();
  const lastPrompt = lastUserMessageAtByChat();
  for (const c of [...listOpenChats(), ...listClosedChats()]) {
    if (c.pr === null || c.pr === undefined) continue;
    // YOUR last prompt in the chat, not the chat's last activity: the
    // agent finishing the original review after the author pushed is
    // not you looking again. The opening prompt lands at creation, so
    // createdAt is the floor.
    const at = Math.max(lastPrompt.get(c.id) ?? 0, c.createdAt ?? 0);
    out.set(c.pr, Math.max(out.get(c.pr) ?? 0, at));
  }
  return out;
}

/**
 * When did YOU last look at this PR?
 *
 * Used with the head commit's date to answer "has the author pushed since
 * you last engaged?" — the actual "needs another look" signal, and NOT
 * the same as GitHub's "Re-request review" button. Authors here push
 * fixes and mostly never click it, so keying off the button alone meant
 * re-reviews effectively never surfaced. (When they DO click it, that is
 * honoured separately, as an outright re-review.)
 *
 * Note that a re-request drops your earlier review from latestReviews,
 * so on those PRs the chat is the only evidence of engagement.
 */
function engagedAtFor(pr: GhPr, me: string, chatAt: Map<number, number>): number {
  const myReviewAt = me
    ? (pr.latestReviews?.nodes ?? [])
        .filter((n) => n?.author?.login?.toLowerCase() === me.toLowerCase())
        .map((n) => n?.submittedAt)
        .filter((d): d is string => !!d)
        .sort()
        .pop()
    : undefined;
  // Engagement is the LATER of the two: a GitHub review you submitted,
  // and the last time you touched its chat. Either one alone would miss
  // half the cases — reviewing on github.com without a chat, or doing
  // the whole review in a chat and never submitting.
  return Math.max(
    myReviewAt ? new Date(myReviewAt).getTime() : 0,
    chatAt.get(pr.number) ?? 0,
  );
}

/** Logins named directly on a PR (team requests have no login). */
function directReviewers(pr: GhPr): string[] {
  return (pr.reviewRequests?.nodes ?? [])
    .map((n) => n?.requestedReviewer?.login)
    .filter((l): l is string => !!l);
}

/**
 * Head-commit timestamps for specific PRs, keyed by number.
 *
 * Deliberately NOT part of the bulk search: adding `commits(last: 1)` to
 * a 100-result search made GitHub return HTTP 502 outright, which took
 * the whole review list down with it. Asking for a named handful is
 * cheap, and re-review only ever concerns PRs you've already engaged
 * with — typically a couple of dozen, not hundreds.
 */
async function headCommitDates(
  cwd: string,
  repo: string,
  numbers: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const [owner, name] = repo.split('/');
  if (!owner || !name || numbers.length === 0) return out;
  const CHUNK = 25;
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const batch = numbers.slice(i, i + CHUNK);
    const fields = batch
      .map((n) => `p${n}: pullRequest(number: ${n}) { number commits(last: 1) { nodes { commit { committedDate } } } }`)
      .join('\n        ');
    const query = `query { repository(owner: "${owner}", name: "${name}") {\n        ${fields}\n      } }`;
    try {
      const { stdout } = await execFileP('gh', ['api', 'graphql', '-f', `query=${query}`], {
        cwd,
        maxBuffer: 4 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as {
        data?: { repository?: Record<string, { number?: number; commits?: { nodes?: Array<{ commit?: { committedDate?: string } }> } } | null> };
      };
      for (const node of Object.values(parsed.data?.repository ?? {})) {
        const num = node?.number;
        const date = node?.commits?.nodes?.[0]?.commit?.committedDate;
        if (typeof num === 'number' && date) out.set(num, date);
      }
    } catch {
      // A failed head-commit lookup only costs us re-review detection on
      // that batch — never the list itself.
    }
  }
  return out;
}

/**
 * Re-review detection: has the author pushed since YOU last engaged?
 * Sets `flags.reReview` in place. Only PRs you've engaged with can
 * possibly need one, so the head-commit lookup is scoped to those — a
 * couple of dozen rather than several hundred.
 *
 * Shared by the queue search and the pinned-row fetch, and the pinned
 * path is the one that matters most: every PR you've reviewed is pinned,
 * and the moment you review, GitHub drops the team request that put it
 * in the search results. From then on the pin is the only fetch that
 * still sees the PR, so without this check a pushed-on review never
 * earns its RE-REVIEW flag.
 *
 * The flag clears itself: re-engaging (a new review on GitHub, or a turn
 * in the PR's chat) moves `engagedAt` past the head commit. Nothing else
 * should clear it — the author's push is a fact until you act on it.
 */
async function markReReviews(items: ReviewItem[], cwd: string): Promise<void> {
  const engaged = items.filter((r) => (r.engagedAt ?? 0) > 0);
  if (engaged.length === 0) return;
  const byRepo = new Map<string, number[]>();
  for (const r of engaged) {
    // url is https://github.com/<owner>/<name>/pull/<n>
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(r.url);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`;
    byRepo.set(key, [...(byRepo.get(key) ?? []), r.number]);
  }
  for (const [repo, numbers] of byRepo) {
    const heads = await headCommitDates(cwd, repo, numbers);
    for (const r of engaged) {
      const head = heads.get(r.number);
      if (!head) continue;
      if (new Date(head).getTime() > (r.engagedAt ?? 0)) r.flags.reReview = true;
    }
  }
}

/** `owner/name` for the repo at `cwd`, cached. Needed because GraphQL
 *  search isn't scoped by working directory the way `gh pr list` is. */
async function ghNameWithOwner(cwd: string): Promise<string> {
  const cached = nameWithOwnerCache.get(cwd);
  if (cached) return cached;
  const { stdout } = await execFileP(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { cwd, maxBuffer: 64 * 1024 },
  );
  const repo = stdout.trim();
  if (repo) nameWithOwnerCache.set(cwd, repo);
  return repo;
}

/** Build the `repo:owner/name …` search prefix spanning every configured
 *  repo, so one search covers them all. Repos whose remote can't be
 *  resolved (not a GitHub repo) are skipped. Empty when none resolve. */
async function reposQualifier(paths: string[]): Promise<string> {
  const owners = await Promise.all(paths.map((p) => ghNameWithOwner(p).catch(() => '')));
  return owners.filter(Boolean).map((o) => `repo:${o}`).join(' ');
}

/**
 * Run a PR search (scoped to `qualifier`'s repos) and return the matches.
 *
 * We go through `gh api graphql` rather than `gh pr list --search`: gh
 * 2.95.0 regressed the latter (its search GraphQL request returns a
 * malformed body → "invalid character '{' looking for beginning of
 * object key string", failing for ANY search). `gh search prs` works but
 * can't return `headRefName`/`baseRefName`, which we need — so we issue
 * the search query directly. GitHub's search syntax (`@me`,
 * `review-requested:`, etc.) is preserved verbatim. `cwd` only needs to
 * be a directory where `gh` is authed (search itself isn't cwd-scoped).
 */
async function ghPrSearch(qualifier: string, search: string, cwd: string): Promise<GhPr[]> {
  const q = `${qualifier} ${search}`;
  const { stdout } = await execFileP(
    'gh',
    ['api', 'graphql', '-f', `query=${SEARCH_GQL}`, '-F', `q=${q}`],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as GqlSearchResponse;
  const nodes = parsed.data?.search?.nodes ?? [];
  // type: ISSUE search can include issues; non-PR nodes come back as
  // empty objects via the inline fragment, so filter by `number`.
  return nodes
    .filter((n) => typeof n.number === 'number')
    .map((n) => ({
      number: n.number as number,
      title: n.title ?? '',
      url: n.url ?? '',
      author: { login: n.author?.login ?? '' },
      headRefName: n.headRefName ?? '',
      baseRefName: n.baseRefName ?? '',
      isDraft: n.isDraft ?? false,
      createdAt: n.createdAt ?? '',
      updatedAt: n.updatedAt ?? '',
      reviewRequests: n.reviewRequests,
      reviewDecision: n.reviewDecision ?? null,
      latestReviews: n.latestReviews,
      commits: n.commits,
    }));
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
export async function listRecentOpenPrs(paths: string[]): Promise<ListRecentReviewsResult> {
  if (!paths.length) return { ok: false, reason: 'no-repo' };
  const qualifier = await reposQualifier(paths);
  if (!qualifier) return { ok: false, reason: 'no-repo' };
  const search = `is:pr is:open updated:>${searchSinceIsoDate()}`;
  try {
    const rows = await ghPrSearch(qualifier, search, paths[0]);
    const prs: ReviewItem[] = rows.map((pr) => ({
      scm: 'github',
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? '',
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      requestedLogins: directReviewers(pr),
      approved: pr.reviewDecision === 'APPROVED',
      humanReviewed: hasHumanReview(pr),
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

function isMissingPrError(err: unknown): boolean {
  const e = err as { stderr?: string; message?: string };
  const text = `${e.stderr ?? ''}\n${e.message ?? ''}`.toLowerCase();
  return text.includes('no pull request') || text.includes('could not resolve to a pullrequest');
}

/** Fetch a single PR by number from any configured repo. Used by the
 *  manual-pin flow on PanelA — pinning PRs outside the auto-queue.
 *  Returns the same `ReviewItem` shape as `listPendingReviews` so the
 *  renderer can render pinned + queued items identically. The `flags`
 *  bitmap is conservative — we set neither flag, since manual pins
 *  aren't surfaced because of either rule; they're just user-curated. */
export async function getReviewByNumber(paths: string[], prNumber: number): Promise<GetReviewResult> {
  if (!paths.length) return { ok: false, reason: 'no-repo' };
  try {
    // `gh pr view <number>` is scoped to cwd's repository, while the picker
    // search spans every configured repo. Looking up from paths[0] meant a PR
    // could appear in search and then fail to pin merely because it belonged
    // to another configured repo (for example frontend PR #16190).
    const match = await findAcrossRepos(
      paths,
      async (repoPath) => {
        const { stdout } = await execFileP(
          'gh',
          ['pr', 'view', String(prNumber), '--json', GH_FIELDS],
          { cwd: repoPath, maxBuffer: 1024 * 1024 },
        );
        return JSON.parse(stdout) as GhPr;
      },
      isMissingPrError,
    );
    if (!match) return { ok: false, reason: 'not-found' };
    const { repoPath, value: data } = match;
    const me = await ghLogin(repoPath).catch(() => '');
    const reviewsSettings = getSetting<ReviewsSettings>('reviews');
    // Pinned rows come in outside the tiering query, so tier them
    // here too — otherwise every pin defaults to 'other' and a
    // teammate's PR you pinned would sort under strangers'.
    const tier = reviewTier(
      { author: data.author?.login ?? '', requestedLogins: directReviewers(data) },
      {
        me,
        team: reviewsSettings?.teamMembers ?? [],
        orgMembers: await orgMembers(
          repoPath,
          /github\.com\/([^/]+)\//.exec(data.url ?? '')?.[1] ?? '',
        ).catch(() => new Set<string>()),
        vetted: reviewsSettings?.vettedAuthors ?? [],
      },
    );
    const pr: ReviewItem = {
      scm: 'github',
      number: data.number,
      title: data.title,
      url: data.url,
      author: data.author?.login ?? '',
      headRefName: data.headRefName,
      baseRefName: data.baseRefName,
      isDraft: data.isDraft,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      closed: !!data.state && data.state.toUpperCase() !== 'OPEN',
      requestedLogins: directReviewers(data),
      humanReviewed: hasHumanReview(data),
      approved: data.reviewDecision === 'APPROVED',
      // Same engagement notion as the queue: your latest GitHub review,
      // or the last turn in the PR's chat, whichever is later.
      engagedAt: engagedAtFor(data, me, chatEngagementByPr()),
      tier,
      flags: { requestedReviewer: tier === 'direct', noReviewsYet: false, reReview: false },
    };
    // Pins are exactly the PRs you've reviewed, so they're exactly the
    // ones that can come back around. Same rules as the queue: a pending
    // request addressed to you on a PR you've engaged with is a
    // re-review outright (a re-request also drops your earlier review
    // from latestReviews, so the chat is what proves the engagement),
    // and otherwise a push after your last look is.
    if (!pr.closed) {
      if (tier === 'direct' && (pr.engagedAt ?? 0) > 0) pr.flags.reReview = true;
      else await markReReviews([pr], repoPath);
    }
    return { ok: true, pr };
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message: string };
    if (e.code === 'ENOENT') return { ok: false, reason: 'gh-not-found' };
    const stderr = (e.stderr ?? '').toLowerCase();
    if (isMissingPrError(err)) {
      return { ok: false, reason: 'not-found' };
    }
    if (stderr.includes('authentication') || stderr.includes('not logged') || stderr.includes('http 401')) {
      return { ok: false, reason: 'gh-not-authed' };
    }
    return { ok: false, reason: 'error', error: e.stderr?.trim() || e.message };
  }
}

export async function listPendingReviews(paths: string[]): Promise<ListReviewsResult> {
  if (!paths.length) return { ok: false, reason: 'no-repo' };
  const qualifier = await reposQualifier(paths);
  if (!qualifier) return { ok: false, reason: 'no-repo' };
  const cwd = paths[0];
  let requestedFresh: GhPr[] = [];
  let requestedReReview: GhPr[] = [];
  let unreviewed: GhPr[] = [];
  let reviewedByMe: GhPr[] = [];
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
    // allSettled, not all: one bucket failing (GitHub 502s on the big
    // ones under load) used to take the ENTIRE list down with it. A
    // partial list beats an empty one — we only report failure when
    // every bucket failed.
    //
    // The fourth bucket is the PRs you've reviewed and are no longer
    // asked on. GitHub drops the team request the moment you review, so
    // these vanish from the request searches exactly when they become
    // yours. They enter the pile with no flag; phase two marks the ones
    // the author has pushed on since as re-reviews, and the
    // human-reviewed filter below drops the rest (you're the human). Net
    // effect: this bucket surfaces "pushed on top of your review" and
    // nothing else — whether or not the author clicked re-request, and
    // whether or not the PR happens to be pinned.
    const settled = await Promise.allSettled([
      ghPrSearch(qualifier, 'is:pr is:open review-requested:@me -reviewed-by:@me -author:@me', cwd),
      ghPrSearch(qualifier, 'is:pr is:open review-requested:@me reviewed-by:@me -author:@me', cwd),
      ghPrSearch(qualifier, 'is:pr is:open review:none -is:draft -reviewed-by:@me -author:@me', cwd),
      ghPrSearch(qualifier, 'is:pr is:open reviewed-by:@me -review-requested:@me -author:@me', cwd),
    ]);
    if (settled.every((r) => r.status === 'rejected')) {
      return classifyError((settled[0] as PromiseRejectedResult).reason);
    }
    const val = (i: number): GhPr[] =>
      settled[i].status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<GhPr[]>).value : [];
    [requestedFresh, requestedReReview, unreviewed, reviewedByMe] = [val(0), val(1), val(2), val(3)];
  } catch (err) {
    return classifyError(err);
  }

  // Resolved up-front: needed both to tell a personal request from a
  // team one, and to spot commits pushed after YOUR review.
  const me = await ghLogin(cwd).catch(() => '');
  const chatAt = chatEngagementByPr();

  // Explicit "Re-request review" clicks. Kept aside so the final pass
  // can honour them only when the request names YOU — the bucket also
  // matches team requests, which aren't an ask for a second look from
  // you specifically.
  const reRequested = new Set(requestedReReview.map((pr) => pr.number));

  const byNumber = new Map<number, ReviewItem>();
  const upsert = (
    pr: GhPr,
    flag: 'requestedReviewer' | 'noReviewsYet' | 'reReview' | 'reviewedByMe',
  ): void => {
    const existing = byNumber.get(pr.number);
    if (existing) {
      // 'reviewedByMe' carries no flag of its own — the PR is in the pile
      // so phase two can look at it; it must not alter what another
      // bucket already established.
      if (flag === 'reviewedByMe') return;
      if (flag !== 'reReview') existing.flags[flag] = true;
      // A re-review also implies the user is a current requested
      // reviewer (it landed in that bucket) — preserve both flags so
      // the row badges correctly regardless of which one the renderer
      // checks first.
      if (flag === 'reReview') existing.flags.requestedReviewer = true;
      return;
    }
    byNumber.set(pr.number, {
      scm: 'github',
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? '',
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      requestedLogins: directReviewers(pr),
      approved: pr.reviewDecision === 'APPROVED',
      humanReviewed: hasHumanReview(pr),
      engagedAt: engagedAtFor(pr, me, chatAt),
      flags: {
        requestedReviewer: flag === 'requestedReviewer' || flag === 'reReview',
        noReviewsYet: flag === 'noReviewsYet',
        // Set in phase two, once head-commit dates are known — the
        // search bucket only catches an explicit "Re-request review"
        // click, which authors here don't use.
        reReview: false,
      },
    });
  };
  for (const pr of requestedFresh) upsert(pr, 'requestedReviewer');
  for (const pr of requestedReReview) upsert(pr, 'reReview');
  for (const pr of unreviewed) upsert(pr, 'noReviewsYet');
  for (const pr of reviewedByMe) upsert(pr, 'reviewedByMe');

  const reviewsSettings = getSetting<ReviewsSettings>('reviews');
  const ignorePatterns = (reviewsSettings?.ignoreTitlePatterns ?? DEFAULT_IGNORE_PATTERNS)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const ignoreAuthors = reviewsSettings?.ignoreAuthors ?? DEFAULT_IGNORE_AUTHORS;
  const team = reviewsSettings?.teamMembers ?? [];
  const vetted = reviewsSettings?.vettedAuthors ?? [];
  // Org membership comes from the repo owner. Multi-repo queues union
  // every owner's members, so a colleague is a colleague across repos.
  const owners = [...new Set(
    [...byNumber.values()]
      .map((r) => /github\.com\/([^/]+)\//.exec(r.url)?.[1])
      .filter((o): o is string => !!o),
  )];
  const memberSets = await Promise.all(owners.map((o) => orgMembers(cwd, o)));
  const members = new Set(memberSets.flatMap((m) => [...m]));
  // Couldn't determine membership? Then we can't tell a colleague from a
  // stranger, and hiding "external" would hide colleagues. Show it all.
  const membershipKnown = members.size > 0;
  const includeOutside = reviewsSettings?.includeOutside === true || !membershipKnown;
  const ctx = { me, team, orgMembers: members, vetted };
  // Re-review, phase two: has the author pushed since you last engaged?
  await markReReviews([...byNumber.values()], cwd);

  const reviews = [...byNumber.values()]
    .map((r) => {
      const tier = reviewTier(r, ctx);
      const direct = tier === 'direct';
      return {
        ...r,
        tier,
        flags: {
          ...r.flags,
          // Re-derive from the PR's actual reviewer list rather than
          // from which search bucket matched. `review-requested:@me`
          // also matches PRs that only asked a TEAM you're in, so the
          // bucket can't tell "asked me" from "asked 17 of us" — and
          // the `? YOU` pill on 300 rows makes the handful that really
          // are yours impossible to spot.
          requestedReviewer: direct,
          // A pending re-request addressed to you IS a re-review, whatever
          // the commit dates say: the author asked, and GitHub keeps
          // asking until you submit a review — which is also what makes
          // it leave this bucket. Pushes without the click are caught by
          // phase two above.
          reReview: r.flags.reReview || (direct && reRequested.has(r.number)),
        },
      };
    })
    .filter((r) => {
      // Named personally? Nothing filters it out. A direct ask always
      // reaches you, whatever the rules say.
      if (r.tier === 'direct') return true;
      if (reviewIsIgnored(r, { ignoreTitlePatterns: ignorePatterns, ignoreAuthors })) return false;
      // Outside contributions are opt-in. Vetted authors were promoted
      // to 'org' above, so this only drops genuine strangers.
      if (r.tier === 'external' && !includeOutside) return false;
      // Both lower tiers exist to catch what NOBODY has looked at. The
      // moment a real person reviews — approve, request changes, or
      // even just comment — it's been picked up and drops off. Only a
      // direct request is exempt: someone else reviewing doesn't
      // discharge an ask addressed to you.
      // …unless the human who reviewed it was YOU and the author has
      // pushed since. That's not "someone picked it up", that's your
      // own in-flight review coming back around.
      if (r.humanReviewed && !r.flags.reReview) return false;
      // Age out anything gone quiet for a week. A re-review is exempt:
      // the author pushed fixes and re-asked, so the clock restarts on
      // intent, not on the PR's age.
      if (!r.flags.reReview && Date.now() - new Date(r.updatedAt).getTime() > STALE_REVIEW_MS) {
        return false;
      }
      if (r.tier === 'team') return needsReview(r);
      // Everyone else clears a higher bar: actually reviewable, nobody
      // has signed off yet, and it hasn't been abandoned.
      //
      // There used to be an `ENG-####` ticket-tag requirement here, on
      // the theory that tagged work is the work worth triaging. Measured
      // against the real queue it matched 0 of 500 open PRs — this team
      // writes conventional-commit subjects (`fix(billing): …`), not
      // Linear tags — so it was silently emptying this entire pile.
      //
      // Approval reads GitHub's reviewDecision rather than "has any
      // reviews": coderabbitai leaves a review on nearly every PR here,
      // so counting reviews would hide ~128 PRs no human has read.
      // Colleagues outside your team, and vetted outsiders, clear a
      // slightly higher bar: nobody has signed off yet.
      if (r.approved && !r.flags.reReview) return false;
      return needsReview(r);
    })
    .sort((a, b) => {
      const byTier = REVIEW_TIER_ORDER.indexOf(a.tier) - REVIEW_TIER_ORDER.indexOf(b.tier);
      if (byTier !== 0) return byTier;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  return { ok: true, reviews };
}

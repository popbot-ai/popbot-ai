/**
 * GitHub Issues client for the popbot Tickets queue.
 *
 * Like the Reviews tab (`main/reviews/list.ts`), we shell out to the `gh`
 * CLI rather than hitting the API directly: auth is already configured for
 * the same `gh` used elsewhere in popbot (Open PR link, address-CR
 * templates, PR review polling), which sidesteps token plumbing entirely.
 *
 * Every response is normalized into the SAME DTO shapes the renderer
 * already consumes for Linear (`LinearIssueDto`, `LinearWorkflowStateDto`,
 * `LinearProjectDto`) so the Tickets queue stays provider-agnostic — main
 * routes ticket IPC to Linear / Jira / GitHub on the `ticketSource`
 * setting, and the renderer branches only on the capabilities advertised
 * in `shared/ticketProvider.ts`, never on the provider id.
 *
 * Issue ⇄ Linear shape impedance:
 *   - A GitHub issue is identified by `owner/repo#number`. We set the DTO
 *     `id` AND `identifier` to that string, so it's unique across the
 *     multi-repo set and round-trips through the spawn/pin flows. Branch
 *     derivation sanitizes the `/` and `#` (see App.tsx `ticketBranch`).
 *   - Issues have no workflow states (only open/closed) and no native
 *     priority, so the `github` provider advertises `changeStatus: false`
 *     and `priority: false`; the renderer hides the status picker and
 *     drops priority grouping accordingly. The repo is surfaced as the
 *     DTO `project` so each row still carries useful context.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type {
  LinearIssueDto,
} from '@shared/linear';
import type { GithubSettings } from '@shared/ticketProvider';
import { getSetting } from '../persistence/settings';
import { listRepos } from '../persistence/repos';

const execFileP = promisify(execFile);

/** Auth / CLI failures are surfaced distinctly so the IPC layer can tell
 *  the renderer to show "reconnect gh" vs a generic error. */
export class GithubAuthError extends Error {
  constructor(message = 'GitHub CLI is not authenticated') {
    super(message);
    this.name = 'GithubAuthError';
  }
}

/** Raised when the `gh` binary isn't on PATH at all. */
export class GithubCliMissingError extends Error {
  constructor(message = 'GitHub CLI (gh) was not found') {
    super(message);
    this.name = 'GithubCliMissingError';
  }
}

/** Raised when GitHub is selected but no configured repo resolves to a
 *  GitHub slug. Distinct from "authed but empty queue" so the IPC layer
 *  can map it to `notConfigured` and nudge the user to add/fix a repo. */
export class GithubNoRepoError extends Error {
  constructor(message = 'No configured GitHub repositories could be resolved') {
    super(message);
    this.name = 'GithubNoRepoError';
  }
}

/** Hard ceiling on any single `gh` call. These run inside IPC handlers, so
 *  a stalled auth/network request would otherwise hang the handler — and
 *  the UI waiting on it — indefinitely. */
const GH_TIMEOUT_MS = 15_000;

/** Single choke point for every `gh` invocation in this module. Enforces a
 *  timeout (fail fast instead of blocking the UI) and sets
 *  `GH_PROMPT_DISABLED=1` so `gh` never stalls waiting on an interactive
 *  prompt in our non-interactive context. */
function ghExec(
  args: string[],
  opts: { cwd?: string; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileP('gh', args, {
    cwd: opts.cwd,
    maxBuffer: opts.maxBuffer ?? 64 * 1024,
    timeout: GH_TIMEOUT_MS,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
}

interface GitSettingsLite { repoPath?: string }

/**
 * All configured repo paths the Tickets queue spans — every repo in the
 * multi-repo store, plus the legacy single-repo `git` setting for
 * back-compat. Deduped, existing on disk. Mirrors the Reviews tab so
 * GitHub issues and GitHub PRs cover the same repo set.
 */
function configuredRepoPaths(): string[] {
  const paths: string[] = [];
  for (const r of listRepos()) {
    if (r.repoPath && existsSync(r.repoPath) && !paths.includes(r.repoPath)) {
      paths.push(r.repoPath);
    }
  }
  const legacy = getSetting<GitSettingsLite>('git')?.repoPath;
  if (legacy && existsSync(legacy) && !paths.includes(legacy)) paths.push(legacy);
  return paths;
}

const nameWithOwnerCache = new Map<string, string>();

/** `owner/name` for the repo at `cwd`, cached. GraphQL search isn't scoped
 *  by working directory, so we resolve each repo's slug to build `repo:`
 *  qualifiers. */
async function ghNameWithOwner(cwd: string): Promise<string> {
  const cached = nameWithOwnerCache.get(cwd);
  if (cached) return cached;
  const { stdout } = await ghExec(
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { cwd },
  );
  const repo = stdout.trim();
  if (repo) nameWithOwnerCache.set(cwd, repo);
  return repo;
}

/** Resolve every configured repo to its `owner/name` slug (skipping repos
 *  whose remote can't be resolved). Returns the slugs and a usable cwd
 *  (any authed repo dir) for the `gh` invocation. */
async function resolveRepos(): Promise<{ slugs: string[]; cwd: string } | null> {
  const paths = configuredRepoPaths();
  if (!paths.length) return null;
  const slugs = (await Promise.all(paths.map((p) => ghNameWithOwner(p).catch(() => '')))).filter(Boolean);
  if (!slugs.length) return null;
  return { slugs, cwd: paths[0] };
}

/** `repo:owner/name …` prefix spanning every configured repo so a single
 *  search covers them all. */
function reposQualifier(slugs: string[]): string {
  return slugs.map((s) => `repo:${s}`).join(' ');
}

// ---- GitHub → DTO mapping helpers ----------------------------------------

interface GhLabel { name: string; color?: string }
interface GhIssueNode {
  number: number;
  title: string;
  url: string;
  state: string; // OPEN | CLOSED
  body?: string;
  createdAt: string;
  updatedAt: string;
  repository?: { nameWithOwner?: string } | null;
  labels?: { nodes?: GhLabel[] } | GhLabel[] | null;
}

/** Best-effort priority from issue labels, mapped onto Linear's numeric
 *  scale (0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low). Recognizes
 *  common conventions (`priority: high`, `P1`, `urgent`, …). Falls back to
 *  0 — most issues are unprioritized and land in the "No priority" group. */
function mapPriority(labels: GhLabel[]): number {
  for (const l of labels) {
    const n = l.name.toLowerCase();
    if (/\b(urgent|critical|p0)\b/.test(n)) return 1;
    if (/\b(high|p1)\b/.test(n) || /priority:\s*high/.test(n)) return 2;
    if (/\b(medium|p2)\b/.test(n) || /priority:\s*med/.test(n)) return 3;
    if (/\b(low|p3|p4)\b/.test(n) || /priority:\s*low/.test(n)) return 4;
  }
  return 0;
}

function normalizeLabels(labels: GhIssueNode['labels']): GhLabel[] {
  if (!labels) return [];
  if (Array.isArray(labels)) return labels;
  return labels.nodes ?? [];
}

/** GitHub issue state → the Linear DTO state shape the renderer renders.
 *  Open issues are "to do" (unstarted, green); closed are "completed"
 *  (purple, matching GitHub's own closed hue). */
function mapState(state: string): LinearIssueDto['state'] {
  if (state.toUpperCase() === 'CLOSED') {
    return { name: 'Closed', type: 'completed', color: '#a371f7', position: 3 };
  }
  return { name: 'Open', type: 'unstarted', color: '#3fb950', position: 1 };
}

function mapIssue(node: GhIssueNode, nameWithOwner: string): LinearIssueDto {
  const identifier = `${nameWithOwner}#${node.number}`;
  const body = (node.body ?? '').trim();
  const shortRepo = nameWithOwner.split('/').pop() ?? nameWithOwner;
  return {
    id: identifier,
    identifier,
    title: node.title,
    description: body.length ? body : null,
    url: node.url,
    priority: mapPriority(normalizeLabels(node.labels)),
    state: mapState(node.state),
    // Stash the identifier where the renderer expects a "team id" (the
    // status picker is hidden for GitHub, but keep the field populated).
    team: { id: identifier, key: shortRepo },
    project: { name: nameWithOwner },
    updatedAt: node.updatedAt || node.createdAt || new Date().toISOString(),
  };
}

// ---- gh invocation -------------------------------------------------------

const SEARCH_GQL = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on Issue {
        number title url state body createdAt updatedAt
        repository { nameWithOwner }
        labels(first: 20) { nodes { name color } }
      }
    }
  }
}`;

interface GqlSearchResponse {
  data?: { search?: { nodes?: Array<Partial<GhIssueNode>> } };
}

/** Translate a raw execFile/`gh` failure into one of our typed errors. */
function rethrowGhError(err: unknown): never {
  const e = err as { code?: string; stderr?: string; message?: string };
  if (e.code === 'ENOENT') throw new GithubCliMissingError();
  const stderr = (e.stderr ?? '').toLowerCase();
  if (
    stderr.includes('authentication') ||
    stderr.includes('not logged') ||
    stderr.includes('gh auth login') ||
    stderr.includes('http 401')
  ) {
    throw new GithubAuthError();
  }
  throw new Error(e.stderr?.trim() || e.message || 'gh issue query failed');
}

/** Run an issue search (scoped to the configured repos) and map the
 *  matches to DTOs. Goes through `gh api graphql` — same approach the
 *  Reviews tab uses for PR search — so GitHub's search syntax (`@me`,
 *  `assignee:`, `updated:>`, …) is preserved verbatim. */
async function searchIssues(search: string): Promise<LinearIssueDto[]> {
  const resolved = await resolveRepos();
  // No resolvable repo isn't an empty result — it's an unconfigured
  // GitHub setup. Surface it so the source maps it to `notConfigured`
  // (the renderer then prompts to add/fix a repo) instead of showing an
  // empty "no active tickets" queue.
  if (!resolved) throw new GithubNoRepoError();
  const q = `${reposQualifier(resolved.slugs)} ${search}`.trim();
  let stdout: string;
  try {
    ({ stdout } = await ghExec(
      ['api', 'graphql', '-f', `query=${SEARCH_GQL}`, '-F', `q=${q}`],
      { cwd: resolved.cwd, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (err) {
    rethrowGhError(err);
  }
  const parsed = JSON.parse(stdout) as GqlSearchResponse;
  const nodes = parsed.data?.search?.nodes ?? [];
  // `type: ISSUE` search can include PRs; non-issue nodes come back as
  // empty objects via the inline fragment, so filter by `number`.
  return nodes
    .filter((n): n is GhIssueNode => typeof n.number === 'number')
    .map((n) => mapIssue(n, n.repository?.nameWithOwner ?? ''));
}

/** Issues open and assigned to the current user across the configured
 *  repos — the Tickets queue's "my active work" list. */
export async function fetchMyIssues(s: GithubSettings | undefined): Promise<LinearIssueDto[]> {
  const extra = (s?.search ?? '').trim();
  return searchIssues(`is:issue is:open assignee:@me${extra ? ` ${extra}` : ''}`);
}

/** Recent issues (any assignee) for the WorkItemSearch cache. */
export async function fetchRecentIssues(
  s: GithubSettings | undefined,
  sinceIso: string,
): Promise<LinearIssueDto[]> {
  const extra = (s?.search ?? '').trim();
  const since = sinceIso.slice(0, 10); // GitHub accepts a bare YYYY-MM-DD
  return searchIssues(`is:issue updated:>${since}${extra ? ` ${extra}` : ''}`);
}

/** Parse a user-supplied or stored issue identifier into `owner/repo` +
 *  number. Accepts the canonical `owner/repo#123`, a short `repo#123`, or
 *  a bare `#123` / `123` (resolved against the configured repos when the
 *  repo is unambiguous). Returns null when it can't be resolved. */
async function resolveIssueRef(
  raw: string,
): Promise<{ nameWithOwner: string; number: number } | null> {
  const trimmed = raw.trim().replace(/^#/, '');
  // owner/repo#123
  let m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(trimmed);
  if (m) return { nameWithOwner: m[1], number: Number(m[2]) };

  const resolved = await resolveRepos();
  if (!resolved) return null;
  // Prefer an exact `owner/name` match; otherwise fall back to the
  // basename — but ONLY when exactly one configured slug has it. With
  // `org-a/app` + `org-b/app`, a bare `app#123` is ambiguous, so refuse
  // rather than silently pick the first and fetch the wrong issue.
  const slugLookup = (repo: string): string | undefined => {
    const wanted = repo.toLowerCase();
    const exact = resolved.slugs.find((s) => s.toLowerCase() === wanted);
    if (exact) return exact;
    const basenameMatches = resolved.slugs.filter(
      (s) => (s.split('/').pop() ?? '').toLowerCase() === wanted,
    );
    return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
  };

  // repo#123 (short repo name, resolve owner from configured repos)
  m = /^([\w.-]+)#(\d+)$/.exec(trimmed);
  if (m) {
    const slug = slugLookup(m[1]);
    if (slug) return { nameWithOwner: slug, number: Number(m[2]) };
    return null;
  }
  // bare 123 — only when exactly one repo is configured.
  m = /^(\d+)$/.exec(trimmed);
  if (m && resolved.slugs.length === 1) {
    return { nameWithOwner: resolved.slugs[0], number: Number(m[1]) };
  }
  return null;
}

interface GhIssueViewJson {
  number: number;
  title: string;
  url: string;
  state: string;
  body?: string;
  createdAt: string;
  updatedAt: string;
  labels?: GhLabel[];
}

/** Single issue by identifier, for the manual-pin flow on PanelA. Returns
 *  null for an unparseable identifier or a not-found issue. */
export async function fetchIssueByIdentifier(
  raw: string,
): Promise<LinearIssueDto | null> {
  const ref = await resolveIssueRef(raw);
  if (!ref) return null;
  let stdout: string;
  try {
    ({ stdout } = await ghExec(
      [
        'issue', 'view', String(ref.number),
        '--repo', ref.nameWithOwner,
        '--json', 'number,title,url,state,body,createdAt,updatedAt,labels',
      ],
      { cwd: configuredRepoPaths()[0] ?? process.cwd(), maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (err) {
    const e = err as { stderr?: string };
    const stderr = (e.stderr ?? '').toLowerCase();
    if (stderr.includes('not found') || stderr.includes('could not resolve')) return null;
    rethrowGhError(err);
  }
  const data = JSON.parse(stdout) as GhIssueViewJson;
  // `gh issue view` reports CLOSED/OPEN lowercase ("closed"); normalize.
  return mapIssue(
    { ...data, state: data.state, labels: data.labels ?? [] } as GhIssueNode,
    ref.nameWithOwner,
  );
}

/** Verify the `gh` CLI is installed + authenticated and report which repos
 *  the queue will span. Feeds the GitHub Preferences form's status line. */
export async function checkAuth(): Promise<
  | { ok: true; login: string; repoCount: number }
  | { ok: false; reason: 'gh-not-found' | 'gh-not-authed' | 'no-repo' | 'error'; error?: string }
> {
  const paths = configuredRepoPaths();
  if (!paths.length) return { ok: false, reason: 'no-repo' };
  try {
    const { stdout } = await ghExec(['api', 'user', '-q', '.login'], { cwd: paths[0] });
    // Authed, but if none of the configured repos resolve to a GitHub slug
    // the queue would be empty — report that as `no-repo` so the form nudges
    // the user to add/fix a repo rather than claiming everything is fine.
    const resolved = await resolveRepos();
    if (!resolved?.slugs.length) return { ok: false, reason: 'no-repo' };
    return { ok: true, login: stdout.trim(), repoCount: resolved.slugs.length };
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') return { ok: false, reason: 'gh-not-found' };
    const stderr = (e.stderr ?? '').toLowerCase();
    if (stderr.includes('authentication') || stderr.includes('not logged') || stderr.includes('http 401')) {
      return { ok: false, reason: 'gh-not-authed' };
    }
    return { ok: false, reason: 'error', error: e.stderr?.trim() || e.message };
  }
}

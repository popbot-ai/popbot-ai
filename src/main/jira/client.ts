/**
 * Minimal Jira Cloud REST client. Mirrors the surface of the Linear
 * client (`main/linear/client.ts`) and — crucially — normalizes every
 * response into the SAME DTO shapes the renderer already consumes for
 * Linear (`LinearIssueDto`, `LinearWorkflowStateDto`, `LinearProjectDto`).
 *
 * That normalization is what lets the renderer stay provider-agnostic:
 * main routes ticket IPC to Linear or Jira based on the `ticketSource`
 * setting, and the renderer never branches on the provider id (only on
 * the capabilities advertised in `shared/ticketProvider.ts`).
 *
 * Auth: Jira Cloud uses HTTP Basic with an Atlassian account email +
 * API token (id.atlassian.com → Security → API tokens). We send
 * `Authorization: Basic base64(email:apiToken)`.
 *
 * Notes on Jira ⇄ Linear shape impedance:
 *   - Jira issue *keys* ("ENG-3") play the role of Linear's `identifier`.
 *     We set the DTO `id` AND `identifier` to the key (Jira's REST issue
 *     paths accept the key), so the spawn/pin/promote/status flows that
 *     pass `issue.id` keep working unchanged.
 *   - Linear's per-issue status picker calls `listStates(issue.team.id)`.
 *     Jira transitions are per-issue, not per-team, so we stash the issue
 *     KEY in `team.id`; the routed `listStates` handler then asks Jira for
 *     that issue's available transitions.
 *   - Workflow "states" for Jira are the issue's available transitions;
 *     the transition id is used as the `state.id` passed back to
 *     `setIssueState`.
 */

import type {
  LinearIssueDto,
  LinearProjectDto,
  LinearWorkflowStateDto,
} from '@shared/linear';
import type { JiraSettings } from '@shared/ticketProvider';

export class JiraAuthError extends Error {
  constructor(message = 'Jira credentials were rejected') {
    super(message);
    this.name = 'JiraAuthError';
  }
}

/** Connection config resolved to required fields. Callers pass raw
 *  `JiraSettings`; `requireConn` validates + trims before any request. */
interface JiraConn {
  baseUrl: string;
  email: string;
  apiToken: string;
}

/** Returns a usable connection or null when credentials are incomplete.
 *  The IPC layer turns null into `{ notConfigured: true }`. */
export function resolveConn(s: JiraSettings | undefined): JiraConn | null {
  const baseUrl = (s?.baseUrl ?? '').trim().replace(/\/+$/, '');
  const email = (s?.email ?? '').trim();
  const apiToken = (s?.apiToken ?? '').trim();
  if (!baseUrl || !email || !apiToken) return null;
  return { baseUrl, email, apiToken };
}

function authHeader(conn: JiraConn): string {
  return 'Basic ' + Buffer.from(`${conn.email}:${conn.apiToken}`).toString('base64');
}

async function jiraFetch<T>(
  conn: JiraConn,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${conn.baseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: authHeader(conn),
      Accept: 'application/json',
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401 || res.status === 403) {
    throw new JiraAuthError();
  }
  if (res.status === 204) {
    // No content (e.g. successful transition POST).
    return undefined as T;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Jira API ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

// ---- Jira → DTO mapping helpers ------------------------------------------

/** Jira priority names → Linear's numeric scale
 *  (0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low). */
function mapPriority(name: string | undefined): number {
  switch ((name ?? '').toLowerCase()) {
    case 'highest':
      return 1;
    case 'high':
      return 2;
    case 'medium':
      return 3;
    case 'low':
      return 4;
    case 'lowest':
      return 4;
    default:
      return 0;
  }
}

/** Jira statusCategory key → Linear workflow `type` bucket. The renderer's
 *  state glyphs (`lib/linearIcons.tsx`) switch on these names. */
function mapStateType(categoryKey: string | undefined): string {
  switch (categoryKey) {
    case 'new':
      return 'unstarted';
    case 'indeterminate':
      return 'started';
    case 'done':
      return 'completed';
    default:
      return 'unstarted';
  }
}

/** Sort position so the status picker orders backlog → in-progress → done,
 *  matching Linear's `position` semantics. */
function mapStatePosition(categoryKey: string | undefined): number {
  switch (categoryKey) {
    case 'new':
      return 1;
    case 'indeterminate':
      return 2;
    case 'done':
      return 3;
    default:
      return 1;
  }
}

/** Map Jira statusCategory colorName → a hex color for the DTO. Falls
 *  back to a sensible hue per category key. */
function mapStateColor(colorName: string | undefined, categoryKey: string | undefined): string {
  switch ((colorName ?? '').toLowerCase()) {
    case 'blue-gray':
    case 'medium-gray':
    case 'gray':
      return '#9aa0a6';
    case 'yellow':
      return '#f2c94c';
    case 'blue':
      return '#4f9dde';
    case 'green':
      return '#22c55e';
    case 'warm-red':
    case 'red':
      return '#ef4444';
    case 'brown':
      return '#a16207';
    default:
      break;
  }
  switch (categoryKey) {
    case 'indeterminate':
      return '#4f9dde';
    case 'done':
      return '#22c55e';
    default:
      return '#9aa0a6';
  }
}

/** Flatten an Atlassian Document Format (ADF) node tree into plain text.
 *  Jira Cloud REST v3 returns issue descriptions as ADF JSON; the Tickets
 *  queue only needs readable text (for the spawn prompt template), so we
 *  extract text nodes and break on block boundaries. Handles the rare
 *  case where the field is already a plain string. */
function adfToText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (typeof node === 'object') {
    const n = node as { type?: string; text?: string; content?: unknown };
    if (n.type === 'text' && typeof n.text === 'string') return n.text;
    if (n.type === 'hardBreak') return '\n';
    const inner = n.content !== undefined ? adfToText(n.content) : '';
    // Block-level nodes get a trailing newline so paragraphs/list items
    // don't run together.
    const block = new Set([
      'paragraph',
      'heading',
      'listItem',
      'blockquote',
      'codeBlock',
      'rule',
    ]);
    return n.type && block.has(n.type) ? `${inner}\n` : inner;
  }
  return '';
}

// ---- On-the-wire Jira shapes (only the fields we read) -------------------

interface JiraStatusCategory {
  key?: string;
  colorName?: string;
}
interface JiraIssueFields {
  summary?: string;
  description?: unknown;
  updated?: string;
  priority?: { name?: string } | null;
  status?: { name?: string; statusCategory?: JiraStatusCategory } | null;
  project?: { key?: string; name?: string } | null;
}
interface JiraIssue {
  id: string;
  key: string;
  fields?: JiraIssueFields;
}

const ISSUE_FIELDS = ['summary', 'description', 'updated', 'priority', 'status', 'project'];

/** Jira project keys: a leading letter, then letters/digits. Used both to
 *  validate manual-pin input and to recognize a key in promote/get flows. */
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

function mapIssue(conn: JiraConn, raw: JiraIssue): LinearIssueDto {
  const f = raw.fields ?? {};
  const cat = f.status?.statusCategory;
  const desc = adfToText(f.description).trim();
  return {
    id: raw.key,
    identifier: raw.key,
    title: f.summary ?? raw.key,
    description: desc.length ? desc : null,
    url: `${conn.baseUrl}/browse/${raw.key}`,
    priority: mapPriority(f.priority?.name),
    state: {
      name: f.status?.name ?? 'Unknown',
      type: mapStateType(cat?.key),
      color: mapStateColor(cat?.colorName, cat?.key),
      position: mapStatePosition(cat?.key),
    },
    // Stash the issue key where the renderer expects a "team id" so the
    // per-issue status picker can fetch this issue's transitions.
    team: { id: raw.key, key: f.project?.key ?? '' },
    project: f.project?.name ? { name: f.project.name } : null,
    updatedAt: f.updated ?? new Date().toISOString(),
  };
}

// ---- JQL builders --------------------------------------------------------

/** Quote a JQL string literal, escaping embedded quotes/backslashes. */
function jqlStr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Format an ISO timestamp as Jira's JQL date-time literal
 *  ("yyyy/MM/dd HH:mm"). */
function jqlDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `"${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}"`;
}

/** Compose a JQL WHERE clause from parts, appending the user's custom JQL
 *  scope + a stable ORDER BY. */
function composeJql(parts: string[], extra: string | undefined): string {
  const clauses = [...parts];
  const trimmedExtra = (extra ?? '').trim();
  if (trimmedExtra) clauses.push(`(${trimmedExtra})`);
  const where = clauses.filter(Boolean).join(' AND ');
  return `${where} ORDER BY updated DESC`;
}

interface SearchResponse {
  issues?: JiraIssue[];
}

async function search(conn: JiraConn, jql: string, limit: number): Promise<JiraIssue[]> {
  const data = await jiraFetch<SearchResponse>(conn, '/rest/api/3/search/jql', {
    method: 'POST',
    body: { jql, fields: ISSUE_FIELDS, maxResults: limit },
  });
  return data.issues ?? [];
}

// ---- Public API (parallels main/linear/client.ts) ------------------------

export interface JiraViewer {
  accountId: string;
  email: string;
  name: string;
}

/** Verify credentials by hitting `myself`. */
export async function fetchViewer(s: JiraSettings): Promise<JiraViewer> {
  const conn = requireConn(s);
  const data = await jiraFetch<{
    accountId: string;
    emailAddress?: string;
    displayName?: string;
  }>(conn, '/rest/api/3/myself');
  return {
    accountId: data.accountId,
    email: data.emailAddress ?? '',
    name: data.displayName ?? '',
  };
}

function requireConn(s: JiraSettings): JiraConn {
  const conn = resolveConn(s);
  if (!conn) throw new Error('Jira is not configured');
  return conn;
}

/** Issues assigned to the current user that aren't Done — the Tickets
 *  queue's "my active work" list. */
export async function fetchMyIssues(s: JiraSettings, limit = 100): Promise<LinearIssueDto[]> {
  const conn = requireConn(s);
  const parts = ['assignee = currentUser()', 'statusCategory != Done'];
  if (s.projectKey?.trim()) parts.push(`project = ${jqlStr(s.projectKey.trim())}`);
  const issues = await search(conn, composeJql(parts, s.jql), limit);
  return issues.map((i) => mapIssue(conn, i));
}

/** Recent issues (any assignee) for the WorkItemSearch cache. */
export async function fetchRecentIssues(
  s: JiraSettings,
  sinceIso: string,
  limit = 200,
): Promise<LinearIssueDto[]> {
  const conn = requireConn(s);
  const parts = [`updated >= ${jqlDate(sinceIso)}`];
  if (s.projectKey?.trim()) parts.push(`project = ${jqlStr(s.projectKey.trim())}`);
  const issues = await search(conn, composeJql(parts, s.jql), limit);
  return issues.map((i) => mapIssue(conn, i));
}

/** Single issue by key ("ENG-3"). Returns null for an unparseable key or
 *  a 404 (issue not found / not visible). */
export async function fetchIssueByKey(s: JiraSettings, key: string): Promise<LinearIssueDto | null> {
  const conn = requireConn(s);
  const k = key.trim().toUpperCase();
  if (!KEY_RE.test(k)) return null;
  try {
    const raw = await jiraFetch<JiraIssue>(
      conn,
      `/rest/api/3/issue/${encodeURIComponent(k)}?fields=${ISSUE_FIELDS.join(',')}`,
    );
    return mapIssue(conn, raw);
  } catch (err) {
    if (err instanceof JiraAuthError) throw err;
    // 404 etc. → treat as not-found.
    return null;
  }
}

interface JiraTransition {
  id: string;
  name?: string;
  to?: { name?: string; statusCategory?: JiraStatusCategory } | null;
}

async function fetchTransitionsRaw(conn: JiraConn, issueKey: string): Promise<JiraTransition[]> {
  const data = await jiraFetch<{ transitions?: JiraTransition[] }>(
    conn,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
  );
  return data.transitions ?? [];
}

/** Available transitions for an issue, mapped to the workflow-state DTO so
 *  the status picker renders them like Linear states. The transition id
 *  becomes `state.id` (passed back to `setIssueState`). */
export async function fetchTransitions(
  s: JiraSettings,
  issueKey: string,
): Promise<LinearWorkflowStateDto[]> {
  const conn = requireConn(s);
  const transitions = await fetchTransitionsRaw(conn, issueKey);
  return transitions
    .map((t) => {
      const cat = t.to?.statusCategory;
      return {
        id: t.id,
        name: t.to?.name ?? t.name ?? 'Unknown',
        type: mapStateType(cat?.key),
        color: mapStateColor(cat?.colorName, cat?.key),
        position: mapStatePosition(cat?.key),
      };
    })
    .sort((a, b) => a.position - b.position);
}

/** Apply a transition. Jira's POST returns 204 with no body, so we resolve
 *  the resulting status name from the transition list for the caller's
 *  optimistic re-render. */
export async function transitionIssue(
  s: JiraSettings,
  issueKey: string,
  transitionId: string,
): Promise<{ success: boolean; stateName: string | null }> {
  const conn = requireConn(s);
  const transitions = await fetchTransitionsRaw(conn, issueKey);
  const chosen = transitions.find((t) => t.id === transitionId);
  if (!chosen) return { success: false, stateName: null };
  await jiraFetch(conn, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    body: { transition: { id: transitionId } },
  });
  return { success: true, stateName: chosen.to?.name ?? chosen.name ?? null };
}

/** Active projects visible to the credentials, for the Preferences project
 *  picker. Uses the paginated project search and maps to the DTO. */
export async function fetchProjects(s: JiraSettings): Promise<LinearProjectDto[]> {
  const conn = requireConn(s);
  const data = await jiraFetch<{
    values?: Array<{ id: string; key: string; name: string }>;
  }>(conn, '/rest/api/3/project/search?maxResults=100&orderBy=lastIssueUpdatedTime');
  return (data.values ?? []).map((p) => ({
    id: p.key,
    name: p.name,
    state: 'started',
    teamKeys: [p.key],
  }));
}

/** Idempotently move an issue to "In Progress" on chat spawn. Mirrors the
 *  Linear promote heuristic: only act when the issue is still upstream
 *  (statusCategory `new`); leave in-progress/done alone. Picks the
 *  transition whose target status matches /in.?progress/i, else the first
 *  transition into an `indeterminate` (in-progress) category, else no-op. */
export async function promoteIssue(
  s: JiraSettings,
  key: string,
): Promise<{ promoted: boolean; stateName?: string; reason?: string }> {
  const conn = requireConn(s);
  const k = key.trim().toUpperCase();
  if (!KEY_RE.test(k)) return { promoted: false, reason: 'not-found' };
  let raw: JiraIssue;
  try {
    raw = await jiraFetch<JiraIssue>(
      conn,
      `/rest/api/3/issue/${encodeURIComponent(k)}?fields=status`,
    );
  } catch (err) {
    if (err instanceof JiraAuthError) throw err;
    return { promoted: false, reason: 'not-found' };
  }
  const catKey = raw.fields?.status?.statusCategory?.key;
  if (catKey !== 'new') {
    // Already started/done — nothing to do.
    return { promoted: false, stateName: raw.fields?.status?.name };
  }
  const transitions = await fetchTransitionsRaw(conn, k);
  const target =
    transitions.find((t) => /in.?progress/i.test(t.to?.name ?? t.name ?? '')) ??
    transitions.find((t) => t.to?.statusCategory?.key === 'indeterminate');
  if (!target) return { promoted: false, reason: 'no-in-progress-state' };
  await jiraFetch(conn, `/rest/api/3/issue/${encodeURIComponent(k)}/transitions`, {
    method: 'POST',
    body: { transition: { id: target.id } },
  });
  return { promoted: true, stateName: target.to?.name ?? target.name };
}

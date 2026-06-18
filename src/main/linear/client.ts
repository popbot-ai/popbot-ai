/**
 * Minimal Linear GraphQL client. We don't pull in @linear/sdk because
 * we only need a couple of queries — keeping the surface tiny means we
 * can audit exactly what hits the network.
 *
 * Auth: Linear personal API keys go in the `Authorization` header
 * verbatim (no `Bearer` prefix). See linear.app/developers/graphql.
 */

const ENDPOINT = 'https://api.linear.app/graphql';

export class LinearAuthError extends Error {
  constructor(message = 'Linear API key was rejected') {
    super(message);
    this.name = 'LinearAuthError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

async function gql<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new LinearAuthError();
  }
  if (!res.ok) {
    throw new Error(`Linear API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    const isAuth = json.errors.some((e) => e.extensions?.code === 'AUTHENTICATION_ERROR');
    if (isAuth) throw new LinearAuthError(json.errors[0].message);
    throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) throw new Error('Linear GraphQL returned no data');
  return json.data;
}

export interface LinearViewer {
  id: string;
  email: string;
  name: string;
}

export async function fetchViewer(apiKey: string): Promise<LinearViewer> {
  const data = await gql<{ viewer: LinearViewer }>(apiKey, 'query { viewer { id email name } }');
  return data.viewer;
}

export interface LinearIssue {
  id: string;
  identifier: string; // e.g. "ENG-204"
  title: string;
  /** Markdown description from Linear. May be empty. */
  description: string | null;
  url: string;
  priority: number; // 0..4 (0 = none, 1 = urgent, 4 = low)
  state: { name: string; type: string; color: string; position: number };
  team: { id: string; key: string };
  project: { name: string } | null;
  updatedAt: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
}

/**
 * Pull the user's "active" issues — anything assigned to them that's
 * unstarted, started, or in triage. Sorted by recent activity. We cap
 * at `limit` because PanelA shows a flat list, not pagination.
 */
export async function fetchMyIssues(opts: {
  apiKey: string;
  teamKey?: string;
  projectId?: string;
  limit?: number;
}): Promise<LinearIssue[]> {
  const { apiKey, teamKey, projectId, limit = 100 } = opts;
  const filter: Record<string, unknown> = {
    assignee: { isMe: { eq: true } },
    state: { type: { in: ['triage', 'backlog', 'unstarted', 'started'] } },
  };
  if (teamKey?.trim()) {
    filter.team = { key: { eq: teamKey.trim() } };
  }
  if (projectId?.trim()) {
    filter.project = { id: { eq: projectId.trim() } };
  }
  const query = `
    query MyIssues($filter: IssueFilter!, $first: Int!) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          description
          url
          priority
          updatedAt
          state { name type color position }
          team { id key }
          project { name }
        }
      }
    }`;
  const data = await gql<{ issues: { nodes: LinearIssue[] } }>(apiKey, query, {
    filter,
    first: limit,
  });
  return data.issues.nodes;
}

export interface LinearProject {
  id: string;
  name: string;
  state: string;
  teams: { nodes: Array<{ key: string }> };
}

/** Workflow states (statuses) defined for a team's issue workflow.
 *  Used by the status-picker UI so the user can move an issue between
 *  states from inside PopBot. Sorted by `position` (Linear's own
 *  workflow ordering: backlog → in-progress → done). */
export async function fetchWorkflowStates(opts: {
  apiKey: string;
  teamId: string;
}): Promise<LinearWorkflowState[]> {
  const { apiKey, teamId } = opts;
  const query = `
    query States($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type color position } }
      }
    }`;
  const data = await gql<{ team: { states: { nodes: LinearWorkflowState[] } } }>(
    apiKey, query, { teamId },
  );
  const nodes = data.team?.states?.nodes ?? [];
  return [...nodes].sort((a, b) => a.position - b.position);
}

/** Look up a single issue by its identifier ("ENG-1234"). Returns
 *  null when the identifier doesn't parse, when the issue isn't
 *  found, or when the user's API key can't see it. Used by the
 *  spawn-from-ticket flow to read the current state + team without
 *  having to plumb the full LinearIssueDto through the renderer. */
export async function fetchIssueByIdentifier(opts: {
  apiKey: string;
  identifier: string;
}): Promise<{
  id: string;
  identifier: string;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string };
} | null> {
  const { apiKey, identifier } = opts;
  // Linear identifiers are `<TEAMKEY>-<NUMBER>`. Reject anything else
  // up front rather than waste an API call. Float type matches Linear's
  // GraphQL schema for issue.number.
  const m = /^([A-Z]{2,5})-(\d+)$/.exec(identifier);
  if (!m) return null;
  const teamKey = m[1];
  const number = Number(m[2]);
  const query = `
    query Issue($teamKey: String!, $number: Float!) {
      issues(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }, first: 1) {
        nodes {
          id
          identifier
          state { id name type }
          team { id key }
        }
      }
    }`;
  const data = await gql<{
    issues: {
      nodes: Array<{
        id: string;
        identifier: string;
        state: { id: string; name: string; type: string };
        team: { id: string; key: string };
      }>;
    };
  }>(apiKey, query, { teamKey, number });
  return data.issues.nodes[0] ?? null;
}

/**
 * Bulk pull of recent issues across the configured team (or all
 * teams visible to the API key when none configured), filtered by
 * `updatedAt >= sinceIso`. Used by the WorkItemSearch picker so the
 * search box can fuzzy-match tickets the current user isn't
 * personally assigned. Limit kept moderate to stay within Linear's
 * rate budget on every refresh.
 */
export async function fetchRecentIssues(opts: {
  apiKey: string;
  teamKey?: string;
  sinceIso: string;
  limit?: number;
}): Promise<LinearIssue[]> {
  const { apiKey, teamKey, sinceIso, limit = 200 } = opts;
  const filter: Record<string, unknown> = {
    updatedAt: { gte: sinceIso },
  };
  if (teamKey?.trim()) {
    filter.team = { key: { eq: teamKey.trim() } };
  }
  const query = `
    query RecentIssues($filter: IssueFilter!, $first: Int!) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          description
          url
          priority
          updatedAt
          state { name type color position }
          team { id key }
          project { name }
        }
      }
    }`;
  const data = await gql<{ issues: { nodes: LinearIssue[] } }>(apiKey, query, {
    filter,
    first: limit,
  });
  return data.issues.nodes;
}

/** Full-DTO lookup of a single issue by identifier. Same field set as
 *  the `fetchMyIssues` rows so the renderer can render it through the
 *  same `LinearIssueDto` path. Returns null when the identifier
 *  doesn't parse or the issue isn't visible to the user. Used by the
 *  manual-pin flow on PanelA. */
export async function fetchIssueDtoByIdentifier(opts: {
  apiKey: string;
  identifier: string;
}): Promise<LinearIssue | null> {
  const m = /^([A-Z]{2,5})-(\d+)$/.exec(opts.identifier.trim());
  if (!m) return null;
  const teamKey = m[1];
  const number = Number(m[2]);
  const query = `
    query IssueDto($teamKey: String!, $number: Float!) {
      issues(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }, first: 1) {
        nodes {
          id
          identifier
          title
          description
          url
          priority
          updatedAt
          state { name type color position }
          team { id key }
          project { name }
        }
      }
    }`;
  const data = await gql<{ issues: { nodes: LinearIssue[] } }>(
    opts.apiKey, query, { teamKey, number },
  );
  return data.issues.nodes[0] ?? null;
}

/** Move an issue to a new workflow state. Returns the post-mutation
 *  state name so the caller can confirm + re-render without a full
 *  list-issues refetch. */
export async function updateIssueState(opts: {
  apiKey: string;
  issueId: string;
  stateId: string;
}): Promise<{ success: boolean; stateName: string | null }> {
  const { apiKey, issueId, stateId } = opts;
  const query = `
    mutation UpdateIssueState($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { state { name } }
      }
    }`;
  const data = await gql<{
    issueUpdate: { success: boolean; issue: { state: { name: string } | null } | null };
  }>(apiKey, query, { id: issueId, input: { stateId } });
  return {
    success: data.issueUpdate.success,
    stateName: data.issueUpdate.issue?.state?.name ?? null,
  };
}

/** List active projects, optionally filtered to a single team. */
export async function fetchProjects(opts: {
  apiKey: string;
  teamKey?: string;
}): Promise<LinearProject[]> {
  const { apiKey, teamKey } = opts;
  const filter: Record<string, unknown> = {
    state: { in: ['planned', 'started'] },
  };
  if (teamKey?.trim()) {
    filter.accessibleTeams = { key: { eq: teamKey.trim() } };
  }
  const query = `
    query Projects($filter: ProjectFilter!) {
      projects(filter: $filter, first: 100, orderBy: updatedAt) {
        nodes { id name state teams { nodes { key } } }
      }
    }`;
  const data = await gql<{ projects: { nodes: LinearProject[] } }>(apiKey, query, { filter });
  return data.projects.nodes;
}

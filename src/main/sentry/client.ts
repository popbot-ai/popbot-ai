/**
 * Minimal Sentry REST client. Hand-rolled fetch, no SDK — we only need
 * two endpoints (verify + list issues), keeping the surface tiny means
 * we can audit exactly what hits the network and the user knows their
 * messages stay local.
 */
import type { SentryIssueDto } from '@shared/sentry';

const API = 'https://sentry.io/api/0';

export class SentryAuthError extends Error {
  constructor(message = 'Sentry auth token rejected') {
    super(message);
    this.name = 'SentryAuthError';
  }
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) throw new SentryAuthError();
  if (!res.ok) {
    throw new Error(`Sentry ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  return (await res.json()) as T;
}

interface OrgInfo { slug: string; name: string }

/** Verify token + org. Used by the Save button + as a startup probe. */
export async function fetchOrg(opts: { token: string; orgSlug: string }): Promise<OrgInfo> {
  return await get<OrgInfo>(`/organizations/${encodeURIComponent(opts.orgSlug)}/`, opts.token);
}

/**
 * Recent unresolved issues, scoped to one project when projectSlug is
 * set, otherwise the whole org. We pull the last N (default 25); the
 * poller diffs by id against last-tick, so this can stay small.
 */
export async function fetchRecentIssues(opts: {
  token: string;
  orgSlug: string;
  projectSlug?: string;
  limit?: number;
}): Promise<SentryIssueDto[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  // statsPeriod=24h scopes the result set; the poller's id-diff is
  // what actually decides "new". Org-level endpoint includes a project
  // filter inside the query when scoped.
  const query = opts.projectSlug
    ? `is:unresolved project:${opts.projectSlug}`
    : `is:unresolved`;
  const path = `/organizations/${encodeURIComponent(opts.orgSlug)}/issues/`
    + `?query=${encodeURIComponent(query)}`
    + `&statsPeriod=24h`
    + `&limit=${limit}`
    + `&sort=date`;
  return await get<SentryIssueDto[]>(path, opts.token);
}

/**
 * Minimal Helix Swarm (P4 Code Review) REST client.
 *
 * Swarm is discovered from the Perforce server itself: the `P4.Swarm.URL`
 * property (set by an admin via `p4 property -a -n P4.Swarm.URL -v <url>`)
 * tells us where Swarm lives. Auth to the REST API is HTTP Basic using the
 * Perforce user + an existing login **ticket** (Swarm rejects the raw
 * password) — we read the ticket out of the local tickets file with
 * `p4 tickets` so background polling never prompts.
 *
 * There is no general `swarm` CLI; the REST API (`/api/vN/...`) is the
 * programmatic surface. We pin a version but fall back if the server is older.
 */
import { p4exec, type P4Context } from './exec';

/** A Swarm review as returned by `GET /api/vN/reviews`. Only the fields we
 *  surface in the Reviews panel; Swarm returns more. */
export interface SwarmReview {
  id: number;
  author: string;
  participants: string[];
  description: string;
  /** needsReview | needsRevision | approved | rejected | archived (+commit states). */
  state: string;
  stateLabel: string;
  /** Epoch seconds. */
  created: number;
  updated: number;
  changes: number[];
  pending: boolean;
}

export interface SwarmConn {
  /** Base URL, no trailing slash, e.g. "http://swarm.host". */
  url: string;
  /** API version path segment, e.g. "v11". */
  apiVersion: string;
  /** Perforce user (Basic-auth username). */
  user: string;
  /** 32-char login ticket (Basic-auth password). */
  ticket: string;
}

const PREFERRED_API_VERSIONS = [11, 10, 9] as const;

/** Read `P4.Swarm.URL` for this connection. Null when unset (Swarm not wired
 *  up on the server). Trailing slashes trimmed. */
export async function swarmUrlFor(ctx: P4Context): Promise<string | null> {
  const res = await p4exec(ctx, ['-ztag', 'property', '-l', '-n', 'P4.Swarm.URL'], {
    tolerant: true,
    timeout: 10_000,
  });
  // -ztag emits "... value <url>" (plus "... name P4.Swarm.URL", "... time …").
  const m = /^\.\.\.\s+value\s+(.*)$/m.exec(res.stdout);
  const url = m?.[1]?.trim();
  return url ? url.replace(/\/+$/, '') : null;
}

/** Pull the 32-char login ticket for `ctx.user` out of `p4 tickets`. The
 *  tickets file keys by the server's own id (e.g. "localhost:p4_1"), so we
 *  match on the user, not the port. Null when no ticket (user not logged in). */
export async function swarmTicketFor(ctx: P4Context): Promise<string | null> {
  const res = await p4exec(ctx, ['tickets'], { tolerant: true, timeout: 10_000 });
  // Each line is: "host:port (user) <ticket-hex>". Token-split rather than
  // regex-interpolate the (possibly regex-special) username.
  const wanted = `(${ctx.user})`;
  for (const line of res.stdout.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    const i = tokens.indexOf(wanted);
    if (i >= 0) {
      const tok = tokens[i + 1];
      if (tok && /^[0-9A-Fa-f]{32,}$/.test(tok)) return tok;
    }
  }
  return null;
}

/** Resolve a usable {@link SwarmConn} for a connection, or null if Swarm
 *  isn't configured / the user isn't authed. Probes the API version list. */
export async function resolveSwarmConn(ctx: P4Context): Promise<SwarmConn | null> {
  const [url, ticket] = await Promise.all([swarmUrlFor(ctx), swarmTicketFor(ctx)]);
  if (!url || !ticket) return null;
  const apiVersion = await pickApiVersion(url);
  return { url, apiVersion, user: ctx.user, ticket };
}

/** Ask Swarm which API versions it supports (unauthenticated) and pick the
 *  newest we know. Falls back to v11 if the probe fails. */
async function pickApiVersion(url: string): Promise<string> {
  try {
    const resp = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(10_000) });
    if (resp.ok) {
      const body = (await resp.json()) as { apiVersions?: number[] };
      const versions = new Set(body.apiVersions ?? []);
      const pick = PREFERRED_API_VERSIONS.find((v) => versions.has(v));
      if (pick) return `v${pick}`;
    }
  } catch {
    // fall through to default
  }
  return 'v11';
}

function authHeader(conn: SwarmConn): string {
  return 'Basic ' + Buffer.from(`${conn.user}:${conn.ticket}`).toString('base64');
}

const REVIEW_FIELDS = [
  'id',
  'author',
  'participants',
  'description',
  'state',
  'stateLabel',
  'created',
  'updated',
  'changes',
  'pending',
].join(',');

/**
 * List open reviews from Swarm. Returns up to `max` most-recent reviews in
 * the given states (default: the two that need attention). The caller filters
 * further (e.g. dropping the current user's own reviews).
 */
export async function listSwarmReviews(
  conn: SwarmConn,
  opts: { states?: string[]; max?: number } = {},
): Promise<SwarmReview[]> {
  const states = opts.states ?? ['needsReview', 'needsRevision'];
  const params = new URLSearchParams();
  params.set('max', String(opts.max ?? 100));
  params.set('fields', REVIEW_FIELDS);
  // Swarm takes repeated state[] params for an OR over states.
  for (const s of states) params.append('state[]', s);
  const resp = await fetch(`${conn.url}/api/${conn.apiVersion}/reviews?${params}`, {
    headers: { Authorization: authHeader(conn), Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new SwarmHttpError(resp.status, `Swarm reviews list failed: HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as { data?: { reviews?: SwarmReview[] } };
  return body.data?.reviews ?? [];
}

/** Fetch a single review by id, or null if it doesn't exist (404). */
export async function getSwarmReview(conn: SwarmConn, id: number): Promise<SwarmReview | null> {
  const params = new URLSearchParams({ fields: REVIEW_FIELDS });
  const resp = await fetch(`${conn.url}/api/${conn.apiVersion}/reviews/${id}?${params}`, {
    headers: { Authorization: authHeader(conn), Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new SwarmHttpError(resp.status, `Swarm review ${id} failed: HTTP ${resp.status}`);
  const body = (await resp.json()) as { data?: { review?: SwarmReview } };
  return body.data?.review ?? null;
}

export class SwarmHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SwarmHttpError';
  }
}

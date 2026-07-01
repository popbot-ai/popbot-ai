/**
 * Helix Swarm reviews for the Reviews panel — the Perforce provider's review
 * source (colocated with the p4 platform code; the GitHub equivalent lives in
 * ../git/reviews). Maps Swarm's REST reviews onto the shared ReviewItem so the
 * one Reviews panel renders GitHub PRs and Swarm reviews side by side.
 *
 * Reviews are p4-SERVER-scoped, not per-repo-path: all configured Perforce
 * repos on a server share its Swarm. We resolve the connection from a repo's
 * .p4config when present, else the machine's ambient p4 connection. The
 * P4.Swarm.URL property + login ticket are cached (see below) so a steady-state
 * poll is a single Swarm REST GET — p4d stays out of the hot path.
 */
import type { GetReviewResult, ListReviewsResult, ReviewItem } from '@shared/reviews';
import { readP4Config, type P4Context } from './exec';
import { ambientP4Conn } from '../scm/detect';
import {
  getSwarmReview,
  listSwarmReviews,
  resolveSwarmConn,
  SwarmHttpError,
  type SwarmConn,
  type SwarmReview,
} from './swarmClient';

/** Conservative default poll cadence for Swarm reviews (ms) — deliberately
 *  slower than GitHub's 60s so a shop full of clients doesn't hammer p4d. A
 *  user setting overrides this in the provider. */
export const DEFAULT_SWARM_POLL_MS = 120_000;

// ---- connection cache (keeps p4d out of the hot path) ----
// resolveSwarmConn runs `p4 property` + `p4 tickets` + a version probe. Those
// rarely change, so we cache the resolved SwarmConn per (port|user) for a
// short TTL and drop the whole cache on an auth failure.
interface CacheEntry {
  conn: SwarmConn;
  expires: number;
}
const connCache = new Map<string, CacheEntry>();
const CONN_TTL_MS = 5 * 60_000;

/** A P4 connection for the given repo paths: the first repo's .p4config if
 *  present, else the machine's ambient p4 connection. Null when neither
 *  exists (Perforce not configured on this machine). */
async function ctxFor(paths: string[]): Promise<P4Context | null> {
  for (const p of paths) {
    const cfg = readP4Config(p);
    if (cfg) return cfg;
  }
  const amb = await ambientP4Conn();
  return amb ? { port: amb.port, user: amb.user } : null;
}

async function connFor(paths: string[], now: number): Promise<SwarmConn | null> {
  const ctx = await ctxFor(paths);
  if (!ctx) return null;
  const key = `${ctx.port}|${ctx.user}`;
  const hit = connCache.get(key);
  if (hit && hit.expires > now) return hit.conn;
  const conn = await resolveSwarmConn(ctx);
  if (conn) connCache.set(key, { conn, expires: now + CONN_TTL_MS });
  return conn;
}

/** Drop cached connections — called after an auth failure so the next poll
 *  re-reads the ticket. Cheap to clear wholesale (single-server in practice). */
function invalidateConnCache(): void {
  connCache.clear();
}

function firstLine(s: string): string {
  const t = (s || '').trim();
  const nl = t.indexOf('\n');
  return nl >= 0 ? t.slice(0, nl) : t;
}

/** Map a Swarm review onto the shared ReviewItem. `headRefName` carries the
 *  associated changelist(s) for display; `baseRefName`/`isDraft` don't apply to
 *  Swarm and are left neutral. */
function toReviewItem(r: SwarmReview, conn: SwarmConn): ReviewItem {
  const isAuthor = r.author === conn.user;
  const iAmParticipant = r.participants?.includes(conn.user) ?? false;
  return {
    scm: 'swarm',
    number: r.id,
    title: firstLine(r.description) || `Review ${r.id}`,
    url: `${conn.url}/reviews/${r.id}`,
    author: r.author,
    headRefName: r.changes?.length ? `CL ${r.changes.join(', ')}` : '',
    baseRefName: '',
    isDraft: false,
    createdAt: new Date(r.created * 1000).toISOString(),
    updatedAt: new Date(r.updated * 1000).toISOString(),
    flags: {
      // I'm a reviewer on someone else's review.
      requestedReviewer: iAmParticipant && !isAuthor,
      // Still awaiting review (vs. needs-revision after feedback).
      noReviewsYet: r.state === 'needsReview',
      reReview: false,
    },
  };
}

/** Open Swarm reviews awaiting the user, excluding the user's own (you don't
 *  review your own changelist — pin it via the "+" flow to do that). */
export async function listSwarmPendingReviews(paths: string[]): Promise<ListReviewsResult> {
  const now = Date.now();
  let conn: SwarmConn | null;
  try {
    conn = await connFor(paths, now);
  } catch (err) {
    return { ok: false, reason: 'error', error: (err as Error).message };
  }
  // Not configured / not logged in — treated as "nothing here", so it never
  // blanks out GitHub reviews in the merged panel.
  if (!conn) return { ok: false, reason: 'no-repo' };
  try {
    const raw = await listSwarmReviews(conn);
    const reviews = raw.filter((r) => r.author !== conn!.user).map((r) => toReviewItem(r, conn!));
    return { ok: true, reviews };
  } catch (err) {
    if (err instanceof SwarmHttpError && err.status === 401) {
      invalidateConnCache();
      return { ok: false, reason: 'error', error: 'Swarm authentication failed (ticket expired?)' };
    }
    return { ok: false, reason: 'error', error: (err as Error).message };
  }
}

/** One Swarm review by id — the manual "+" pin. No author filter, so you can
 *  pin your own review to review your own code (how Git review was tested). */
export async function getSwarmReviewById(paths: string[], id: number): Promise<GetReviewResult> {
  const conn = await connFor(paths, Date.now()).catch(() => null);
  if (!conn) return { ok: false, reason: 'no-repo' };
  try {
    const r = await getSwarmReview(conn, id);
    if (!r) return { ok: false, reason: 'not-found' };
    return { ok: true, pr: toReviewItem(r, conn) };
  } catch (err) {
    if (err instanceof SwarmHttpError && err.status === 401) invalidateConnCache();
    return { ok: false, reason: 'error', error: (err as Error).message };
  }
}

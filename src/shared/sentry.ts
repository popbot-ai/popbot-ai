/**
 * Sentry settings + DTOs shared between main and renderer.
 *
 * Auth model: a personal auth token from sentry.io → User Settings →
 * Auth Tokens (scopes: `event:read project:read org:read`). Stored in
 * the same `settings` table as Linear / Git config. Never leaves the
 * user's machine — only main makes the outbound HTTPS call.
 */

export interface SentrySettings {
  enabled?: boolean;
  /** Personal auth token. */
  authToken?: string;
  /** Org slug (e.g. "my-org"). */
  orgSlug?: string;
  /** Optional project slug — when set, polling is scoped to one
   *  project; when blank, all projects in the org. */
  projectSlug?: string;
  /** Override the 5min default. Capped to [60, 3600] in the poller. */
  pollIntervalMs?: number;
}

export interface SentryIssueDto {
  id: string;
  shortId: string;            // e.g. "POP-1A"
  title: string;
  culprit: string;
  permalink: string;
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' | 'sample';
  status: string;             // 'unresolved' | 'resolved' | 'ignored'
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  project: { id: string; slug: string; name: string };
}

export type SentryTestResult =
  | { ok: true; orgSlug: string; org: string }
  | { ok: false; reason: 'auth' | 'no-org' | 'network' | 'other'; error?: string };

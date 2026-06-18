/**
 * Slack settings + DTOs shared between main and renderer.
 *
 * Auth model: a Slack user token (xoxp-...) generated from a personal
 * Slack app installed to the user's workspace. PopBot never proxies
 * messages — only the user's main process makes outbound HTTPS calls
 * with their token.
 *
 * Required scopes on the token:
 *   channels:history, groups:history, im:history, mpim:history,
 *   users:read, search:read
 */

export interface SlackSettings {
  enabled?: boolean;
  /** xoxp-... user token. */
  token?: string;
  /** Override the 60s default. Capped to [30, 600] in the poller. */
  pollIntervalMs?: number;
  /** Last-poll timestamp per workspace (epoch ms). Used so we only
   *  surface mentions/DMs that arrived since the previous tick.
   *  Persisted alongside settings so re-launches don't re-fire. */
  lastPolledAt?: number;
}

export type SlackTestResult =
  | { ok: true; team: string; user: string; userId: string }
  | { ok: false; reason: 'auth' | 'network' | 'other'; error?: string };

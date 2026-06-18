/**
 * Generic notification surface — anything in the app can call
 * `notify(...)` and it'll land in the bell-icon dropdown, fire a
 * toast (when urgency != silent in the renderer), and route to
 * whichever action the user clicks.
 *
 * `kind` is the loose category — drives icon + grouping in the UI.
 * `urgency` controls visual loudness + sound. `actions` is a list
 * of click targets; the action marked `primary` is the default
 * (toast surface shows just the primary button).
 */

/** Visual loudness tier. The renderer plays a soft ding for `med`,
 *  a stronger double-chime for `high`, and stays silent for `low`.
 *  All three show in the dropdown + bell badge. */
export type NotificationUrgency = 'high' | 'med' | 'low';

/** Avatar/identity of whoever (or whatever) triggered the notification.
 *  Optional — system notifications often don't have a meaningful actor. */
export interface NotificationActor {
  name: string;
  /** 1-3 character display token, usually initials. */
  avatar: string;
  /** Hex color for the avatar tile background. */
  color: string;
  /** True when the sender matched the user's VIP list — surface a
   *  "VIP" chip in the dropdown + toast so it's immediately visible
   *  why this notification got bumped to urgent. */
  isVip?: boolean;
}

/** Polymorphic click action. The dropdown shows them all; the toast
 *  shows just the one with `primary: true` (or first if none). */
export type NotificationAction =
  | { kind: 'internal'; label: string; targetKind: string; targetId: string; primary?: boolean }
  | { kind: 'external'; label: string; url: string; primary?: boolean }
  | { kind: 'spawn';    label: string; ticketId?: string; pr?: number; primary?: boolean }
  | { kind: 'dismiss';  label: string };

export interface NotificationRecord {
  id: string;
  /** Loose category — 'review' / 'ticket' / 'slack' / 'sentry' / 'system'. */
  kind: string;
  urgency: NotificationUrgency;
  /** Where the notification came from, in display form: e.g.
   *  "GitHub", "Linear", "Sentry", "Slack · #server-android", "PopBot". */
  source: string;
  title: string;
  /** Optional second line — typically the related entity name
   *  (PR title, ticket title). Keep short. */
  subtitle: string;
  /** Free-form longer body. Renderer clamps to ~3 lines with ellipsis. */
  summary: string;
  actor: NotificationActor | null;
  actions: NotificationAction[];
  createdAt: number;
  readAt: number | null;
}

export interface NotifyInput {
  kind: string;
  urgency?: NotificationUrgency;
  source?: string;
  title: string;
  subtitle?: string;
  summary?: string;
  actor?: NotificationActor;
  actions?: NotificationAction[];
  /** When set, suppress this notification if one with the same
   *  dedupKey was created in the last `dedupWindowMs` (default 1h). */
  dedupKey?: string;
  dedupWindowMs?: number;
}

/** Stable string key for dedup when the caller doesn't pass one. */
export function defaultDedupKey(input: NotifyInput): string {
  if (input.dedupKey) return input.dedupKey;
  const primary = input.actions?.find((a) => 'primary' in a && a.primary) ?? input.actions?.[0];
  if (primary && primary.kind === 'internal') return `${input.kind}:int:${primary.targetKind}:${primary.targetId}`;
  if (primary && primary.kind === 'external') return `${input.kind}:url:${primary.url}`;
  return `${input.kind}:${input.title}`;
}

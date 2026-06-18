/**
 * Sentry issue poller. Same shape as the GitHub release update-check:
 * one boot delay, then a periodic interval that diffs against the
 * previous tick's issue ids and dispatches a notification per new one.
 *
 * No notification on first load — the initial poll establishes a
 * baseline silently so we don't dump every existing unresolved issue
 * on the user when they first turn on Sentry.
 */
import { fetchRecentIssues, SentryAuthError } from './client';
import { notify } from '../notifications/dispatcher';
import { getSetting } from '../persistence/settings';
import { dlog } from '../diagLog';
import type { NotificationUrgency } from '@shared/notifications';
import type { SentryIssueDto, SentrySettings } from '@shared/sentry';

const STARTUP_DELAY_MS = 30 * 1000;
const DEFAULT_POLL_MS = 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let knownIds: Set<string> | null = null;

function urgencyFor(level: SentryIssueDto['level']): NotificationUrgency | null {
  if (level === 'fatal') return 'high';
  if (level === 'error') return 'med';
  if (level === 'warning') return 'low';
  return null; // info / debug / sample — not surfaced as notifications
}

async function checkOnce(): Promise<void> {
  const s = getSetting<SentrySettings>('sentry');
  if (!s?.enabled || !s.authToken || !s.orgSlug) return;
  let issues: SentryIssueDto[] = [];
  try {
    issues = await fetchRecentIssues({
      token: s.authToken,
      orgSlug: s.orgSlug,
      projectSlug: s.projectSlug,
    });
  } catch (err) {
    dlog('sentry.fetch.failed', {
      auth: err instanceof SentryAuthError,
      error: (err as Error).message,
    });
    return;
  }
  const ids = new Set(issues.map((i) => i.id));
  const prev = knownIds;
  knownIds = ids;
  if (!prev) {
    dlog('sentry.baseline', { count: ids.size });
    return;
  }
  const fresh = issues.filter((i) => !prev.has(i.id));
  if (fresh.length === 0) return;
  dlog('sentry.fresh', { count: fresh.length });
  for (const issue of fresh) {
    const urgency = urgencyFor(issue.level);
    if (!urgency) continue;
    notify({
      kind: 'sentry',
      urgency,
      source: `Sentry · ${issue.project.slug}`,
      title: issue.title,
      subtitle: issue.shortId,
      summary: issue.culprit
        ? `${issue.culprit} · ${issue.userCount} user${issue.userCount === 1 ? '' : 's'} affected`
        : `${issue.userCount} user${issue.userCount === 1 ? '' : 's'} affected`,
      actor: { name: issue.project.name, avatar: 'SE', color: '#9b51e0' },
      actions: [
        { kind: 'external', label: 'Open in Sentry', url: issue.permalink, primary: true },
      ],
      dedupKey: `sentry:${issue.id}`,
    });
  }
}

export function startSentryPoller(): void {
  // Gating moved into checkOnce() — `enabled: false` (or missing
  // token/orgSlug) will skip the actual fetch, so the timer can run
  // safely in dev too. Only configured users hit Sentry's rate limits.
  const intervalMs = Math.max(60_000, Math.min(
    getSetting<SentrySettings>('sentry')?.pollIntervalMs ?? DEFAULT_POLL_MS,
    60 * 60_000,
  ));
  startupTimer = setTimeout(() => { void checkOnce(); }, STARTUP_DELAY_MS);
  timer = setInterval(() => { void checkOnce(); }, intervalMs);
  dlog('sentry.poller.start', { intervalMs });
}

export function stopSentryPoller(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

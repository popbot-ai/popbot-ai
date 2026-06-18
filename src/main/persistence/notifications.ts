import { randomUUID } from 'node:crypto';
import { db } from './db';
import type {
  NotificationAction,
  NotificationActor,
  NotificationRecord,
  NotificationUrgency,
} from '@shared/notifications';

interface Row {
  id: string;
  kind: string;
  // v7 legacy columns — retained so old rows keep reading; new writes
  // populate the v8 columns instead.
  priority: string;
  detail: string;
  goto: string;
  // v8 columns
  urgency: string | null;
  source: string | null;
  subtitle: string | null;
  summary: string | null;
  actor: string | null;
  actions: string | null;
  // common
  title: string;
  dedup_key: string;
  created_at: number;
  read_at: number | null;
}

const VALID_URGENCIES: NotificationUrgency[] = ['high', 'med', 'low'];

function parseUrgency(s: string | null, legacyPriority: string): NotificationUrgency {
  if (s && (VALID_URGENCIES as string[]).includes(s)) return s as NotificationUrgency;
  // Map legacy priority → urgency: silent/info → low, normal → med, urgent → high.
  if (legacyPriority === 'urgent') return 'high';
  if (legacyPriority === 'normal') return 'med';
  return 'low';
}

function safeJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function rowToRecord(r: Row): NotificationRecord {
  // Build actions[]: prefer the new column, but fall back to deriving
  // a single action from the legacy `goto` field so v7 rows still
  // render correctly with one button.
  let actions = safeJson<NotificationAction[]>(r.actions, []);
  if (actions.length === 0 && r.goto && r.goto !== '{"type":"none"}') {
    const goto = safeJson<{ type: string; url?: string; targetKind?: string; targetId?: string }>(r.goto, { type: 'none' });
    if (goto.type === 'external' && goto.url) {
      actions = [{ kind: 'external', label: 'Open', url: goto.url, primary: true }];
    } else if (goto.type === 'internal' && goto.targetKind && goto.targetId) {
      actions = [{ kind: 'internal', label: 'Open', targetKind: goto.targetKind, targetId: goto.targetId, primary: true }];
    }
  }
  return {
    id: r.id,
    kind: r.kind,
    urgency: parseUrgency(r.urgency, r.priority),
    source: r.source ?? '',
    title: r.title,
    subtitle: r.subtitle ?? '',
    // Old rows used `detail`; new rows use `summary`. Prefer summary
    // when present; otherwise show whatever was in detail.
    summary: (r.summary && r.summary.length > 0) ? r.summary : (r.detail ?? ''),
    actor: safeJson<NotificationActor | null>(r.actor, null),
    actions,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

export interface InsertNotificationArgs {
  kind: string;
  urgency: NotificationUrgency;
  source: string;
  title: string;
  subtitle: string;
  summary: string;
  actor: NotificationActor | null;
  actions: NotificationAction[];
  dedupKey: string;
}

export function insertNotification(args: InsertNotificationArgs): NotificationRecord {
  const id = randomUUID();
  const now = Date.now();
  // We still write the v7 columns so old code paths reading them stay
  // sane: priority is mapped from urgency, detail mirrors summary,
  // goto mirrors the primary action.
  const legacyPriority = args.urgency === 'high' ? 'urgent' : args.urgency === 'med' ? 'normal' : 'info';
  const primary = args.actions.find((a) => 'primary' in a && a.primary) ?? args.actions[0];
  let legacyGoto: object = { type: 'none' };
  if (primary?.kind === 'external') legacyGoto = { type: 'external', url: primary.url };
  else if (primary?.kind === 'internal') legacyGoto = { type: 'internal', targetKind: primary.targetKind, targetId: primary.targetId };
  db().prepare(
    `INSERT INTO notifications
       (id, kind, priority, title, detail, goto, dedup_key, created_at, read_at,
        urgency, source, subtitle, summary, actor, actions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, args.kind, legacyPriority, args.title, args.summary, JSON.stringify(legacyGoto),
    args.dedupKey, now,
    args.urgency, args.source, args.subtitle, args.summary,
    args.actor ? JSON.stringify(args.actor) : null,
    JSON.stringify(args.actions),
  );
  return {
    id,
    kind: args.kind,
    urgency: args.urgency,
    source: args.source,
    title: args.title,
    subtitle: args.subtitle,
    summary: args.summary,
    actor: args.actor,
    actions: args.actions,
    createdAt: now,
    readAt: null,
  };
}

export function hasRecentDedup(dedupKey: string, windowMs: number, now: number = Date.now()): boolean {
  const cutoff = now - windowMs;
  const row = db().prepare<[string, number]>(
    `SELECT 1 FROM notifications WHERE dedup_key = ? AND created_at >= ? LIMIT 1`,
  ).get(dedupKey, cutoff);
  return row !== undefined;
}

export function listNotifications(limit = 50): NotificationRecord[] {
  const rows = db().prepare<[number]>(
    `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as Row[];
  return rows.map(rowToRecord);
}

export function unreadCount(): number {
  const r = db().prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL`,
  ).get() as { n: number };
  return r.n;
}

export function markAllRead(): void {
  db().prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`).run(Date.now());
}

/** Hard-delete every notification row. Backs the "Clear all" button
 *  in the bell dropdown — that button used to only mark-as-read,
 *  which left items visible and made the dropdown grow forever. */
export function deleteAllNotifications(): void {
  db().prepare(`DELETE FROM notifications`).run();
}

export function markRead(id: string): void {
  db().prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`)
    .run(Date.now(), id);
}

export function pruneOlderThan(cutoffMs: number): number {
  const r = db().prepare<[number]>(
    `DELETE FROM notifications WHERE created_at < ?`,
  ).run(cutoffMs);
  return r.changes;
}

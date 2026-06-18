/**
 * Slack poller — surfaces unread DMs and channel mentions as PopBot
 * notifications. Runs every ~60s when configured + enabled.
 *
 * Per-tick work:
 *   1. listDmChannels() → for each, channelInfo() → if unread, fetch
 *      messages newer than last_read; emit one notification per sender.
 *   2. searchMentions() → for messages mentioning the user since last
 *      poll; emit one notification per match.
 *
 * Persists `lastPolledAt` between ticks so we don't re-fire on
 * messages we already saw.
 */
import {
  authTest,
  channelHistory,
  channelInfo,
  listDmChannels,
  messagePermalink,
  searchMentions,
  SlackAuthError,
  userName,
  type SlackMessage,
} from './client';
import { notify } from '../notifications/dispatcher';
import { classify } from '../notifications/classify';
import { getSetting, setSetting } from '../persistence/settings';
import { dlog } from '../diagLog';
import type { NotificationUrgency } from '@shared/notifications';
import type { SlackSettings } from '@shared/slack';

interface NotificationsSettings {
  vips?: string[];
}

function getVips(): string[] {
  return getSetting<NotificationsSettings>('notifications')?.vips ?? [];
}

const STARTUP_DELAY_MS = 12 * 1000;
const DEFAULT_POLL_MS = 60_000;
const PER_TICK_DM_CAP = 5;     // surface at most 5 new DM messages per tick
const PER_TICK_MENTION_CAP = 5;

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
/** Cached identity (user_id, team) so we don't auth.test on every tick. */
let identity: { userId: string; team: string } | null = null;

function snippet(text: string, max = 220): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Combine the classifier's `prioritySuggestion` with the message-source
 *  default. DMs default 'high' but a casual one ("lunch?") should be
 *  quiet; mentions default 'med' but a bug/error mention should ding
 *  urgently. The strongest of the two wins. */
function blendUrgency(defaultLevel: NotificationUrgency, suggestion: 'silent' | 'info' | 'normal' | 'urgent' | undefined): NotificationUrgency {
  // Numeric rank to compare easily.
  const rank: Record<NotificationUrgency, number> = { low: 0, med: 1, high: 2 };
  const sugRank: Record<string, NotificationUrgency> = {
    silent: 'low', info: 'low', normal: 'med', urgent: 'high',
  };
  const sug = suggestion ? sugRank[suggestion] : defaultLevel;
  return rank[sug] >= rank[defaultLevel] ? sug : defaultLevel;
}

async function checkOnce(): Promise<void> {
  const s = getSetting<SlackSettings>('slack');
  if (!s?.enabled || !s.token) return;
  const token = s.token;

  // Cache identity across ticks; refresh on auth error.
  if (!identity) {
    try {
      const a = await authTest(token);
      identity = { userId: a.user_id, team: a.team };
    } catch (err) {
      dlog('slack.auth.failed', {
        auth: err instanceof SlackAuthError, error: (err as Error).message,
      });
      return;
    }
  }

  const sinceMs = s.lastPolledAt ?? Date.now() - 5 * 60_000;
  const now = Date.now();

  // ---- DMs ------------------------------------------------------------
  const dmEvents: Array<{ channel: string; msg: SlackMessage }> = [];
  try {
    const channels = await listDmChannels(token);
    for (const ch of channels) {
      try {
        const info = await channelInfo(token, ch.id);
        if (!info.unread_count_display || info.unread_count_display <= 0) continue;
        const oldest = info.last_read ?? `${Math.floor(sinceMs / 1000)}.000000`;
        const msgs = await channelHistory(token, ch.id, oldest, 5);
        for (const m of msgs) {
          if (m.type !== 'message') continue;
          if (m.user === identity.userId) continue; // don't notify on own messages
          dmEvents.push({ channel: ch.id, msg: m });
        }
      } catch (err) {
        dlog('slack.dm.channel-failed', { channel: ch.id, error: (err as Error).message });
      }
    }
  } catch (err) {
    dlog('slack.dm.list-failed', { error: (err as Error).message });
  }

  // ---- Mentions -------------------------------------------------------
  let mentionEvents: Awaited<ReturnType<typeof searchMentions>> = [];
  try {
    const all = await searchMentions(token, identity.userId, sinceMs);
    mentionEvents = all
      .filter((m) => Number(m.ts) * 1000 > sinceMs)
      .filter((m) => m.user !== identity!.userId);
  } catch (err) {
    dlog('slack.mentions.failed', {
      auth: err instanceof SlackAuthError, error: (err as Error).message,
    });
    if (err instanceof SlackAuthError) identity = null; // force re-auth next tick
  }

  // ---- Dispatch -------------------------------------------------------
  dlog('slack.tick', { dmCount: dmEvents.length, mentionCount: mentionEvents.length });

  const vips = getVips();

  for (const ev of dmEvents.slice(-PER_TICK_DM_CAP)) {
    const sender = ev.msg.user ? await userName(token, ev.msg.user) : 'Slack';
    const initials = sender.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || 'SL';
    const permalink = await messagePermalink(token, ev.channel, ev.msg.ts);
    // Heuristic classifier reads the message text + sender + VIP list.
    // VIPs always urgent. Otherwise category-based bump/downshift from
    // the DM default ('high').
    const c = classify(ev.msg.text, { senderName: sender, vips });
    notify({
      kind: 'slack',
      urgency: blendUrgency('high', c.prioritySuggestion),
      source: 'Slack · DM',
      title: `${sender} sent you a DM`,
      summary: snippet(ev.msg.text),
      actor: { name: sender, avatar: initials, color: '#c89bd3', isVip: c.isVip },
      actions: permalink
        ? [{ kind: 'external', label: 'Open in Slack', url: permalink, primary: true }]
        : [],
      dedupKey: `slack-dm:${ev.channel}:${ev.msg.ts}`,
    });
  }

  for (const ev of mentionEvents.slice(0, PER_TICK_MENTION_CAP)) {
    const sender = ev.user ? await userName(token, ev.user) : (ev.username || 'Slack');
    const initials = sender.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || 'SL';
    const channel = ev.channel.name ? `#${ev.channel.name}` : 'a channel';
    const c = classify(ev.text, { senderName: sender, vips });
    notify({
      kind: 'slack',
      urgency: blendUrgency('med', c.prioritySuggestion),
      source: `Slack · ${channel}`,
      title: `${sender} mentioned you in ${channel}`,
      summary: snippet(ev.text),
      actor: { name: sender, avatar: initials, color: '#7e9cf0', isVip: c.isVip },
      actions: [
        { kind: 'external', label: 'Open in Slack', url: ev.permalink, primary: true },
      ],
      dedupKey: `slack-mention:${ev.permalink}`,
    });
  }

  setSetting('slack', { ...s, lastPolledAt: now });
}

export function startSlackPoller(): void {
  const intervalMs = Math.max(30_000, Math.min(
    getSetting<SlackSettings>('slack')?.pollIntervalMs ?? DEFAULT_POLL_MS,
    10 * 60_000,
  ));
  startupTimer = setTimeout(() => { void checkOnce(); }, STARTUP_DELAY_MS);
  timer = setInterval(() => { void checkOnce(); }, intervalMs);
  dlog('slack.poller.start', { intervalMs });
}

export function stopSlackPoller(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

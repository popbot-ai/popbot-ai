import { useEffect, useRef, useState } from 'react';
import type { NotificationAction, NotificationRecord, NotificationUrgency } from '@shared/notifications';
import type { MessageKey, Translator } from '@shared/i18n';
import { useNotifications } from '../lib/useNotifications';
import { useTranslation } from '../lib/i18n';
import githubIcon from '../assets/notif/github.png';
import linearIcon from '../assets/notif/linear.png';
import jiraIcon from '../assets/notif/jira.png';
import slackIcon from '../assets/notif/slack.png';

const URGENCY_META: Record<NotificationUrgency, { labelKey: MessageKey; color: string; bg: string; border: string; dot: string }> = {
  high: { labelKey: 'notify.urgency.high', color: '#ffffff', bg: 'rgba(239,68,68,0.40)',  border: 'rgba(239,68,68,0.85)',  dot: '#ef4444' },
  med:  { labelKey: 'notify.urgency.med',  color: '#ffffff', bg: 'rgba(245,158,11,0.32)', border: 'rgba(245,158,11,0.75)', dot: '#f59e0b' },
  low:  { labelKey: 'notify.urgency.low',  color: '#cdd9ec', bg: 'rgba(99,102,241,0.20)', border: 'rgba(99,102,241,0.55)', dot: '#6366f1' },
};

/** Per-kind source identity. The avatar tile uses these so you can
 *  tell at-a-glance whether a notification came from GitHub, Linear,
 *  Slack, Sentry, or PopBot itself.
 *
 *  Three of the products ship recognizable logo icons we can display
 *  directly (`img`); the rest use FA glyphs with a tinted tile. */
interface KindMeta { img?: string; icon?: string; bg: string; label: string }

const KIND_META: Record<string, KindMeta> = {
  review:          { img: githubIcon, bg: '#0d1117', label: 'GitHub' },
  ticket:          { img: linearIcon, bg: '#0d1117', label: 'Linear' },
  'linear-issue':  { img: linearIcon, bg: '#0d1117', label: 'Linear' },
  slack:           { img: slackIcon,  bg: '#0d1117', label: 'Slack' },
  sentry:          { icon: 'fa-bug',   bg: '#f85149', label: 'Sentry' },
  system:          { icon: 'fa-robot', bg: '#f0883e', label: 'PopBot' },
  'claude-missing':{ icon: 'fa-robot', bg: '#f0883e', label: 'PopBot' },
};
const KIND_FALLBACK: KindMeta = { icon: 'fa-bell', bg: '#5d6678', label: '' };

/** Ticket notifications share the `ticket`/`linear-issue` kind across providers;
 *  the icon is resolved from the record's `source` (the provider label) so a
 *  Jira/GitHub issue doesn't render with the Linear logo. */
const TICKET_ICON: Record<string, string> = { Linear: linearIcon, Jira: jiraIcon, GitHub: githubIcon };
const isTicketKind = (kind: string): boolean => kind === 'ticket' || kind === 'linear-issue';

const ACTION_ICON: Record<string, string> = {
  internal: 'fa-arrow-right',
  external: 'fa-arrow-up-right-from-square',
  spawn:    'fa-message',
  dismiss:  'fa-check',
};

function relTime(ts: number, t: Translator): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('time.now');
  if (diff < 60 * 60_000) return t('time.minutesShort', { count: Math.floor(diff / 60_000) });
  if (diff < 24 * 60 * 60_000) return t('time.hoursShort', { count: Math.floor(diff / 3_600_000) });
  return t('time.daysShort', { count: Math.floor(diff / 86_400_000) });
}

interface BellProps {
  /** Click handler for any action on any notification. The bell
   *  itself is dumb; routing decisions live in App. */
  onAction: (n: NotificationRecord, a: NotificationAction) => void;
  /** When true (center-fly mode), the bell briefly pulses each time a
   *  new notification is added — a wayfinding signal for the
   *  fly-to-bell exit animation. Off in default top-right mode where
   *  the toast stays in the user's peripheral vision and no pulse is
   *  needed. */
  pulseOnArrival?: boolean;
}

function NotifActionButton({ action, onAct }: {
  action: NotificationAction;
  onAct: (a: NotificationAction) => void;
}): JSX.Element {
  const isPrimary = 'primary' in action && action.primary;
  return (
    <button
      type="button"
      className={`notif-act ${isPrimary ? 'primary' : ''}`}
      onClick={(e) => { e.stopPropagation(); onAct(action); }}
    >
      <span>{action.label}</span>
      <i className={`fa-solid ${ACTION_ICON[action.kind]}`} />
    </button>
  );
}

function NotifItem({ n, onAct }: { n: NotificationRecord; onAct: (a: NotificationAction) => void }): JSX.Element {
  const { t } = useTranslation();
  const u = URGENCY_META[n.urgency];
  const k = KIND_META[n.kind] ?? KIND_FALLBACK;
  // Source label takes the kind's product name when the dispatched
  // record didn't include one (or as a prefix for Sentry's "Sentry ·
  // project" style). Actor is shown inline below to preserve "who".
  const sourceLabel = n.source || k.label;
  const img = isTicketKind(n.kind) ? (TICKET_ICON[n.source] ?? k.img) : k.img;
  return (
    <div className={`notif-item u-${n.urgency} k-${n.kind}`}>
      <div className="notif-rail" style={{ background: u.dot }} />
      <div className="notif-avatar src" style={{ background: k.bg }} title={sourceLabel}>
        {img
          ? <img src={img} alt={sourceLabel} className="notif-avatar-img" />
          : <i className={`fa-solid ${k.icon}`} />
        }
      </div>
      <div className="notif-main">
        <div className="notif-row1">
          {sourceLabel && <span className="notif-source">{sourceLabel}</span>}
          {n.actor && <span className="notif-actor">· {n.actor.name}</span>}
          {n.actor?.isVip && <span className="notif-vip" title={t('notify.vipTitle')}>{t('notify.vip')}</span>}
          <span
            className="notif-urgency"
            style={{ color: u.color, background: u.bg, borderColor: u.border }}
          >
            {t(u.labelKey)}
          </span>
          <span className="notif-spacer" />
          <span className="notif-age">{relTime(n.createdAt, t)}</span>
        </div>
        <div className="notif-title">{n.title}</div>
        {n.subtitle && <div className="notif-subtitle">{n.subtitle}</div>}
        {n.summary && <div className="notif-summary">{n.summary}</div>}
        {n.actions.length > 0 && (
          <div className="notif-actions">
            {n.actions.map((a, i) => (
              <NotifActionButton key={i} action={a} onAct={onAct} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function NotificationsBell({ onAction, pulseOnArrival }: BellProps): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { items, unread, markAllRead, clearAll } = useNotifications(50);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const bellBtnRef = useRef<HTMLButtonElement | null>(null);
  // Tick that bumps each time a new notification lands; the bell
  // listens to onAdded and toggles the .pulse class for ~700ms before
  // clearing it. Only active when the parent enables pulseOnArrival
  // (center-fly toast mode) — in default top-right mode the toast
  // itself is the attention surface and the bell stays still.
  const [pulseTick, setPulseTick] = useState(0);
  useEffect(() => {
    if (!pulseOnArrival) return;
    return window.popbot.notifications.onAdded(() => setPulseTick((n) => n + 1));
  }, [pulseOnArrival]);
  useEffect(() => {
    if (pulseTick === 0) return;
    const btn = bellBtnRef.current;
    if (!btn) return;
    btn.classList.remove('pulse');
    void btn.offsetWidth;
    btn.classList.add('pulse');
    const t = setTimeout(() => btn.classList.remove('pulse'), 720);
    return () => clearTimeout(t);
  }, [pulseTick]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: globalThis.MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClickOutside);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClickOutside);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onToggle = () => {
    setOpen((o) => !o);
    if (!open && unread > 0) void markAllRead();
  };

  const counts = items.reduce<Record<NotificationUrgency, number>>((m, n) => {
    m[n.urgency] = (m[n.urgency] ?? 0) + 1;
    return m;
  }, { high: 0, med: 0, low: 0 });

  return (
    <div className="notif-anchor" ref={wrapRef}>
      <button
        ref={bellBtnRef}
        data-bell-anchor
        className={`notif-bell ${unread > 0 ? 'has-unread' : ''}`}
        onClick={onToggle}
        title={unread > 0
          ? (unread === 1
            ? t('notify.bell.unreadTitle', { count: unread })
            : t('notify.bell.unreadTitlePlural', { count: unread }))
          : t('notify.bell.title')}
        aria-label={t('notify.bell.title')}
      >
        <i className="fa-solid fa-bell" />
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-pop" role="dialog" aria-label={t('notify.head.title')}>
          <div className="notif-pop-arrow" />
          <div className="notif-head">
            <div className="notif-head-title">
              <i className="fa-solid fa-bell" />
              <span>{t('notify.head.title')}</span>
              <span className="notif-count">{items.length}</span>
            </div>
          </div>
          <div className="notif-summary-bar">
            <span className="notif-sum-chip" style={{
              color: URGENCY_META.high.color, background: URGENCY_META.high.bg, borderColor: URGENCY_META.high.border,
            }}>
              <i className="fa-solid fa-circle" /> {t('notify.summary.high', { count: counts.high })}
            </span>
            <span className="notif-sum-chip" style={{
              color: URGENCY_META.med.color, background: URGENCY_META.med.bg, borderColor: URGENCY_META.med.border,
            }}>
              <i className="fa-solid fa-circle" /> {t('notify.summary.med', { count: counts.med })}
            </span>
            <span className="notif-sum-chip" style={{
              color: URGENCY_META.low.color, background: URGENCY_META.low.bg, borderColor: URGENCY_META.low.border,
            }}>
              <i className="fa-solid fa-circle" /> {t('notify.summary.low', { count: counts.low })}
            </span>
            <span className="notif-spacer" />
            {/* Auto-mark-as-read fires when the dropdown opens; this
                button's job is to clear the list itself, which the
                user expected from "Mark all Read" but wasn't happening. */}
            <button
              className="notif-mark-all"
              onClick={() => void clearAll()}
              disabled={items.length === 0}
            >
              {t('notify.clearAll')}
            </button>
          </div>
          <div className="notif-list">
            {items.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 12 }}>
                {t('notify.empty')}
              </div>
            ) : items.map((n) => (
              <NotifItem
                key={n.id}
                n={n}
                onAct={(a) => { onAction(n, a); if (a.kind !== 'dismiss') setOpen(false); }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { NotificationAction, NotificationRecord, NotificationUrgency } from '@shared/notifications';
import type { MessageKey } from '@shared/i18n';
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

/** Ticket notifications share one kind across providers; resolve the icon from
 *  the record's `source` (provider label) so Jira/GitHub issues don't show the
 *  Linear logo. */
const TICKET_ICON: Record<string, string> = { Linear: linearIcon, Jira: jiraIcon, GitHub: githubIcon };
const isTicketKind = (kind: string): boolean => kind === 'ticket' || kind === 'linear-issue';

interface ToastProps {
  notification: NotificationRecord;
  onAction: (a: NotificationAction) => void;
  onDismiss: (id: string) => void;
  /** When true, leaving toasts shrink toward the bell icon instead of
   *  sliding off the right edge. The toast measures its own and the
   *  bell's positions to compute the delta. */
  centerFly?: boolean;
}

function NotificationToastItem({ notification: n, onAction, onDismiss, centerFly }: ToastProps): JSX.Element {
  const { t } = useTranslation();
  const u = URGENCY_META[n.urgency];
  const k = KIND_META[n.kind] ?? KIND_FALLBACK;
  const sourceLabel = n.source || k.label;
  const img = isTicketKind(n.kind) ? (TICKET_ICON[n.source] ?? k.img) : k.img;
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // High-urgency toasts linger longer so the user has time to act.
    const ttl = n.urgency === 'high' ? 9000 : 6500;
    const t = setTimeout(() => setLeaving(true), ttl);
    return () => clearTimeout(t);
  }, [n.urgency]);

  // Fly-to-bell: just before the leaving class lands, measure where
  // this toast is and where the bell is, write the delta as CSS vars
  // so the keyframe ends at the bell's actual location regardless of
  // window width. Falls back to the keyframe defaults if the bell
  // isn't mounted (titlebar hidden, etc.). Slide-out duration matches
  // the .leaving CSS — see prototype.css `toast-fly-to-bell` and
  // `toast-out` keyframes.
  const dismissDurationMs = centerFly ? 420 : 280;
  useEffect(() => {
    if (!leaving) return;
    if (centerFly) {
      const root = rootRef.current;
      const bell = document.querySelector<HTMLElement>('[data-bell-anchor]');
      if (root && bell) {
        const r = root.getBoundingClientRect();
        const b = bell.getBoundingClientRect();
        const dx = (b.left + b.width / 2) - (r.left + r.width / 2);
        const dy = (b.top + b.height / 2) - (r.top + r.height / 2);
        root.style.setProperty('--shrink-tx', `${dx}px`);
        root.style.setProperty('--shrink-ty', `${dy}px`);
      }
    }
    const t = setTimeout(() => onDismiss(n.id), dismissDurationMs);
    return () => clearTimeout(t);
  }, [leaving, n.id, onDismiss, centerFly, dismissDurationMs]);

  const primary = n.actions.find((a) => 'primary' in a && a.primary) ?? n.actions[0];

  return (
    <div ref={rootRef} className={`toast u-${n.urgency} k-${n.kind} ${leaving ? 'leaving' : ''}`}>
      <div className="toast-rail" style={{ background: u.dot }} />
      <div className="toast-avatar src" style={{ background: k.bg }} title={sourceLabel}>
        {img
          ? <img src={img} alt={sourceLabel} className="notif-avatar-img" />
          : <i className={`fa-solid ${k.icon}`} />
        }
      </div>
      <div className="toast-main">
        <div className="toast-row1">
          {sourceLabel && <span className="toast-source">{sourceLabel}</span>}
          {n.actor && <span className="notif-actor">· {n.actor.name}</span>}
          {n.actor?.isVip && <span className="notif-vip" title={t('notify.vip')}>{t('notify.vip')}</span>}
          <span className="toast-urgency" style={{ color: u.color, background: u.bg, borderColor: u.border }}>
            {t(u.labelKey)}
          </span>
          <span className="notif-spacer" />
          <button
            className="toast-x"
            onClick={() => setLeaving(true)}
            title={t('common.dismiss')}
            aria-label={t('common.dismiss')}
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="toast-title">{n.title}</div>
        {n.subtitle && <div className="toast-subtitle">{n.subtitle}</div>}
        {primary && (
          <div className="toast-actions">
            <button
              className="notif-act primary"
              onClick={() => { onAction(primary); setLeaving(true); }}
            >
              <span>{primary.label}</span>
              <i className="fa-solid fa-arrow-right" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface StackProps {
  toasts: NotificationRecord[];
  onAction: (n: NotificationRecord, a: NotificationAction) => void;
  onDismiss: (id: string) => void;
  /** Opt-in: top-center placement + fly-to-bell exit animation.
   *  Off by default; enabled via Preferences > Notifications. */
  centerFly?: boolean;
}

export function NotificationToastStack({ toasts, onAction, onDismiss, centerFly }: StackProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className={`toast-stack ${centerFly ? 'center-fly' : ''}`} role="region" aria-label={t('notify.toast.stackAria')}>
      {toasts.map((n) => (
        <NotificationToastItem
          key={n.id}
          notification={n}
          onAction={(a) => onAction(n, a)}
          onDismiss={onDismiss}
          centerFly={centerFly}
        />
      ))}
    </div>
  );
}

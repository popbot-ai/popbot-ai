import type { NotificationAction, NotificationRecord } from '@shared/notifications';
import { NotificationsBell } from './NotificationsBell';

interface TitlebarProps {
  onOpenModal: (kind: string) => void;
  onOpenPrefs: () => void;
  /** True when at least one chat has detected branch/server drift —
   *  surfaces the warning chip in the title bar. */
  driftActive?: boolean;
  /** True when an agent is blocked waiting for capacity (e.g. needs a
   *  Unity instance over the configured cap). */
  dialupActive?: boolean;
  /** Current open/closed state of the right git sidebar. */
  gitPanelOpen?: boolean;
  onToggleGitPanel?: () => void;
  /** Fired when the user clicks any action on a notification in the
   *  bell dropdown. App-level routes the action (open URL, spawn chat,
   *  etc.). */
  onNotificationAction?: (n: NotificationRecord, a: NotificationAction) => void;
  /** True when the user has opted into the top-center toast layout —
   *  flips on the bell-pulse-on-arrival animation and hands the bell
   *  a stable anchor attribute so toasts can target its position. */
  centerFly?: boolean;
}

export function Titlebar({
  onOpenModal,
  onOpenPrefs,
  driftActive,
  dialupActive,
  gitPanelOpen,
  onToggleGitPanel,
  onNotificationAction,
  centerFly,
}: TitlebarProps): JSX.Element {
  return (
    <div className="titlebar">
      {/* Left cell intentionally empty — macOS draws its native traffic
          light controls here (titleBarStyle: 'hiddenInset'). */}
      <div />
      <div className="title">
        <b>POPBOT</b>
      </div>
      <div className="right">
        {driftActive && (
          <button
            className="notify-err"
            title="Drift detected"
            onClick={() => onOpenModal('drift')}
          >
            <i className="fa-solid fa-triangle-exclamation" />
          </button>
        )}
        {dialupActive && (
          <button
            className="notify-warn"
            title="Capacity needed"
            onClick={() => onOpenModal('dialup')}
          >
            <i className="fa-solid fa-arrow-up-right-from-square" />
          </button>
        )}
        <NotificationsBell
          onAction={onNotificationAction ?? (() => undefined)}
          pulseOnArrival={centerFly ?? false}
        />
        {onToggleGitPanel && (
          <button
            title={gitPanelOpen ? 'Hide git panel' : 'Show git panel'}
            onClick={onToggleGitPanel}
            className={gitPanelOpen ? 'titlebar-btn-active' : ''}
          >
            <i className="fa-solid fa-code-branch" />
          </button>
        )}
        <button title="Preferences ⌘," onClick={onOpenPrefs}>
          <i className="fa-solid fa-gear" />
        </button>
      </div>
    </div>
  );
}

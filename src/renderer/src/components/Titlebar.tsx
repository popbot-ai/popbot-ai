import { useEffect, useState } from 'react';
import type { NotificationAction, NotificationRecord } from '@shared/notifications';
import { NotificationsBell } from './NotificationsBell';
import { MenuBar } from './MenuBar';
import { hotkey } from '../lib/hotkeys';

/**
 * Custom window controls (minimize / maximize-restore / close) drawn by
 * the app. Used on Linux, where we run fully frameless (`titleBarOverlay`
 * isn't reliable across WMs/WSLg). Generic glyphs in the VS-Code / Slack
 * style — consistent across distros rather than per-WM native. Windows
 * uses the OS overlay buttons; macOS uses traffic lights.
 */
function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    void window.popbot.win.action('is-maximized').then((m) => setMaximized(!!m));
    return window.popbot.win.onMaximizeChange(setMaximized);
  }, []);
  return (
    <div className="win-controls">
      <button className="win-ctl" title="Minimize" onClick={() => void window.popbot.win.action('minimize')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><rect x="0" y="4.5" width="10" height="1" fill="currentColor" /></svg>
      </button>
      <button className="win-ctl" title={maximized ? 'Restore' : 'Maximize'} onClick={() => void window.popbot.win.action('maximize-toggle')}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M2.5 2.5 V0.5 H8.5 V6.5 H6.5" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
        )}
      </button>
      <button className="win-ctl win-ctl-close" title="Close" onClick={() => void window.popbot.win.action('close')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" stroke="currentColor" strokeWidth="1.1" /></svg>
      </button>
    </div>
  );
}

interface TitlebarProps {
  onOpenModal: (kind: string) => void;
  onOpenPrefs: () => void;
  /** Start a new chat — surfaced in the Windows menu bar (File ▸ New Chat). */
  onNewChat?: () => void;
  /** Open the About dialog (menu bar Help ▸ About PopBot). */
  onOpenAbout?: () => void;
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
  onNewChat,
  onOpenAbout,
  driftActive,
  dialupActive,
  gitPanelOpen,
  onToggleGitPanel,
  onNotificationAction,
  centerFly,
}: TitlebarProps): JSX.Element {
  // Windows AND Linux draw our custom in-app menu bar (both run frameless
  // with the native menu hidden). macOS keeps its system menu bar +
  // traffic lights. Linux additionally needs app-drawn window controls
  // (no native overlay); Windows gets them from the OS overlay.
  const isMac = window.popbot.platform === 'darwin';
  const isLinux = window.popbot.platform === 'linux';

  // Shared right-hand app buttons (drift / capacity / bell / git / prefs).
  const rightButtons = (
    <div className="right">
      {driftActive && (
        <button className="notify-err" title="Drift detected" onClick={() => onOpenModal('drift')}>
          <i className="fa-solid fa-triangle-exclamation" />
        </button>
      )}
      {dialupActive && (
        <button className="notify-warn" title="Capacity needed" onClick={() => onOpenModal('dialup')}>
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
      <button title={`Preferences ${hotkey(',')}`} onClick={onOpenPrefs}>
        <i className="fa-solid fa-gear" />
      </button>
    </div>
  );

  // macOS: native traffic lights on the left + system menu bar at the top
  // of the screen — empty left cell, centered title, right buttons.
  if (isMac) {
    return (
      <div className="titlebar">
        <div />
        <div className="title"><b>POPBOT</b></div>
        {rightButtons}
      </div>
    );
  }

  // Windows + Linux: frameless, so we draw the full menu bar on the left
  // (app icon → system menu), a draggable spacer, then the app buttons.
  // Windows gets its min/max/close from the OS overlay (the spacer reserves
  // room for them); Linux has no overlay, so we draw our own controls.
  return (
    <div className="titlebar titlebar-custom">
      <MenuBar
        onNewChat={onNewChat}
        onOpenPrefs={onOpenPrefs}
        onToggleGitPanel={onToggleGitPanel}
        gitPanelOpen={gitPanelOpen}
        onOpenAbout={onOpenAbout}
      />
      <div className="titlebar-drag" />
      {rightButtons}
      {isLinux && <WindowControls />}
    </div>
  );
}

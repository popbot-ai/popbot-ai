import { app, BrowserWindow, Menu, ipcMain, screen, shell, type Rectangle } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { dlog } from './diagLog';
import { IpcChannel } from '@shared/ipc';
import { createTranslator, LOCALE_SETTING_KEY, resolveLocale } from '@shared/i18n';
import { fixShellPath } from './env';
import { initDb, closeDb, isDbOpen } from './persistence/db';
import { importExistingJsonlsIfNeeded } from './agents/sqliteSessionStoreImport';
import { backfillAllChats } from './persistence/chatBackfill';
import { migrateSdkProjectDirs } from './agents/sdkProjectDirMigrate';
import { recoverChatSessions } from './agents/chatRecover';
import { seedDefaultRepoFromSettings } from './persistence/repoSeed';

// Patch PATH from the user's login shell so packaged builds can find
// Homebrew tools (gh, etc). Must run before anything else.
fixShellPath();

// Force the app name to "PopBot" everywhere — without this, app.name
// falls back to package.json `name` ("popbot" lowercase) in dev or
// "Electron" if even that isn't set, which leaks into the macOS app
// menu's first item.
app.setName('PopBot');

// Linux graphics init (must run before the app `ready` event).
if (process.platform === 'linux') {
  // Let Electron pick the right windowing backend instead of forcing
  // X11: `auto` uses native Wayland when WAYLAND_DISPLAY is set, else
  // X11. This is Electron's recommended cross-desktop default — X11
  // desktops keep working, Wayland desktops (GNOME/KDE/Sway) go native,
  // and it fixes WSLg, where the default XWayland path frequently fails
  // to present a frame (blank window / "nothing shows").
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

  // The rest is genuinely WSL-specific — real distros have a working GPU
  // and their own DE scaling, so we don't touch those.
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    // WSLg doesn't forward the Windows display scale (default 1.25 /
    // 125%; override with POPBOT_SCALE).
    app.commandLine.appendSwitch('force-device-scale-factor', process.env.POPBOT_SCALE || '1.25');
    // WSLg's GL can be flaky with hardware compositing; allow forcing
    // software rendering as an escape hatch (POPBOT_SOFTWARE_GL=1) without
    // making it the default — modern WSLg has working GPU passthrough.
    if (process.env.POPBOT_SOFTWARE_GL === '1') app.disableHardwareAcceleration();
  }
}
import { clearStaleRunningStatuses } from './persistence/chats';
import { getSetting, setSetting } from './persistence/settings';
import { AgentHost } from './agents/AgentHost';
import { probeClaudeAndNotify } from './agents/claudeProbe';
import { probeCodexForPath } from './agents/codexProbe';
import { registerChatHandlers } from './ipc/chats';
import { registerAgentHandlers } from './ipc/agent';
import { registerSettingsHandlers } from './ipc/settings';
import { registerLinearHandlers } from './ipc/linear';
import { registerFilesHandlers } from './ipc/files';
import { registerAppsHandlers } from './ipc/apps';
import { registerGitHandlers } from './ipc/git';
import { registerReviewsHandlers } from './ipc/reviews';
import { registerReposHandlers } from './ipc/repos';
import { registerTermHandlers } from './ipc/term';
import { registerNotificationsHandlers } from './ipc/notifications';
import { registerSentryHandlers } from './ipc/sentry';
import { startSentryPoller, stopSentryPoller } from './sentry/poll';
import { registerSlackHandlers } from './ipc/slack';
import { startSlackPoller, stopSlackPoller } from './slack/poll';
import { pruneOlderThan } from './persistence/notifications';
import { attachWebContents as attachTermWindow, disposeAll as disposeAllPtys } from './term/ptyManager';
import { checkForUpdates } from './updates/check';
import { startAutoUpdater, stopAutoUpdater, quitAndInstallUpdate } from './updates/autoUpdate';

const isDev = !app.isPackaged;

/**
 * Open a URL in the user's preferred browser. By default macOS routes
 * to whichever Chrome window grabbed focus most recently — which on a
 * machine with both personal and work Chrome profiles open means URLs
 * randomly land in the wrong account.
 *
 * If `apps.browserChromeProfile` is set to a Chrome profile directory
 * name (e.g. "Profile 1", "Default", "Person 2"), we launch the URL
 * via `open -a "Google Chrome" --args --profile-directory=...`. This
 * pins URLs to a specific Chrome profile regardless of which window
 * was foreground. Falls back to the OS default browser when unset.
 *
 * macOS-only — on other platforms we always fall back to shell.openExternal.
 */
async function openUrlInPreferredBrowser(url: string): Promise<void> {
  if (process.platform !== 'darwin') {
    await shell.openExternal(url);
    return;
  }
  const apps = getSetting<{ browserChromeProfile?: string }>('apps');
  const profile = apps?.browserChromeProfile?.trim();
  if (!profile) {
    await shell.openExternal(url);
    return;
  }
  try {
    // Invoke the Chrome binary directly rather than via `open --args`.
    // `open` sends an Apple Event to a running Chrome and silently
    // drops `--args` — meaning the URL lands in whatever profile is
    // currently foreground, not the one we asked for. Talking to the
    // binary directly makes `--profile-directory` always honored:
    // Chrome opens a new tab in the named profile's window (or
    // launches that profile if it isn't running).
    await new Promise<void>((resolve, reject) => {
      execFile(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        [`--profile-directory=${profile}`, url],
        (err) => (err ? reject(err) : resolve()),
      );
    });
  } catch (err) {
    // Chrome not installed, profile name invalid, or invocation
    // failed — fall back rather than silently swallowing the URL.
    dlog('browser.profile-open.failed', {
      profile,
      error: (err as Error).message,
    });
    await shell.openExternal(url);
  }
}

/** App icon source. Resolved relative to the project root in dev so the
 *  Dock shows the real icon during `npm run dev`. We use the .icns
 *  (not the raw .png) because macOS only applies its rounded-squircle
 *  mask to .icns files passed to `app.dock.setIcon`; PNGs render as
 *  raw bitmaps. In a packaged build, electron-builder bundles
 *  `build/icon.icns` directly into the .app and this path is unused. */
const ICON_PATH = join(__dirname, '../../build/icon.icns');

interface SavedWindowState {
  bounds?: Rectangle;
  maximized?: boolean;
}

const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 1440, height: 900 };

/** Last-known size + position from settings, only if it's still
 *  visible on a connected display. Otherwise fall back to defaults
 *  (avoids opening offscreen when a monitor is unplugged). */
function readSavedWindowState(): SavedWindowState {
  const ui = getSetting<{ window?: SavedWindowState }>('ui');
  const saved = ui?.window;
  if (!saved?.bounds) return {};
  const { x, y, width, height } = saved.bounds;
  if (!Number.isFinite(x) || !Number.isFinite(y) || width < 320 || height < 240) {
    return {};
  }
  // Reject bounds whose center isn't on any current display.
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const onScreen = screen.getAllDisplays().some((d) => {
    const b = d.bounds;
    return centerX >= b.x && centerX <= b.x + b.width
        && centerY >= b.y && centerY <= b.y + b.height;
  });
  if (!onScreen) return { maximized: saved.maximized };
  return saved;
}

function persistWindowState(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  // The 'close' event fires *after* `before-quit` (which closes the
  // DB). Skip the save in that window — last-known state from the
  // debounced 'resize'/'move' handler is already on disk anyway.
  if (!isDbOpen()) return;
  const ui = getSetting<Record<string, unknown>>('ui') ?? {};
  const next: SavedWindowState = {
    // `getNormalBounds` returns the un-maximized rect; when the user
    // restores from maximized we want to land back at that size.
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
  };
  setSetting('ui', { ...ui, window: next });
}

function createMainWindow(): BrowserWindow {
  const saved = readSavedWindowState();
  const bounds = saved.bounds ?? DEFAULT_BOUNDS;
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  // Window chrome, per platform:
  //  - macOS: inset traffic lights; the app draws the rest of the bar
  //    (system menu bar lives at the top of the screen).
  //  - Windows: hide the OS title bar but keep native min/max/close via
  //    the Window Controls Overlay (titleBarOverlay); the app draws its
  //    own menu bar in the freed space.
  //  - Linux: `titleBarOverlay` is unreliable across WMs/WSLg, so go
  //    FULLY frameless (`frame: false`) and draw our own window controls
  //    (the menu bar already has the win.action IPC). Works on every WM.
  //  `autoHideMenuBar` hides the native menu bar (we render our own)
  //  while keeping its accelerators alive.
  const TITLEBAR_H = 40;
  const chrome: Electron.BrowserWindowConstructorOptions = isMac
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
    : isWin
      ? {
          titleBarStyle: 'hidden',
          autoHideMenuBar: true,
          // Match the side panels' surface so the native caption-button
          // area blends with our custom titlebar + the left/right panels.
          titleBarOverlay: {
            color: '#14181f',
            symbolColor: '#9aa4b2',
            height: TITLEBAR_H,
          },
        }
      : { frame: false, autoHideMenuBar: true }; // Linux: fully frameless.
  const window = new BrowserWindow({
    x: saved.bounds?.x,
    y: saved.bounds?.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e0e12',
    ...chrome,
    icon: ICON_PATH,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (saved.maximized) window.maximize();

  // Debounced — `move` and `resize` fire many times per drag, no point
  // hammering the DB.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; persistWindowState(window); }, 500);
  };
  window.on('move', scheduleSave);
  window.on('resize', scheduleSave);
  window.on('close', () => persistWindowState(window));

  // Keep the custom menu bar's Maximize/Restore labels in sync.
  const sendMax = (maximized: boolean): void => {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.WinMaximizeChanged, maximized);
  };
  window.on('maximize', () => sendMax(true));
  window.on('unmaximize', () => sendMax(false));

  window.on('ready-to-show', () => window.show());

  // Safety net: the window is created hidden and normally revealed on the
  // renderer's first paint (`ready-to-show`). Under some environments —
  // notably WSLg with software rendering — that event can be delayed or
  // never fire, leaving the window permanently invisible. Show it anyway
  // after a short grace period (no-op if it's already visible).
  setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) {
      console.warn('[window] ready-to-show did not fire in 2.5s — showing anyway');
      window.show();
    }
  }, 2500);

  // Surface renderer load / crash failures to the terminal so a blank
  // window isn't a silent mystery.
  window.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[window] did-fail-load: ${code} ${desc} (${url})`);
  });
  window.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] render-process-gone:', details);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openUrlInPreferredBrowser(url);
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    // Skip the auto-opened detached DevTools under WSL — it spawns a
    // confusing second top-level window (and renders poorly under WSLg's
    // software compositor). Open it manually via View → Toggle DevTools
    // (or Ctrl+Shift+I) when needed.
    const underWsl = process.platform === 'linux'
      && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
    if (!underWsl) window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  AgentHost.attachWindow(window.webContents);
  return window;
}

/** Open the About dialog in the focused (or first) window. Used by the
 *  native macOS app menu, which can't render our in-app menu bar. */
function sendShowAbout(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.ShowAbout);
}

function registerCoreHandlers(): void {
  ipcMain.handle(IpcChannel.AppGetVersion, () => app.getVersion());
  ipcMain.handle(IpcChannel.UpdatesCheck, () => checkForUpdates());
  ipcMain.on(IpcChannel.UpdatesInstall, () => quitAndInstallUpdate());
  // Quit from the custom titlebar menu (Windows, where the native menu
  // bar is hidden). Routes through app.quit() so the before-quit flush
  // (SDK session JSONLs) still runs.
  ipcMain.handle(IpcChannel.AppQuit, () => app.quit());
  // The renderer changed the UI language (and already persisted it to
  // settings). Rebuild the native app menu so its labels follow suit
  // without requiring a restart.
  ipcMain.on(IpcChannel.LocaleChanged, () => installAppMenu());
  // Window / edit / view commands from the custom menu bar. Acts on the
  // window that sent the request so it works regardless of which window
  // (we only have one today, but keep it correct).
  ipcMain.handle(IpcChannel.WinAction, (e, name: import('@shared/ipc').WinActionName) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const wc = win.webContents;
    switch (name) {
      case 'minimize': win.minimize(); return;
      case 'maximize-toggle':
        if (win.isMaximized()) win.unmaximize(); else win.maximize();
        return win.isMaximized();
      case 'close': win.close(); return;
      case 'is-maximized': return win.isMaximized();
      case 'undo': wc.undo(); return;
      case 'redo': wc.redo(); return;
      case 'cut': wc.cut(); return;
      case 'copy': wc.copy(); return;
      case 'paste': wc.paste(); return;
      case 'select-all': wc.selectAll(); return;
      case 'reload': wc.reload(); return;
      case 'force-reload': wc.reloadIgnoringCache(); return;
      case 'toggle-devtools': wc.toggleDevTools(); return;
      case 'zoom-in': wc.setZoomLevel(wc.getZoomLevel() + 0.5); return;
      case 'zoom-out': wc.setZoomLevel(wc.getZoomLevel() - 0.5); return;
      case 'zoom-reset': wc.setZoomLevel(0); return;
    }
  });
}

/** Current UI locale, read from the persisted setting (falls back to the
 *  OS locale, then English). The renderer owns this setting; main mirrors
 *  it so native chrome (the app menu) matches the in-app language. */
function currentLocale(): import('@shared/i18n').Locale {
  return resolveLocale(getSetting<string>(LOCALE_SETTING_KEY) ?? app.getLocale());
}

/** Build the application menu. We mostly want Electron's defaults
 *  (Edit/View/Window with their stock keybindings), but spell the
 *  Quit item out so it's obviously named "Quit PopBot" with ⌘Q —
 *  closing the window doesn't quit (hibernation), so users need a
 *  clear visible escape hatch.
 *
 *  Labels we set ourselves are localized via the active locale; the
 *  role-based submenus (Edit/View/Window) keep Electron's OS-locale
 *  strings, which is the platform-native behavior. */
function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const t = createTranslator(currentLocale());
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: t('menu.about'), click: () => sendShowAbout() },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { label: t('menu.quit'), accelerator: 'Cmd+Q', click: () => app.quit() },
      ],
    }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(!isMac ? [{
      label: t('menu.file'),
      submenu: [
        { label: t('menu.quit'), accelerator: 'Ctrl+Q', click: () => app.quit() },
      ],
    } satisfies Electron.MenuItemConstructorOptions] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Right-click menu on the macOS Dock icon. The OS already adds Show/
 *  Hide/Quit defaults; this prepends "New Chat Window" so users can
 *  reopen a window after closing it without having to ⌘N inside the
 *  app, plus an explicit Quit so the option is visually consistent
 *  with the app menu. */
function installDockMenu(): void {
  if (process.platform !== 'darwin') return;
  app.dock?.setMenu(Menu.buildFromTemplate([
    {
      label: 'New Chat Window',
      click: () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); },
    },
    { type: 'separator' },
    { label: `Quit ${app.name}`, click: () => app.quit() },
  ]));
}

void app.whenReady().then(async () => {
  initDb();
  // One-time backfill: copy any pre-existing CLI JSONL transcripts
  // into our SqliteSessionStore so legacy chats don't lose memory on
  // their first post-upgrade resume. Idempotent + flagged in settings;
  // no-ops on subsequent boots. Fire-and-forget — boot continues
  // immediately and the import runs in the background. Worst case if
  // a chat is opened mid-import is a one-time "claude has no memory"
  // for that single chat (same as today), and the next reopen works.
  void importExistingJsonlsIfNeeded().catch((err) => {
    console.error('[boot] sessionStore import failed', err);
  });
  // Backfill chat.ticket / chat.pr from chat names where missing —
  // catches older CR chats ("[CR] PR #8123 · …") that didn't store
  // the explicit pr field at create time, plus any chat whose title
  // contains a Linear identifier. Idempotent SQL scan.
  try {
    backfillAllChats();
  } catch (err) {
    console.error('[boot] chat-field backfill failed', err);
  }
  // Companion to schema v12: rename the SDK's per-project session
  // directories under ~/.claude/projects/ from the legacy
  // `-popbot-worktrees-*` shape to the new `-popbot-workspaces-autorpg-*`
  // shape. Must run BEFORE the pin repair below, otherwise the repair
  // sees the new derived cwd path, fails to find the JSONL (still at
  // the old location), and clears every chat's session_id pin.
  try {
    migrateSdkProjectDirs();
  } catch (err) {
    console.error('[boot] sdk project-dir migration failed', err);
  }
  // Mirror settings.git → repos table. v1 single-repo bootstrap;
  // once multi-repo lands the table becomes source of truth and this
  // call goes away.
  try {
    seedDefaultRepoFromSettings();
  } catch (err) {
    console.error('[boot] repo seed failed', err);
  }
  // Boot-time chat-session recovery — restores chat→session links
  // that the legacy JSONL-based pin repair (now retired) wrongly
  // cleared, and attributes orphan SDK transcript entries to their
  // owning chats via ticket / PR markers in the payload text.
  //
  // Idempotent + safe to re-run: each pass is a no-op for chats
  // whose pin is already valid and whose entries are already
  // attributed. Once we've confirmed an install is fully recovered,
  // this hook can be removed (the manual per-chat recovery exposed
  // via chat settings will be the long-term recovery path).
  try {
    await recoverChatSessions();
  } catch (err) {
    console.error('[boot] chat-session recovery failed', err);
  }
  // Stale `run` statuses from a prior app exit aren't backed by a real
  // SDK session — flip them to `idle` so the thumbnail "thinking"
  // cursor doesn't sit there forever after a restart.
  clearStaleRunningStatuses();
  // macOS: swap the Dock icon during `npm run dev`. (Packaged builds get
  // their icon from electron-builder + .icns, so this is dev-only.)
  if (isDev && process.platform === 'darwin') {
    try {
      app.dock?.setIcon(ICON_PATH);
    } catch {
      // ignore — the dev icon is cosmetic
    }
  }
  installAppMenu();
  installDockMenu();
  registerCoreHandlers();
  registerChatHandlers();
  registerAgentHandlers();
  registerSettingsHandlers();
  registerLinearHandlers();
  registerFilesHandlers();
  registerAppsHandlers();
  registerGitHandlers();
  registerReviewsHandlers();
  registerReposHandlers();
  registerTermHandlers();
  registerNotificationsHandlers();
  registerSentryHandlers();
  registerSlackHandlers();
  // Sweep notifications older than 30 days at startup so the table
  // doesn't accrete unbounded. Cheap synchronous DELETE.
  pruneOlderThan(Date.now() - 30 * 24 * 60 * 60 * 1000);
  // ONE-SHOT cleanup: the v0.0.6→v0.0.8 review/Linear pollers
  // dispatched a notification per item-on-poll, polluting users' DBs
  // with dozens of "you have a PR in your queue" rows that aren't
  // actual events. Wipe them once so the bell is empty until real
  // event sources land. Gated by a setting flag so it only runs once.
  if (!getSetting<{ done?: boolean }>('one-shot-notif-purge')?.done) {
    pruneOlderThan(Date.now()); // delete everything
    setSetting('one-shot-notif-purge', { done: true });
  }
  const win = createMainWindow();
  attachTermWindow(win.webContents);
  startAutoUpdater();
  startSentryPoller();
  startSlackPoller();
  // Loud failure if `claude` isn't on PATH — without this the user sees
  // chats that never produce a response and no obvious explanation.
  void probeClaudeAndNotify();
  // Prefer the user's installed Codex CLI when present. If absent, the
  // Codex SDK can still fall back to its packaged binary.
  void probeCodexForPath();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Slack/Discord-style hibernation. Closing the window keeps the app
  // alive in the dock so long-lived agent sessions stay attached. Only
  // ⌘Q / menu Quit triggers `before-quit` and an actual shutdown.
  if (process.platform !== 'darwin') app.quit();
});

let isQuitting = false;

app.on('before-quit', (event) => {
  if (isQuitting) return;
  // Defer the actual quit until SDK sessions have flushed their
  // session JSONLs. Without this Electron kills the `claude` child
  // processes mid-write and the next launch hits "no conversation
  // found" when trying to resume.
  event.preventDefault();
  isQuitting = true;
  stopAutoUpdater();
  stopSentryPoller();
  stopSlackPoller();
  disposeAllPtys();
  void AgentHost.disposeAll().finally(() => {
    closeDb();
    app.quit();
  });
});

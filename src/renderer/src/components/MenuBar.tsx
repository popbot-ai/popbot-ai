import { useCallback, useEffect, useRef, useState } from 'react';
import type { WinActionName } from '@shared/ipc';
import { useTranslation } from '../lib/i18n';
import popbotIcon from '../assets/popbot-icon.png';

/**
 * Windows/Linux menu bar — a custom, theme-matched replacement for the
 * native menu bar we hide on frameless platforms. Behaves like a
 * standard Windows menu bar:
 *   - click a top-level to open it; while a menu is open, hovering
 *     another top-level switches to it
 *   - Escape / click-outside closes
 *   - items show their accelerator on the right
 *
 * The PopBot app icon at the far left is part of the window caption (a
 * drag region), so right-clicking it — or any empty part of the title
 * bar — pops the genuine **Windows system menu** (Restore / Move / Size /
 * Minimize / Maximize / Close), and double-clicking maximizes/restores,
 * exactly like a standard Windows title bar. (Electron has no API to
 * pop the system menu programmatically; the OS shows it automatically
 * on right-click of a caption region.)
 */
interface MenuItem {
  label?: string;
  accel?: string;
  onClick?: () => void;
  separator?: boolean;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
}

interface MenuBarProps {
  onNewChat?: () => void;
  onOpenPrefs: () => void;
  onToggleGitPanel?: () => void;
  gitPanelOpen?: boolean;
  /** Opens the About dialog (Help ▸ About PopBot). */
  onOpenAbout?: () => void;
}

const win = (name: WinActionName) => (): void => { void window.popbot.win.action(name); };

const REPO_URL = 'https://github.com/popbot-ai/popbot-ai';

export function MenuBar({ onNewChat, onOpenPrefs, onToggleGitPanel, gitPanelOpen, onOpenAbout }: MenuBarProps): JSX.Element {
  const { t } = useTranslation();
  // Which menu is open, by id. The app-icon system menu uses id '__sys'.
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = useCallback(() => setOpen(null), []);
  const runItem = (it: MenuItem) => () => {
    if (it.disabled) return;
    close();
    it.onClick?.();
  };

  const menus: Array<{ id: string; label: string; items: MenuItem[] }> = [
    {
      id: 'file',
      label: t('menu.file'),
      items: [
        { label: t('menu.newChat'), accel: 'Ctrl+T', onClick: onNewChat },
        { label: t('menu.preferences'), accel: 'Ctrl+,', onClick: onOpenPrefs },
        { separator: true },
        { label: t('menu.quit'), accel: 'Ctrl+Q', danger: true, onClick: () => void window.popbot.app.quit() },
      ],
    },
    {
      id: 'edit',
      label: t('menu.edit'),
      items: [
        { label: t('menu.undo'), accel: 'Ctrl+Z', onClick: win('undo') },
        { label: t('menu.redo'), accel: 'Ctrl+Y', onClick: win('redo') },
        { separator: true },
        { label: t('menu.cut'), accel: 'Ctrl+X', onClick: win('cut') },
        { label: t('menu.copy'), accel: 'Ctrl+C', onClick: win('copy') },
        { label: t('menu.paste'), accel: 'Ctrl+V', onClick: win('paste') },
        { label: t('menu.selectAll'), accel: 'Ctrl+A', onClick: win('select-all') },
      ],
    },
    {
      id: 'view',
      label: t('menu.view'),
      items: [
        { label: t('menu.gitPanel'), checked: gitPanelOpen, onClick: onToggleGitPanel },
        { separator: true },
        { label: t('menu.resetZoom'), accel: 'Ctrl+0', onClick: win('zoom-reset') },
        { label: t('menu.zoomIn'), accel: 'Ctrl++', onClick: win('zoom-in') },
        { label: t('menu.zoomOut'), accel: 'Ctrl+-', onClick: win('zoom-out') },
      ],
    },
    {
      id: 'help',
      label: t('menu.help'),
      items: [
        { label: t('menu.documentation'), onClick: () => window.open(`${REPO_URL}/blob/main/docs/GUIDE.md`, '_blank') },
        { label: t('menu.configGuide'), onClick: () => window.open(`${REPO_URL}/blob/main/docs/CONFIGURATION.md`, '_blank') },
        { separator: true },
        { label: t('menu.reportIssue'), onClick: () => window.open(`${REPO_URL}/issues`, '_blank') },
        { separator: true },
        { label: t('menu.about'), onClick: onOpenAbout },
      ],
    },
  ];

  const renderDropdown = (items: MenuItem[], extraClass = ''): JSX.Element => (
    <div className={`menubar-pop ${extraClass}`} role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menubar-sep" />
        ) : (
          <button
            key={i}
            className={`menubar-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`}
            role="menuitem"
            disabled={it.disabled}
            onClick={runItem(it)}
          >
            <span className="menubar-check">{it.checked ? <i className="fa-solid fa-check" /> : null}</span>
            <span className="menubar-label">{it.label}</span>
            {it.accel && <span className="menubar-accel">{it.accel}</span>}
          </button>
        ),
      )}
    </div>
  );

  return (
    <div className="menubar" ref={barRef}>
      {/* App icon — part of the window caption (drag region), so the OS
          shows the native Windows system menu on right-click and
          maximizes on double-click, just like a standard title bar. */}
      <div className="menubar-icon" title="PopBot">
        <img src={popbotIcon} alt="PopBot" draggable={false} />
      </div>

      {/* Top-level menus. */}
      {menus.map((m) => (
        <div key={m.id} className="menubar-top">
          <button
            className={`menubar-trigger${open === m.id ? ' active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === m.id}
            onClick={() => setOpen((o) => (o === m.id ? null : m.id))}
            // Windows behavior: once ANY menu is open, moving the mouse
            // across the bar switches to whichever top-level it's over,
            // until the menu is dismissed.
            onMouseEnter={() => setOpen((o) => (o ? m.id : o))}
          >
            {m.label}
          </button>
          {open === m.id && renderDropdown(m.items)}
        </div>
      ))}
    </div>
  );
}

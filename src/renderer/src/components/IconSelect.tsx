/**
 * A dropdown whose options carry an icon — the native <select> cannot
 * show one, and draws its text in the system's colours, not the app's.
 * Square panels; keyboard: arrows move, Enter/Space choose, Escape
 * closes (caught in the capture phase so it does not also close a
 * parent modal). Used for the ticket source and game engine
 * (Preferences) and the host and repository of a bot.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

export interface SelectChoice {
  id: string;
  label: string;
  icon: ReactNode;
  /** A dimmer second part — a host's address, "offline". */
  detail?: string;
  disabled?: boolean;
}

export function IconSelect({ value, onChange, options, block = false, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  options: SelectChoice[];
  /** Fill the width it is given, instead of the fixed 200 px. */
  block?: boolean;
  /** Shown when no option has `value`. */
  placeholder?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Which option the keyboard cursor is on while the menu is open.
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const found = options.findIndex((t) => t.id === value);
  const currentIndex = Math.max(0, found);
  const current = found >= 0 ? options[found] : placeholder === undefined ? options[0] : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btnRef.current?.focus(); }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Each time we open, start the cursor on the current selection.
  useEffect(() => { if (open) setActive(currentIndex); }, [open, currentIndex]);

  // Move DOM focus to the active option so screen readers announce it and
  // keyboard users see a real focus ring while arrowing through the menu.
  useEffect(() => { if (open) itemRefs.current[active]?.focus(); }, [open, active]);

  const choose = (i: number): void => {
    const opt = options[i];
    if (opt && !opt.disabled) onChange(opt.id);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => (i + 1) % options.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => (i - 1 + options.length) % options.length);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!open) setOpen(true);
        else choose(active);
        break;
      default:
        break;
    }
  };

  return (
    <div className={`tracker-dd${block ? ' block' : ''}`} ref={ref} onKeyDown={onKeyDown}>
      <button
        ref={btnRef}
        type="button"
        className="tracker-dd-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? (
          <>
            {current.icon}
            <span className="tracker-dd-label">{current.label}</span>
            {current.detail && <span className="tracker-dd-detail">{current.detail}</span>}
          </>
        ) : (
          <span className="tracker-dd-label tracker-dd-placeholder">{placeholder}</span>
        )}
        <i className="fa-solid fa-chevron-down tracker-dd-caret" />
      </button>
      {open && (
        <div className="tracker-dd-menu" role="listbox">
          {options.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              className={`tracker-dd-item${t.id === value ? ' selected' : ''}${i === active ? ' active' : ''}`}
              role="option"
              aria-selected={t.id === value}
              disabled={t.disabled}
              onClick={() => choose(i)}
              onMouseEnter={() => setActive(i)}
            >
              {t.icon}
              <span className="tracker-dd-label">{t.label}</span>
              {t.detail && <span className="tracker-dd-detail">{t.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

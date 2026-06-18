import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  children: ReactElement;
  content: ReactNode;
  /** Show delay in ms. Matches macOS-y feel without being sluggish. */
  delay?: number;
  /** Preferred placement when there's room. */
  placement?: 'bottom' | 'top';
}

interface Pos {
  left: number;
  top: number;
  /** Which side ended up being used after edge-flipping; used to nudge
   *  the arrow caret in the rendered tip. */
  placement: 'bottom' | 'top';
}

/**
 * Lightweight hover tooltip. Renders into document.body via a portal so
 * the floating tip can escape any `overflow:hidden` scroll containers
 * (PanelB scrollbar, the chat-list panel-body, etc).
 *
 * Wraps a single child element and forwards mouseenter/leave to it.
 * The child must accept ref + handlers — typical use is wrapping an
 * `<i>` icon or a row `<div>`.
 */
/** Margin from the viewport edge — keeps the tip from kissing the
 *  window border and getting clipped by scrollbars / drop shadows. */
const VIEWPORT_MARGIN = 8;

export function Tooltip({ children, content, delay = 250, placement = 'bottom' }: TooltipProps): JSX.Element {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Right-click anywhere force-dismisses the tooltip — the consumer is
  // about to render a context menu (PanelA's row menu, etc.) and a
  // tooltip floating over it makes the menu unreadable. Cheaper to
  // listen globally than to thread a "context menu open" prop through
  // every Tooltip caller.
  useEffect(() => {
    const onContextMenu = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setShow(false);
    };
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
  }, []);

  // Two-pass positioning: paint at the centered estimate (so size is
  // measurable), then in layout phase clamp into the viewport before
  // the user can perceive the move. Without this, tooltips anchored
  // near the right edge of a sidebar overflow the window and get
  // clipped at the screen edge.
  useLayoutEffect(() => {
    if (!show || !pos || !tipRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    let nextLeft = pos.left;
    let nextTop = pos.top;
    // Tooltip is centered on `left` via translateX(-50%). Convert the
    // anchor point to its rendered left/right edges to clamp.
    const renderedLeft = pos.left - tip.width / 2;
    const renderedRight = pos.left + tip.width / 2;
    if (renderedRight > window.innerWidth - VIEWPORT_MARGIN) {
      nextLeft -= renderedRight - (window.innerWidth - VIEWPORT_MARGIN);
    }
    if (renderedLeft < VIEWPORT_MARGIN) {
      nextLeft += VIEWPORT_MARGIN - renderedLeft;
    }
    // Vertical: if a 'bottom' tip would overflow downward, flip up.
    // (Initial estimate already considers spaceBelow, but the actual
    // tip can be taller than the 80px guess for rich content.)
    if (pos.placement === 'bottom' && pos.top + tip.height > window.innerHeight - VIEWPORT_MARGIN) {
      const triggerBox = triggerRef.current?.getBoundingClientRect();
      if (triggerBox && triggerBox.top - tip.height - 6 >= VIEWPORT_MARGIN) {
        nextTop = triggerBox.top - 6;
        if (nextTop !== pos.top) {
          setPos({ left: nextLeft, top: nextTop, placement: 'top' });
          return;
        }
      }
    }
    if (nextLeft !== pos.left || nextTop !== pos.top) {
      setPos({ left: nextLeft, top: nextTop, placement: pos.placement });
    }
  }, [show, pos]);

  const onEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const wantBelow = placement === 'bottom';
      const spaceBelow = window.innerHeight - r.bottom;
      const place: 'bottom' | 'top' = wantBelow && spaceBelow < 80 ? 'top' : placement;
      setPos({
        left: r.left + r.width / 2,
        top: place === 'bottom' ? r.bottom + 6 : r.top - 6,
        placement: place,
      });
      setShow(true);
    }, delay);
  };

  const onLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setShow(false);
  };

  const child = cloneElement(children, {
    ref: (el: HTMLElement | null) => {
      triggerRef.current = el;
      // Forward ref if the original child had one. React's typing here
      // is loose; just call any function ref the consumer set.
      const orig = (children as unknown as { ref?: unknown }).ref;
      if (typeof orig === 'function') orig(el);
    },
    onMouseEnter: (e: React.MouseEvent) => {
      onEnter();
      (children.props as { onMouseEnter?: (e: React.MouseEvent) => void }).onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      onLeave();
      (children.props as { onMouseLeave?: (e: React.MouseEvent) => void }).onMouseLeave?.(e);
    },
  } as Record<string, unknown>);

  return (
    <>
      {child}
      {show && pos && createPortal(
        <div
          ref={tipRef}
          className={`tooltip ${pos.placement === 'top' ? 'above' : 'below'}`}
          style={{
            left: pos.left,
            top: pos.top,
            transform: pos.placement === 'top'
              ? 'translate(-50%, -100%)'
              : 'translate(-50%, 0)',
            // Cap at viewport - 2*margin so wide content can't push
            // the tip out the side; the layout-effect clamps the
            // position, this caps the size.
            maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
          }}
          role="tooltip"
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}

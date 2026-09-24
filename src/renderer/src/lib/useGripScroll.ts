import { useEffect, type RefObject } from 'react';

/**
 * Grip-scrolling for a horizontal scroller: over the top part of it the
 * cursor is a hand, and pressing and dragging there pans the scroll
 * instead of acting on what's under the pointer. Below that band the
 * children behave as usual (click to select, drag to reorder).
 *
 * Native listeners on the element: `grip-zone` is toggled on it while
 * the pointer is in the band (CSS turns that into the hand), `grabbing`
 * while a pan is in progress. A pan swallows the click that would
 * otherwise land at mouseup, and its mousedown is default-prevented so
 * a draggable child doesn't start an HTML5 drag under it.
 */
export function useGripScroll(ref: RefObject<HTMLElement | null>, zoneFraction = 1 / 3): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let panning = false;
    let moved = false;
    let startX = 0;
    let startLeft = 0;
    let suppressClick = false;

    const inZone = (e: MouseEvent): boolean => {
      const r = el.getBoundingClientRect();
      return e.clientY - r.top <= r.height * zoneFraction;
    };
    const onMove = (e: MouseEvent): void => {
      if (panning) return;
      el.classList.toggle('grip-zone', inZone(e));
    };
    const onLeave = (): void => { el.classList.remove('grip-zone'); };
    const onPan = (e: MouseEvent): void => {
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      el.scrollLeft = startLeft - dx;
    };
    const onUp = (): void => {
      panning = false;
      el.classList.remove('grabbing');
      window.removeEventListener('mousemove', onPan);
      if (moved) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
    };
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0 || !inZone(e)) return;
      panning = true;
      moved = false;
      startX = e.clientX;
      startLeft = el.scrollLeft;
      el.classList.add('grabbing');
      e.preventDefault();
      window.addEventListener('mousemove', onPan);
      window.addEventListener('mouseup', onUp, { once: true });
    };
    const onClickCapture = (e: MouseEvent): void => {
      if (!suppressClick) return;
      e.stopPropagation();
      e.preventDefault();
    };

    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('mousedown', onDown);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('mousemove', onPan);
      el.classList.remove('grip-zone', 'grabbing');
    };
  }, [ref, zoneFraction]);
}

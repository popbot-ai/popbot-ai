/**
 * The thumbnail strip's accordion: every open chat fits in the strip at
 * once. Each card is somewhere between a thin stripe (name, status) and
 * a full thumbnail, and one scroll position decides which cards are
 * open — a window of "extra" width sliding over the cards in order:
 *
 *   |thin|thin|thin|▌full…|full|full|…full▐|thin|thin|
 *
 * Model: card i may grow from `thin` to `full`, i.e. take up to
 * D = full − thin extra pixels, and the strip has E extra pixels to
 * hand out after every card's stripe and the gaps are paid for. Lay the
 * cards' extra ranges end to end, [0, D), [D, 2D), …; the window
 * [scroll, scroll + E) over that line gives each card the overlap as
 * its extra width. Sums to exactly E, so the strip is always full, and
 * moving the window by one pixel moves one pixel of width from the
 * card leaving to the card entering — the stretch the user sees.
 *
 * A card opening at the window's left edge shows its right part, one at
 * the right edge its left part (`anchor`), like a real viewport.
 */

export interface AccordionOptions {
  thin: number;
  full: number;
  gap: number;
}

export interface AccordionLayout {
  widths: number[];
  /** 0 = stripe, 1 = full thumbnail. */
  open: number[];
  /** Which edge the full content anchors to while the card is partly open. */
  anchors: Array<'left' | 'right'>;
  /** The scroll range; 0 when everything fits (or nothing does). */
  maxScroll: number;
  /** Every card is a full thumbnail: no accordion needed. */
  allOpen: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Extra pixels available once every card's stripe and the gaps are paid. */
function extraWidth(n: number, width: number, o: AccordionOptions): number {
  return width - (n - 1) * o.gap - n * o.thin;
}

export function accordionLayout(n: number, width: number, scroll: number, o: AccordionOptions): AccordionLayout {
  if (n <= 0) return { widths: [], open: [], anchors: [], maxScroll: 0, allOpen: true };
  const D = o.full - o.thin;
  const E = extraWidth(n, width, o);
  if (E >= n * D) {
    return {
      widths: Array(n).fill(o.full),
      open: Array(n).fill(1),
      anchors: Array(n).fill('left'),
      maxScroll: 0,
      allOpen: true,
    };
  }
  if (E <= 0) {
    // Not even the stripes fit. Everything thin; the strip overflows.
    return {
      widths: Array(n).fill(o.thin),
      open: Array(n).fill(0),
      anchors: Array(n).fill('left'),
      maxScroll: 0,
      allOpen: false,
    };
  }
  const maxScroll = n * D - E;
  const s = clamp(scroll, 0, maxScroll);
  const widths: number[] = [];
  const open: number[] = [];
  const anchors: Array<'left' | 'right'> = [];
  for (let i = 0; i < n; i++) {
    const lo = i * D;
    const overlap = clamp(Math.min(lo + D, s + E) - Math.max(lo, s), 0, D);
    widths.push(o.thin + overlap);
    open.push(overlap / D);
    anchors.push(lo < s ? 'right' : 'left');
  }
  return { widths, open, anchors, maxScroll, allOpen: false };
}

/**
 * The nearest scroll position at which card `i` is fully open — the
 * current one when it already is — clamped to the range. When the strip
 * can't open even one card fully, the position that shows most of it.
 */
export function scrollToReveal(i: number, scroll: number, n: number, width: number, o: AccordionOptions): number {
  if (n <= 0) return 0;
  const D = o.full - o.thin;
  const E = extraWidth(n, width, o);
  if (E >= n * D || E <= 0) return 0;
  const maxScroll = n * D - E;
  const idx = clamp(i, 0, n - 1);
  const lo = idx * D;
  if (E < D) return clamp(lo - (E - D) / 2, 0, maxScroll);
  // Fully open ⇔ scroll ≤ lo and scroll + E ≥ lo + D.
  const min = lo + D - E;
  const max = lo;
  return clamp(clamp(scroll, min, max), 0, maxScroll);
}

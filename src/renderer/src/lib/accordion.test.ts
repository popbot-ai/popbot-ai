import { describe, expect, it } from 'vitest';
import { accordionLayout, scrollToReveal } from './accordion';

const o = { thin: 24, full: 240, gap: 6 };
const total = (widths: number[]): number => widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * o.gap;

describe('accordionLayout', () => {
  it('opens every card when they all fit', () => {
    const l = accordionLayout(3, 3 * 240 + 2 * 6 + 50, 0, o);
    expect(l.allOpen).toBe(true);
    expect(l.widths).toEqual([240, 240, 240]);
    expect(l.maxScroll).toBe(0);
  });

  it('always fills the strip exactly, with the open window sliding along the scroll', () => {
    const n = 10;
    const width = 800;
    for (const scroll of [0, 100, 500, 1234, 5000]) {
      const l = accordionLayout(n, width, scroll, o);
      expect(total(l.widths)).toBe(width);
      expect(l.widths.every((w) => w >= o.thin && w <= o.full)).toBe(true);
    }
    const start = accordionLayout(n, width, 0, o);
    expect(start.widths[0]).toBe(240);
    expect(start.widths[n - 1]).toBe(24);
    const end = accordionLayout(n, width, start.maxScroll, o);
    expect(end.widths[n - 1]).toBe(240);
    expect(end.widths[0]).toBe(24);
  });

  it('moves width one pixel at a time from the card leaving to the card entering', () => {
    const a = accordionLayout(6, 700, 300, o);
    const b = accordionLayout(6, 700, 301, o);
    const diffs = a.widths.map((w, i) => b.widths[i] - w);
    expect(diffs.filter((d) => d !== 0).sort()).toEqual([-1, 1]);
  });

  it('anchors a card opening on the left edge to its right side', () => {
    const l = accordionLayout(6, 700, 300, o);
    const partial = l.open.findIndex((v) => v > 0 && v < 1);
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(l.anchors[partial]).toBe('right');
    const last = l.open.map((v, i) => (v > 0 && v < 1 ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(l.anchors[last]).toBe('left');
  });

  it('goes all-thin when not even the stripes fit', () => {
    const l = accordionLayout(30, 100, 0, o);
    expect(l.allOpen).toBe(false);
    expect(l.widths.every((w) => w === o.thin)).toBe(true);
    expect(l.maxScroll).toBe(0);
  });
});

describe('scrollToReveal', () => {
  it('leaves the scroll alone when the card is already fully open', () => {
    expect(scrollToReveal(0, 0, 10, 800, o)).toBe(0);
    const s = scrollToReveal(5, 0, 10, 800, o);
    expect(accordionLayout(10, 800, s, o).widths[5]).toBe(240);
    expect(scrollToReveal(5, s, 10, 800, o)).toBe(s);
  });

  it('moves the least it can to open a card at either end', () => {
    const s9 = scrollToReveal(9, 0, 10, 800, o);
    expect(accordionLayout(10, 800, s9, o).widths[9]).toBe(240);
    const back = scrollToReveal(0, s9, 10, 800, o);
    expect(back).toBe(0);
    // From the far end, opening card 8 moves just enough: 9 stays open too.
    const s8 = scrollToReveal(8, s9, 10, 800, o);
    const l = accordionLayout(10, 800, s8, o);
    expect(l.widths[8]).toBe(240);
    expect(l.widths[9]).toBe(240);
  });

  it('returns 0 when everything fits', () => {
    expect(scrollToReveal(2, 500, 3, 2000, o)).toBe(0);
  });
});

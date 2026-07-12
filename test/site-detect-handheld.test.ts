/**
 * Guards the site's handheld detection (site/index.html → detectHandheld).
 *
 * The asymmetry that drives every choice here: a false NEGATIVE costs one junk
 * download conversion; a false POSITIVE blocks a paying customer from
 * downloading the app at all. So detection must fire only on positive evidence
 * of a mobile/tablet OS — never on a heuristic a desktop could trip.
 *
 * The `TRAP` cases below are the ones that actually bit during development:
 * a Mac with a touch display, and desktop Firefox carrying a `Mobile` token.
 * Both must resolve to DESKTOP.
 *
 * NOTE: this mirrors the implementation in site/index.html. The site is plain
 * static HTML with an inline script (no bundler), so it can't be imported —
 * if you change detectHandheld() there, mirror the change here.
 */
import { describe, expect, it } from 'vitest';

function detectHandheld(nav, win) {
  const ua = (nav.userAgent || '').toLowerCase();
  const uad = nav.userAgentData;
  if (uad && uad.mobile === true) return true;
  if (/android|iphone|ipod|ipad|windows phone|iemobile|blackberry|opera mini|silk|kindle|playbook/.test(ua)) return true;
  if (/macintosh/.test(ua) && nav.maxTouchPoints > 1
    && typeof win.matchMedia === 'function'
    && win.matchMedia('(pointer: coarse)').matches
    && !win.matchMedia('(pointer: fine)').matches) return true;
  return false;
}

/** A window whose pointer is a mouse/trackpad (desktop) or touch (handheld). */
const win = (coarse) => ({
  matchMedia: (q) => ({ matches: q.includes('coarse') ? coarse : !coarse }),
});
const FINE = win(false);
const COARSE = win(true);

const check = (ua, touchPoints, w, uad) =>
  detectHandheld({ userAgent: ua, maxTouchPoints: touchPoints, userAgentData: uad }, w);

describe('site handheld detection', () => {
  describe('desktop — must NEVER be blocked from downloading', () => {
    const desktops = [
      ['Windows Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36', 0, FINE],
      ['macOS Chrome', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36', 0, FINE],
      ['macOS Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15', 0, FINE],
      ['Linux Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 0, FINE],
      ['Ubuntu Chrome', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36', 0, FINE],
      ['TRAP: Windows touchscreen laptop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36', 10, FINE],
      ['TRAP: Mac with a touch display', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15', 5, FINE],
      ['TRAP: desktop Firefox with a Mobile token', 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0 Mobile', 0, FINE],
    ];
    for (const [name, ua, tp, w] of desktops) {
      it(`treats ${name} as desktop`, () => {
        expect(check(ua, tp, w)).toBe(false);
      });
    }
  });

  describe('mobile + tablet — must be shown the desktop-only notice', () => {
    const handhelds = [
      ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', 5, COARSE],
      ['Android phone', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36', 5, COARSE],
      ['Android tablet (no Mobile token)', 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 Chrome/126 Safari/537.36', 5, COARSE],
      ['iPad (legacy UA)', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', 5, COARSE],
      ['iPadOS 13+ (masquerades as Macintosh)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15', 5, COARSE],
      ['Kindle Fire', 'Mozilla/5.0 (Linux; Android 9; KFMAWI) AppleWebKit/537.36 Silk/126 Safari/537.36', 5, COARSE],
    ];
    for (const [name, ua, tp, w] of handhelds) {
      it(`treats ${name} as handheld`, () => {
        expect(check(ua, tp, w)).toBe(true);
      });
    }

    it('honors the Chromium mobile client hint', () => {
      expect(check('Mozilla/5.0 (Linux; Android 14) Chrome/126', 5, COARSE, { mobile: true })).toBe(true);
    });
  });

  it('does not guess when matchMedia is unavailable — defaults to desktop', () => {
    const noMatchMedia = {};
    const ipadOsUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15';
    expect(check(ipadOsUa, 5, noMatchMedia)).toBe(false);
  });
});

/**
 * Context-window arithmetic shared by main (the compaction note written
 * to the transcript) and the renderer (the composer's context gauge).
 *
 * "Used" is the tokens the conversation currently occupies; "budget" is
 * the window it is measured against — for Claude, the window the CLI
 * will autocompact at (200K on 1M-window models by default), which is
 * the number that matters to the user, not the raw model limit.
 */

/** Window assumed until a backend reports a real one. Matches the
 *  `tokens_budget` column default. */
export const DEFAULT_CONTEXT_BUDGET = 1_000_000;

export type ContextFillLevel = 'ok' | 'warn' | 'crit';

/** Whole-number percentage of the window in use, clamped to 0–100. */
export function contextFillPct(used: number, budget: number): number {
  if (!(budget > 0) || !(used > 0)) return 0;
  return Math.min(100, Math.round((used / budget) * 100));
}

/** Same thresholds as the thumbnail token bar (`tokenBarClass`), so the
 *  ring and the bar turn amber and red together. */
export function contextFillLevel(pct: number): ContextFillLevel {
  if (pct > 85) return 'crit';
  if (pct > 60) return 'warn';
  return 'ok';
}

/** 17352 → "17k", 2_400_000 → "2.4M". Mirrors the renderer's fmtTokens. */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(Math.max(0, Math.round(n)));
}

/** The transcript line for a finished compaction, e.g.
 *  "Context compacted · 17k → 3k tokens" (+ " · automatic" when the CLI
 *  did it on its own). Token counts are omitted when the backend didn't
 *  report them. */
export function compactionNoteText(c: {
  preTokens?: number;
  postTokens?: number;
  trigger?: 'manual' | 'auto';
}): string {
  const parts = ['Context compacted'];
  if (typeof c.preTokens === 'number' && typeof c.postTokens === 'number') {
    parts.push(`${formatTokenCount(c.preTokens)} → ${formatTokenCount(c.postTokens)} tokens`);
  }
  if (c.trigger === 'auto') parts.push('automatic');
  return parts.join(' · ');
}

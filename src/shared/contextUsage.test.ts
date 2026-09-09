import { describe, expect, it } from 'vitest';
import {
  compactionNoteText,
  contextFillLevel,
  contextFillPct,
  formatTokenCount,
} from './contextUsage';

describe('contextFillPct', () => {
  it('rounds to a whole percentage of the window', () => {
    expect(contextFillPct(17_352, 200_000)).toBe(9);
    expect(contextFillPct(100_000, 200_000)).toBe(50);
  });

  it('clamps at 100 when the conversation is over the window', () => {
    expect(contextFillPct(250_000, 200_000)).toBe(100);
  });

  it('is 0 with nothing measured yet or a missing window', () => {
    expect(contextFillPct(0, 200_000)).toBe(0);
    expect(contextFillPct(5_000, 0)).toBe(0);
    expect(contextFillPct(Number.NaN, 200_000)).toBe(0);
  });
});

describe('contextFillLevel', () => {
  it('turns amber past 60% and red past 85%, like the thumbnail bar', () => {
    expect(contextFillLevel(0)).toBe('ok');
    expect(contextFillLevel(60)).toBe('ok');
    expect(contextFillLevel(61)).toBe('warn');
    expect(contextFillLevel(85)).toBe('warn');
    expect(contextFillLevel(86)).toBe('crit');
    expect(contextFillLevel(100)).toBe('crit');
  });
});

describe('formatTokenCount', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(17_352)).toBe('17k');
    expect(formatTokenCount(200_000)).toBe('200k');
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(2_400_000)).toBe('2.4M');
  });
});

describe('compactionNoteText', () => {
  it('reports the before/after counts of a manual compaction', () => {
    expect(compactionNoteText({ preTokens: 17_352, postTokens: 2_951, trigger: 'manual' }))
      .toBe('Context compacted · 17k → 3k tokens');
  });

  it('marks a compaction the CLI ran on its own', () => {
    expect(compactionNoteText({ preTokens: 180_000, postTokens: 41_000, trigger: 'auto' }))
      .toBe('Context compacted · 180k → 41k tokens · automatic');
  });

  it('still reads sensibly when the backend reported no counts', () => {
    expect(compactionNoteText({})).toBe('Context compacted');
  });
});

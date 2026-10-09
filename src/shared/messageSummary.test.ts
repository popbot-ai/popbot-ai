import { describe, expect, it } from 'vitest';
import { firstSentence } from './messageSummary';

describe('a message with no summary, folded', () => {
  it('shows its first sentence', () => {
    expect(firstSentence('Can you check the build? It failed twice.')).toBe('Can you check the build?');
    expect(firstSentence('\n\nFirst line only\nsecond line')).toBe('First line only');
    expect(firstSentence('Version 1.2 shipped. Next up: docs.')).toBe('Version 1.2 shipped.');
  });

  it('cuts a long one short', () => {
    const long = 'word '.repeat(60).trim();
    const out = firstSentence(long);
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

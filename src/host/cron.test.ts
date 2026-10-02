import { describe, expect, it } from 'vitest';
import { cronMatches, cronProblem } from './cron';

const at = (iso: string): Date => new Date(iso);

describe('bot cron schedules', () => {
  it('accepts the usual shapes and names what is wrong with the rest', () => {
    for (const ok of ['* * * * *', '0 9 * * 1-5', '*/15 * * * *', '0,30 8-18 * * *', '5/10 * * * *', '0 0 1 * 7']) {
      expect(cronProblem(ok), ok).toBeNull();
    }
    expect(cronProblem('')).toBe('empty');
    expect(cronProblem('0 9 * *')).toMatch(/five fields/);
    expect(cronProblem('60 * * * *')).toMatch(/minute/);
    expect(cronProblem('0 9 * * mon')).toMatch(/day of week/);
  });

  it('fires on matching minutes only', () => {
    // 2026-10-05 is a Monday.
    expect(cronMatches('0 9 * * 1-5', at('2026-10-05T09:00:30'))).toBe(true);
    expect(cronMatches('0 9 * * 1-5', at('2026-10-05T09:01:00'))).toBe(false);
    expect(cronMatches('0 9 * * 1-5', at('2026-10-04T09:00:00'))).toBe(false); // Sunday
    expect(cronMatches('*/15 * * * *', at('2026-10-05T10:45:00'))).toBe(true);
    expect(cronMatches('*/15 * * * *', at('2026-10-05T10:46:00'))).toBe(false);
    expect(cronMatches('5/10 * * * *', at('2026-10-05T10:25:00'))).toBe(true);
  });

  it('treats 7 as Sunday and either restricted day field as enough', () => {
    expect(cronMatches('0 0 * * 7', at('2026-10-04T00:00:00'))).toBe(true);
    // The 1st of the month OR a Monday.
    expect(cronMatches('0 0 1 * 1', at('2026-10-05T00:00:00'))).toBe(true);
    expect(cronMatches('0 0 1 * 1', at('2026-10-01T00:00:00'))).toBe(true);
    expect(cronMatches('0 0 1 * 1', at('2026-10-02T00:00:00'))).toBe(false);
  });
});

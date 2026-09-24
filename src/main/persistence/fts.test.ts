import { describe, expect, it } from 'vitest';
import { ftsQueryFor, searchMessagesSql } from './fts';

describe('ftsQueryFor', () => {
  it('quotes a plain query as one phrase — a substring match on a trigram index', () => {
    expect(ftsQueryFor('sendAndWait')).toBe('"sendAndWait"');
    expect(ftsQueryFor('  login bug ')).toBe('"login bug"');
    expect(ftsQueryFor('say "hi"')).toBe('"say ""hi"""');
  });

  it('refuses queries shorter than a trigram, and empty ones in either mode', () => {
    expect(ftsQueryFor('ab')).toBeNull();
    expect(ftsQueryFor('   ')).toBeNull();
    expect(ftsQueryFor('', 'fts')).toBeNull();
  });

  it('passes FTS5 syntax through untouched in fts mode', () => {
    expect(ftsQueryFor('login AND (bug OR error)', 'fts')).toBe('login AND (bug OR error)');
  });
});

describe('searchMessagesSql', () => {
  it('filters by chat ids and closed state as asked', () => {
    const all = searchMessagesSql({ chatIdCount: 0, includeClosed: true });
    expect(all).not.toContain('closed_at');
    expect(all).not.toContain('chat_id IN');
    const scoped = searchMessagesSql({ chatIdCount: 2, includeClosed: false });
    expect(scoped).toContain('c.closed_at IS NULL');
    expect(scoped).toContain('m.chat_id IN (?, ?)');
    expect(scoped).toContain('MATCH ?');
    expect(scoped.trim().endsWith('LIMIT ?')).toBe(true);
  });
});

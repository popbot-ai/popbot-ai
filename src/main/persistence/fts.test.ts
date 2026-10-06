import { describe, expect, it } from 'vitest';
import { ftsQueryFor, searchChatsQuery, searchMessagesSql } from './fts';

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

// node:sqlite (Node 22.5+) runs the real query, FTS5 trigram index and
// all; on an older Node (CI's 20) this suite skips.
let DatabaseSync: (new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>>; run(...params: unknown[]): unknown };
}) | null = null;
try {
  DatabaseSync = (await import('node:sqlite')).DatabaseSync as unknown as typeof DatabaseSync;
} catch {
  DatabaseSync = null;
}

describe.skipIf(!DatabaseSync)('searchChatsQuery — the chat list search', () => {
  function search(q: string, limit = 50): string[] {
    const d = new DatabaseSync!(':memory:');
    d.exec(`
      CREATE TABLE chats (id TEXT PRIMARY KEY, name TEXT, ticket TEXT, branch TEXT, snippet TEXT,
        closed_at INTEGER, deleted_at INTEGER, last_active_at INTEGER);
      CREATE VIRTUAL TABLE messages_fts USING fts5(text, chat_id UNINDEXED, tokenize = 'trigram');
    `);
    const chat = d.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?, NULL, ?)');
    const line = d.prepare('INSERT INTO messages_fts (text, chat_id) VALUES (?, ?)');
    // The chat named for it: closed, and older than everything else.
    chat.run('named', 'bill-review', null, null, '', 1, 100);
    // Many newer, open chats that only mention billing in their transcript.
    for (let i = 0; i < 60; i += 1) {
      chat.run(`mention${i}`, `chat ${i}`, null, null, '', null, 1000 + i);
      line.run('we looked at the billing page again', `mention${i}`);
    }
    // One whose branch matches, one whose latest message does.
    chat.run('branch', 'checkout work', null, 'fix/billing-cap', '', null, 500);
    chat.run('snippet', 'pricing', null, null, 'Bill totals look right now', null, 600);
    // A deleted chat named for it never shows.
    d.exec("INSERT INTO chats VALUES ('gone', 'old bill chat', NULL, NULL, '', NULL, 5, 2000)");
    const built = searchChatsQuery(q, limit, { columns: 'c.id', from: 'FROM chats c' })!;
    return d.prepare(built.sql).all(...built.params).map((r) => String(r.id));
  }

  it('puts a chat named for the text first, ahead of newer open chats that only mention it', () => {
    const ids = search('BILL');
    expect(ids[0]).toBe('named');
    expect(ids.slice(1, 3)).toEqual(['branch', 'snippet']);
    expect(ids.slice(3).every((id) => id.startsWith('mention'))).toBe(true);
    expect(ids).not.toContain('gone');
  });

  it('keeps the named chat even when transcript matches would fill the list', () => {
    expect(search('bill', 5)).toEqual(['named', 'branch', 'snippet', 'mention59', 'mention58']);
  });

  it('still finds a chat by a line of its transcript alone', () => {
    expect(search('billing page', 100)).toHaveLength(60);
  });
});

import { describe, expect, it } from 'vitest';
import type { MessageRecord } from '@shared/persistence';
import { renderTranscript, searchTranscript, transcriptEntries, transcriptPlainText } from './transcript';

const row = (i: number, role: MessageRecord['role'], kind: MessageRecord['kind'], body: unknown): MessageRecord => ({
  id: `msg_${i}`, chatId: 'chat_1', role, kind, body: JSON.stringify(body), createdAt: 1_700_000_000_000 + i * 1000, updatedAt: 0,
});

const rows: MessageRecord[] = [
  row(0, 'user', 'text', { text: 'Please fix the login bug.' }),
  row(1, 'agent', 'tool', { name: 'Bash', args: { command: 'npm test' }, result: '3 passing', isError: false }),
  row(2, 'agent', 'text', { text: 'The login bug is in auth.ts; fixed and tests pass.' }),
  row(3, 'system', 'system', { text: 'fork: Forked from “x”.' }),
  row(4, 'user', 'text', { text: 'Now the logout bug too.', attachments: [{ id: 'a' }] }),
];

describe('transcriptEntries', () => {
  it('flattens rows, summarizes tools, and can leave tools and system rows out', () => {
    const all = transcriptEntries(rows);
    expect(all.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
    expect(all[1].text).toBe('[tool Bash] {"command":"npm test"}\n→ 3 passing');
    expect(all[4].text).toBe('Now the logout bug too. [1 attachment(s)]');
    const prose = transcriptEntries(rows, { includeTools: false, includeSystem: false });
    expect(prose.map((e) => e.index)).toEqual([0, 2, 4]);
  });
});

describe('renderTranscript', () => {
  it('renders a numbered range and truncates with a note', () => {
    const entries = transcriptEntries(rows);
    const r = renderTranscript(entries, { from: 2, to: 4 });
    expect(r.count).toBe(3);
    expect(r.text.startsWith('#2 agent @ 20')).toBe(true);
    expect(r.text).toContain('#4 user @');
    const t = renderTranscript(entries, { maxChars: 120 });
    expect(t.truncated).toBe(true);
    expect(t.text).toContain('more entries');
  });
});

describe('searchTranscript', () => {
  it('finds every occurrence with context, case-insensitively by default', () => {
    const entries = transcriptEntries(rows);
    const hits = searchTranscript(entries, 'bug', { contextChars: 10 });
    expect(hits.map((h) => h.index)).toEqual([0, 2, 4]);
    expect(hits[0]).toMatchObject({ before: 'the login ', match: 'bug', after: '.' });
    expect(searchTranscript(entries, 'BUG', { caseSensitive: true })).toEqual([]);
    expect(searchTranscript(entries, 'bug', { maxResults: 2 })).toHaveLength(2);
  });
});

describe('transcriptPlainText', () => {
  it('prefixes each entry with its index and role', () => {
    expect(transcriptPlainText(transcriptEntries(rows).slice(0, 1))).toBe('[#0 user] Please fix the login bug.');
  });
});

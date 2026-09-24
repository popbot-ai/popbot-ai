import { describe, expect, it } from 'vitest';
import { parseSearchQuery, withSearchDefaults } from './searchQuery';

const DAY = 24 * 60 * 60 * 1000;

describe('parseSearchQuery', () => {
  it('separates tags from the text to search', () => {
    const p = parseSearchQuery('ticket:eng-123 timeout in auth from:user last:week');
    expect(p.text).toBe('timeout in auth');
    expect(p.filters).toEqual({ ticket: 'ENG-123', from: ['user'], lastMs: 7 * DAY });
    expect(p.hasFilters).toBe(true);
  });

  it('treats bare ticket: and cr: as "any such chat" and numbers as one PR', () => {
    expect(parseSearchQuery('ticket: login').filters).toEqual({ ticket: true });
    expect(parseSearchQuery('cr: flaky').filters).toEqual({ cr: true });
    expect(parseSearchQuery('pr:67 flaky').filters).toEqual({ cr: 67 });
  });

  it('understands duration words and counts', () => {
    expect(parseSearchQuery('last:month x').filters.lastMs).toBe(30 * DAY);
    expect(parseSearchQuery('last:3d x').filters.lastMs).toBe(3 * DAY);
    expect(parseSearchQuery('since:2w x').filters.lastMs).toBe(14 * DAY);
    // Not a duration: stays text.
    expect(parseSearchQuery('last:tuesday').text).toBe('last:tuesday');
  });

  it('collects who wrote it, tools, agent, archive scope, chat and repo', () => {
    const p = parseSearchQuery('from:user,agent tool:Bash agent:Codex in:archive chat:"login bug" repo:app boom');
    expect(p.filters).toEqual({ from: ['user', 'agent'], tool: 'Bash', agent: 'codex', in: 'archive', chat: 'login bug', repo: 'app' });
    expect(p.text).toBe('boom');
    expect(parseSearchQuery('tool: x').filters).toEqual({ from: ['tool'] });
    // A quoted value with no spaces keeps no quotes either.
    expect(parseSearchQuery('timeout chat:"[cr]"').filters).toEqual({ chat: '[cr]' });
    expect(parseSearchQuery('timeout chat:"[cr]"').text).toBe('timeout');
  });

  it('covers user and agent messages unless from: says otherwise', () => {
    expect(withSearchDefaults({}).from).toEqual(['user', 'agent']);
    expect(withSearchDefaults({ ticket: true }).from).toEqual(['user', 'agent']);
    expect(withSearchDefaults({ from: ['tool'] }).from).toEqual(['tool']);
  });

  it('leaves unknown key:value pairs — a URL — as text', () => {
    const p = parseSearchQuery('https://example.com/x foo:bar');
    expect(p.text).toBe('https://example.com/x foo:bar');
    expect(p.hasFilters).toBe(false);
  });
});

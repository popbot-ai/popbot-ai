import { afterEach, describe, expect, it } from 'vitest';
import {
  activeClaudeAccount,
  activeClaudeToken,
  adoptEnvClaudeToken,
  clearClaudeAccountRefused,
  noteClaudeAccountRefused,
  onActiveClaudeTokenChange,
  onClaudeAccountRefused,
  refusedClaudeAccounts,
  setClaudeAccounts,
} from './claudeAuth';

afterEach(() => {
  setClaudeAccounts([], null);
});

describe('Claude account in memory', () => {
  it('runs on the active account, and nothing without one', () => {
    expect(activeClaudeToken()).toBeNull();
    setClaudeAccounts([{ id: 'a', label: 'Work', token: 'tok-a' }, { id: 'b', label: 'Home', token: 'tok-b' }], 'b');
    expect(activeClaudeToken()).toBe('tok-b');
    expect(activeClaudeAccount()).toEqual({ id: 'b', label: 'Home' });
    // An active id that names no account is no account.
    setClaudeAccounts([{ id: 'a', label: 'Work', token: 'tok-a' }], 'gone');
    expect(activeClaudeToken()).toBeNull();
  });

  it('tells listeners only when the active token changes', () => {
    const heard: Array<string | null> = [];
    const off = onActiveClaudeTokenChange((t) => heard.push(t));
    const accounts = [{ id: 'a', label: 'Work', token: 'tok-a' }, { id: 'b', label: 'Home', token: 'tok-b' }];
    expect(setClaudeAccounts(accounts, 'a')).toBe(true);
    // The same again — a periodic re-send from the desktop — is quiet.
    expect(setClaudeAccounts(accounts, 'a')).toBe(false);
    // A rename of the active account is not a change of token.
    expect(setClaudeAccounts([{ ...accounts[0], label: 'Office' }, accounts[1]], 'a')).toBe(false);
    expect(setClaudeAccounts(accounts, 'b')).toBe(true);
    off();
    expect(heard).toEqual(['tok-a', 'tok-b']);
  });

  it('takes a host’s own CLAUDE_CODE_OAUTH_TOKEN as the fallback, out of the environment', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-env';
    adoptEnvClaudeToken();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(activeClaudeToken()).toBe('tok-env');
    // A desktop's accounts take over; with none active, the fallback applies again.
    setClaudeAccounts([{ id: 'a', label: 'Work', token: 'tok-a' }], 'a');
    expect(activeClaudeToken()).toBe('tok-a');
    setClaudeAccounts([], null);
    expect(activeClaudeToken()).toBe('tok-env');
  });
});

describe('out of usage', () => {
  const three = [
    { id: 'a', label: 'One', token: 'tok-a' },
    { id: 'b', label: 'Two', token: 'tok-b' },
    { id: 'c', label: 'Three', token: 'tok-c' },
  ];

  it('moves to the next account that has usage, and gives up only when none has', async () => {
    const { failOverFromExhausted, exhaustedAccounts, noteExhausted } = await import('./claudeAuth');
    const now = 1_000_000;
    // Start clean: no marks from another test.
    for (const id of Object.keys(exhaustedAccounts(0))) noteExhausted({ [id]: 0 });
    setClaudeAccounts(three, 'a');
    const heard: Array<string | null> = [];
    const off = onActiveClaudeTokenChange((t) => heard.push(t));
    expect(failOverFromExhausted('a', now + 60_000, now)).toMatchObject({ kind: 'switched', to: 'b' });
    expect(activeClaudeToken()).toBe('tok-b');
    // Another chat on A failing a moment later doesn't move it again.
    expect(failOverFromExhausted('a', now + 60_000, now)).toMatchObject({ kind: 'switched', to: 'b' });
    expect(failOverFromExhausted('b', now + 30_000, now)).toMatchObject({ kind: 'switched', to: 'c' });
    expect(failOverFromExhausted('c', now + 90_000, now)).toEqual({ kind: 'none-left', earliestReset: now + 30_000 });
    off();
    expect(heard).toEqual(['tok-b', 'tok-c']);
  });

  it('never puts a host back on an account it knows is out', async () => {
    const { noteExhausted, isExhausted } = await import('./claudeAuth');
    const later = Date.now() + 60 * 60_000;
    noteExhausted({ a: later });
    expect(isExhausted('a')).toBe(true);
    // The desktop (not yet told) sends A as active: B is used instead.
    setClaudeAccounts(three, 'a');
    expect(activeClaudeToken()).toBe('tok-b');
  });

  it('has nothing to move to on the CLI’s own login', async () => {
    const { failOverFromExhausted } = await import('./claudeAuth');
    setClaudeAccounts([], null);
    expect(failOverFromExhausted(null, null)).toEqual({ kind: 'no-accounts' });
  });
});

describe('a refused sign-in', () => {
  const work = { id: 'w', label: 'Work', token: 'tok-w' };
  const home = { id: 'h', label: 'Home', token: 'tok-h' };
  /** When the accounts' tokens are set, in these tests. */
  const set = 5_000;

  it('marks the account whose sign-in a chat saw refused, and says so once', () => {
    setClaudeAccounts([work, home], 'w', set);
    const heard: string[] = [];
    const off = onClaudeAccountRefused((id) => heard.push(id));
    expect(refusedClaudeAccounts()).toEqual([]);
    noteClaudeAccountRefused('w', set + 1_000);
    expect(refusedClaudeAccounts()).toEqual(['w']);
    // Every later turn on it fails the same way: not news again.
    noteClaudeAccountRefused('w', set + 2_000);
    off();
    expect(heard).toEqual(['w']);
    // Nothing moves by itself: chats stay on the account until it is fixed.
    expect(activeClaudeToken()).toBe('tok-w');
  });

  it('ignores a session older than the account’s current token', () => {
    setClaudeAccounts([work, home], 'w', set);
    // A new sign-in for Work; a chat started before it is still on the old one.
    setClaudeAccounts([{ ...work, token: 'tok-w2' }, home], 'w', set + 10_000);
    noteClaudeAccountRefused('w', set + 9_999);
    expect(refusedClaudeAccounts()).toEqual([]);
    // A chat started on the new token counts.
    noteClaudeAccountRefused('w', set + 10_000);
    expect(refusedClaudeAccounts()).toEqual(['w']);
    // Home's token was not replaced, and the same accounts sent again (the
    // desktop's periodic re-send) make it no newer: the old chat counts.
    setClaudeAccounts([{ ...work, token: 'tok-w2' }, home], 'w', set + 20_000);
    noteClaudeAccountRefused('h', set + 9_999);
    expect(refusedClaudeAccounts().sort()).toEqual(['h', 'w']);
  });

  it('is cleared by a new token, and by nothing less', () => {
    setClaudeAccounts([work, home], 'w', set);
    noteClaudeAccountRefused('w', set + 1);
    noteClaudeAccountRefused('h', set + 1);
    // The same accounts again, a rename, a switch.
    setClaudeAccounts([work, home], 'w', set + 2);
    setClaudeAccounts([{ ...work, label: 'Office' }, home], 'h', set + 3);
    expect(refusedClaudeAccounts().sort()).toEqual(['h', 'w']);
    // A new token for Work clears Work, and only Work.
    setClaudeAccounts([{ ...work, token: 'tok-w2' }, home], 'h', set + 4);
    expect(refusedClaudeAccounts()).toEqual(['h']);
  });

  it('is cleared when the same token is checked again and works', () => {
    setClaudeAccounts([work], 'w', set);
    noteClaudeAccountRefused('w', set + 1);
    clearClaudeAccountRefused('w');
    expect(refusedClaudeAccounts()).toEqual([]);
    // Still the same token: a chat from before the check counts if it fails again.
    noteClaudeAccountRefused('w', set + 1);
    expect(refusedClaudeAccounts()).toEqual(['w']);
  });

  it('forgets an account that is removed, and never marks one it does not hold', () => {
    setClaudeAccounts([work, home], 'w', set);
    noteClaudeAccountRefused('h', set + 1);
    noteClaudeAccountRefused('gone', set + 1);
    expect(refusedClaudeAccounts()).toEqual(['h']);
    setClaudeAccounts([work], 'w', set + 2);
    expect(refusedClaudeAccounts()).toEqual([]);
    // Added back with the very same token, it starts clean and newly set.
    setClaudeAccounts([work, home], 'w', set + 10_000);
    noteClaudeAccountRefused('h', set + 5_000);
    expect(refusedClaudeAccounts()).toEqual([]);
  });
});

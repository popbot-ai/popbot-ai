import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The settings table and the OS's encrypted store, as the test sets them.
const settings = new Map<string, unknown>();
const keyring = { available: true };
const KEY = 'agent.claude.accounts';
const EXHAUSTED_KEY = 'agent.claude.exhausted';

vi.mock('../diagLog', () => ({ dlog: () => undefined }));
vi.mock('../persistence/settings', () => ({
  getSetting: (k: string) => settings.get(k) ?? null,
  // Through JSON, as the table keeps it: nothing stored is shared with the caller.
  setSetting: (k: string, v: unknown) => { settings.set(k, JSON.parse(JSON.stringify(v))); },
}));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keyring.available,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!keyring.available || !s.startsWith('sealed:')) throw new Error('cannot decrypt');
      return s.slice('sealed:'.length);
    },
  },
}));

const accounts = await import('./claudeAccounts');
const auth = await import('./claudeAuth');

const sealed = (token: string): string => Buffer.from(`sealed:${token}`, 'utf8').toString('base64');
const storedActive = (): string | null => (settings.get(KEY) as { activeId: string | null }).activeId;
const inUse = (): string | undefined => accounts.listClaudeAccounts().find((a) => a.active)?.label;
const id = (label: string): string => accounts.listClaudeAccounts().find((a) => a.label === label)!.id;
const soon = (): number => Date.now() + 60 * 60_000;

describe('Claude accounts, stored', () => {
  beforeEach(() => {
    settings.clear();
    keyring.available = true;
    accounts.loadClaudeAccounts();
  });

  it('shows as in use the account the chats moved to, and stores that', () => {
    accounts.addClaudeAccount('Work', 'tok-work');
    accounts.addClaudeAccount('Home', 'tok-home');
    accounts.addClaudeAccount('Team', 'tok-team');
    expect(inUse()).toBe('Work');
    // Home runs out while Work is in use; then Work is removed. Home is the
    // first that remains, but the chats go on to Team.
    auth.noteExhausted({ [id('Home')]: soon() });
    accounts.removeClaudeAccount(id('Work'));
    expect(auth.activeClaudeToken()).toBe('tok-team');
    expect(inUse()).toBe('Team');
    expect(storedActive()).toBe(id('Team'));
    expect(accounts.listClaudeAccounts().find((a) => a.label === 'Home')?.outOfUsageUntil).toBeGreaterThan(Date.now());
  });

  it('stores the move made at launch, so the next launch starts where the chats are', () => {
    settings.set(KEY, {
      activeId: 'acct_out',
      accounts: [
        { id: 'acct_out', label: 'Out', addedAt: 1, sealed: sealed('tok-out') },
        { id: 'acct_next', label: 'Next', addedAt: 2, sealed: sealed('tok-next') },
      ],
    });
    settings.set(EXHAUSTED_KEY, { acct_out: soon() });
    accounts.loadClaudeAccounts();
    expect(inUse()).toBe('Next');
    expect(storedActive()).toBe('acct_next');
  });

  it('never stores "none" over a choice, and says which sign-in cannot be read', () => {
    settings.set(KEY, {
      activeId: 'acct_lost',
      accounts: [
        { id: 'acct_lost', label: 'Lost', addedAt: 1, sealed: Buffer.from('from another computer').toString('base64') },
        { id: 'acct_fine', label: 'Fine', addedAt: 2, sealed: sealed('tok-fine') },
      ],
    });
    accounts.loadClaudeAccounts();
    // No chat can run on it, so nothing is in use — but the choice stands.
    expect(auth.activeClaudeToken()).toBeNull();
    expect(inUse()).toBeUndefined();
    expect(storedActive()).toBe('acct_lost');
    const list = accounts.listClaudeAccounts();
    expect(list.map((a) => a.unreadable ?? false)).toEqual([true, false]);
    // Renaming another account saves again; still nothing is put in its place.
    accounts.renameClaudeAccount('acct_fine', 'Good');
    expect(storedActive()).toBe('acct_lost');
  });

  it('flags an account whose sign-in a chat saw refused, until it has a sign-in that works', () => {
    accounts.addClaudeAccount('Work', 'tok-work');
    let told = 0;
    const off = accounts.onClaudeAccountsChange(() => { told += 1; });
    auth.noteClaudeAccountRefused(id('Work'), Date.now());
    expect(told).toBe(1);
    expect(accounts.listClaudeAccounts()[0].needsSignIn).toBe(true);
    // The very same token, checked and saved again, counts as one that works.
    accounts.setClaudeAccountToken(id('Work'), 'tok-work');
    expect(accounts.listClaudeAccounts()[0].needsSignIn).toBeUndefined();
    off();
  });

  it('marks an account a token check found out of usage, and leaves the chats where they are', () => {
    accounts.addClaudeAccount('Work', 'tok-work');
    const spare = accounts.addClaudeAccount('Spare', 'tok-spare');
    const until = soon();
    accounts.noteClaudeAccountOutOfUsage(spare.id, until);
    expect(inUse()).toBe('Work');
    expect(accounts.listClaudeAccounts().find((a) => a.label === 'Spare')?.outOfUsageUntil).toBe(until);
    expect(settings.get(EXHAUSTED_KEY)).toMatchObject({ [spare.id]: until });
    // The account in use found out of usage (its token replaced): the chats move on.
    const third = accounts.addClaudeAccount('Third', 'tok-third');
    accounts.noteClaudeAccountOutOfUsage(id('Work'), null);
    expect(inUse()).toBe('Third');
    expect(storedActive()).toBe(third.id);
  });

  it('keeps a token without the line break a wrapped terminal line put in it', () => {
    accounts.addClaudeAccount('Work', 'tok-\n  work\n');
    expect(auth.activeClaudeToken()).toBe('tok-work');
    accounts.setClaudeAccountToken(id('Work'), ' tok-work\n-2 ');
    expect(auth.activeClaudeToken()).toBe('tok-work-2');
  });

  it('refuses to keep a token where nothing can encrypt it, and says why', () => {
    accounts.addClaudeAccount('Work', 'tok-work');
    keyring.available = false;
    expect(accounts.claudeAccountsEncryptionAvailable()).toBe(false);
    for (const attempt of [
      () => accounts.addClaudeAccount('Home', 'tok-home'),
      () => accounts.setClaudeAccountToken(id('Work'), 'tok-work-2'),
    ]) {
      let caught: unknown;
      try { attempt(); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(accounts.ClaudeAccountError);
      expect((caught as InstanceType<typeof accounts.ClaudeAccountError>).reason).toBe('no-store');
    }
    expect(accounts.listClaudeAccounts()).toHaveLength(1);
  });
});

// The token goes to the CLI on file descriptor 3, which Windows has not.
describe.skipIf(process.platform === 'win32')('checking a token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'popbot-fake-claude-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  /** A stand-in for the Claude CLI: reads the token as the real one does,
   *  then says what the test has it say. */
  const fakeCli = (name: string, script: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\ntoken=$(cat <&3)\n${script}\n`, { mode: 0o755 });
    return path;
  };

  it('passes a token the CLI answers on', async () => {
    const cli = fakeCli('answers', '[ "$token" = "tok-good" ] && echo OK');
    expect(await accounts.verifyClaudeToken(cli, ' tok-good\n')).toEqual({ ok: true });
  });

  it('sends the token with nothing a wrapped terminal line put inside it', async () => {
    const cli = fakeCli('whole', '[ "$token" = "tok-good" ] && echo OK');
    expect(await accounts.verifyClaudeToken(cli, ' tok-\n   good\n')).toEqual({ ok: true });
  });

  it('asks for the event stream, and passes an account that is signed in but out of usage', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const events = [
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day' } },
      { type: 'result', is_error: true, api_error_status: 429, api_error_type: 'rate_limit_error', api_error: 'usage_limit_reached', result: 'You have hit your weekly limit' },
    ].map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(join(dir, 'out.jsonl'), `${events}\n`);
    // Without the flags there is no event stream to read: the fake says so by failing.
    const cli = fakeCli('out', `case "$*" in *"--output-format stream-json --verbose"*) cat "${join(dir, 'out.jsonl')}"; exit 1;; *) echo "no events asked for"; exit 2;; esac`);
    expect(await accounts.verifyClaudeToken(cli, 'tok')).toEqual({ ok: true, outOfUsage: { resetsAt: reset * 1000 } });
  });

  it('calls it refused when the CLI says the sign-in is no good, in the CLI’s words', async () => {
    const cli = fakeCli('refuses', 'echo "Failed to authenticate. API Error: 401 OAuth access token has expired." >&2; exit 1');
    expect(await accounts.verifyClaudeToken(cli, 'tok-old')).toEqual({
      ok: false,
      error: 'Failed to authenticate. API Error: 401 OAuth access token has expired.',
      refused: true,
    });
  });

  it('does not call any other failure a refusal', async () => {
    const cli = fakeCli('fails', 'echo "Credit balance is too low"; exit 1');
    expect(await accounts.verifyClaudeToken(cli, 'tok')).toEqual({ ok: false, error: 'Credit balance is too low' });
    const silent = fakeCli('silent', 'exit 3');
    expect(await accounts.verifyClaudeToken(silent, 'tok')).toEqual({ ok: false, error: 'the CLI exited 3' });
  });
});

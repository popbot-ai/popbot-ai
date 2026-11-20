import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel, type ClaudeAccountsResult, type ClaudeAccountsState, type ClaudeSignInEvent } from '@shared/ipc';
import type { ClaudeTokenCheck } from '../agents/claudeAccounts';
import type { SetupTokenEvent } from '../agents/claudeSetupToken';

// The window, the CLI and the hosts, as the test plays them. The accounts
// are the real module, over a settings table and a keyring held in memory.
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
/** What every window was sent. */
const pushed: Array<{ channel: string; payload: unknown }> = [];
/** What the window that started the sign-in was told. */
const told: ClaudeSignInEvent[] = [];
const settings = new Map<string, unknown>();
const keyring = { available: true };
const cli = {
  found: true,
  opensBrowser: false,
  /** The tokens checked, in order, and what each check answers. */
  checked: [] as string[],
  check: (_token: string): ClaudeTokenCheck | Promise<ClaudeTokenCheck> => ({ ok: true }),
  /** The sign-in running now: how it was started, and its voice. */
  run: null as null | { openBrowser: boolean; cancelled: boolean; say: (event: SetupTokenEvent) => void },
};
const hosts = { outdated: [] as string[], changed: (): void => undefined };

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => { pushed.push({ channel, payload }); } },
    }],
  },
  safeStorage: {
    isEncryptionAvailable: () => keyring.available,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').slice('sealed:'.length),
  },
}));
vi.mock('../diagLog', () => ({ dlog: () => undefined }));
vi.mock('../persistence/settings', () => ({
  getSetting: (k: string) => settings.get(k) ?? null,
  setSetting: (k: string, v: unknown) => { settings.set(k, JSON.parse(JSON.stringify(v))); },
}));
vi.mock('../agents/claudeProbe', () => ({
  probeClaude: async () => (cli.found ? { ok: true, binaryPath: '/bin/claude' } : { ok: false, error: 'claude: command not found' }),
}));
vi.mock('../agents/claudeSetupToken', () => ({
  runSetupToken: (_binary: string, opts: { openBrowser: boolean }, onEvent: (event: SetupTokenEvent) => void) => {
    const run = { openBrowser: opts.openBrowser, cancelled: false, say: onEvent };
    cli.run = run;
    return { sendCode: () => true, cancel: () => { run.cancelled = true; }, opensBrowser: cli.opensBrowser };
  },
}));
vi.mock('../agents/claudeAccountsSync', () => ({
  claudeAccountsOutdatedHosts: () => hosts.outdated,
  onClaudeAccountsOutdatedHostsChange: (l: () => void) => { hosts.changed = l; return () => undefined; },
}));
vi.mock('../agents/claudeAccounts', async (original) => ({
  ...(await original<typeof import('../agents/claudeAccounts')>()),
  verifyClaudeToken: async (_binary: string, token: string) => { cli.checked.push(token); return cli.check(token); },
}));

const { registerClaudeAccountsHandlers } = await import('./claudeAccounts');
const { loadClaudeAccounts } = await import('../agents/claudeAccounts');
const auth = await import('../agents/claudeAuth');
// As at launch (main/index.ts).
loadClaudeAccounts();
registerClaudeAccountsHandlers();

const sender = { isDestroyed: () => false, send: (_channel: string, event: ClaudeSignInEvent) => { told.push(event); } };
const call = async <T = ClaudeAccountsResult>(channel: string, ...args: unknown[]): Promise<T> =>
  (await handlers.get(channel)!({ sender }, ...args)) as T;
/** A browser sign-in that got as far as its token. */
const signInWith = async (token: string): Promise<void> => {
  await call(IpcChannel.ClaudeAccountsSignInStart, { openBrowser: false });
  cli.run!.say({ type: 'token', token });
};
const labels = (r: ClaudeAccountsState): string[] => r.accounts.map((a) => a.label);
const failure = (r: ClaudeAccountsResult): string | null => (r.ok ? null : r.reason);
const TOKEN = 'sk-ant-oat01-' + 'A1b2C3d4_-'.repeat(9);

beforeEach(async () => {
  await call(IpcChannel.ClaudeAccountsSignInCancel);
  for (const a of (await call<ClaudeAccountsState>(IpcChannel.ClaudeAccountsList)).accounts) await call(IpcChannel.ClaudeAccountsRemove, a.id);
  Object.assign(cli, { found: true, opensBrowser: false, checked: [], check: () => ({ ok: true }), run: null });
  keyring.available = true;
  hosts.outdated = [];
  pushed.length = 0;
  told.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a sign-in PopBot ran, saved as an account', () => {
  it('keeps the token until its check passes, so a failed check can be run again', async () => {
    await signInWith(TOKEN);
    expect(told).toEqual([{ type: 'token-ready' }]);

    cli.check = () => ({ ok: false, error: 'The Claude CLI gave no answer in 90 seconds.', timedOut: true });
    const first = await call(IpcChannel.ClaudeAccountsAddSignedIn, 'Work');
    expect(failure(first)).toBe('timeout');
    expect(labels(first)).toEqual([]);

    // "Check again": the same sign-in, no second trip through the browser.
    cli.check = () => ({ ok: true });
    const again = await call(IpcChannel.ClaudeAccountsAddSignedIn, 'Work');
    expect(again.ok).toBe(true);
    expect(labels(again)).toEqual(['Work']);
    expect(cli.checked).toEqual([TOKEN, TOKEN]);
    expect(auth.activeClaudeToken()).toBe(TOKEN);

    // Saved, it is used up.
    expect(failure(await call(IpcChannel.ClaudeAccountsAddSignedIn, 'Twice'))).toBe('sign-in-gone');
    // And at no point did the token itself go to a window.
    expect(JSON.stringify([told, pushed, first, again])).not.toContain(TOKEN.slice(0, 24));
  });

  it('replaces an account’s sign-in the same way', async () => {
    const { accounts: [work] } = await call<ClaudeAccountsState>(IpcChannel.ClaudeAccountsAdd, 'Work', 'tok-old');
    await signInWith(TOKEN);
    cli.check = () => ({ ok: false, error: 'Failed to authenticate. API Error: 401', refused: true });
    expect(failure(await call(IpcChannel.ClaudeAccountsSetTokenSignedIn, work.id))).toBe('refused');
    // The old sign-in is still in place.
    expect(auth.activeClaudeToken()).toBe('tok-old');
    cli.check = () => ({ ok: true });
    expect((await call(IpcChannel.ClaudeAccountsSetTokenSignedIn, work.id)).ok).toBe(true);
    expect(auth.activeClaudeToken()).toBe(TOKEN);
  });

  it('lets the token go when the sign-in is cancelled, started again, or left too long', async () => {
    await signInWith(TOKEN);
    await call(IpcChannel.ClaudeAccountsSignInCancel);
    expect(failure(await call(IpcChannel.ClaudeAccountsAddSignedIn, 'Work'))).toBe('sign-in-gone');

    await signInWith(TOKEN);
    await call(IpcChannel.ClaudeAccountsSignInStart, { openBrowser: false });
    expect(failure(await call(IpcChannel.ClaudeAccountsAddSignedIn, 'Work'))).toBe('sign-in-gone');

    vi.useFakeTimers();
    await signInWith(TOKEN);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(failure(await call(IpcChannel.ClaudeAccountsAddSignedIn, 'Work'))).toBe('sign-in-gone');
    // Nothing was checked, and nothing saved.
    expect(cli.checked).toEqual([]);
    expect(labels(await call<ClaudeAccountsState>(IpcChannel.ClaudeAccountsList))).toEqual([]);
  });

  it('finishes a check already running when the sign-in is cancelled, and never saves one sign-in twice', async () => {
    let answer: (check: ClaudeTokenCheck) => void = () => undefined;
    cli.check = () => new Promise<ClaudeTokenCheck>((resolve) => { answer = resolve; });
    await signInWith(TOKEN);
    const saving = call(IpcChannel.ClaudeAccountsAddSignedIn, 'Work');
    // A second click while the first is still checking.
    expect(failure(await call(IpcChannel.ClaudeAccountsAddSignedIn, 'Work'))).toBe('other');
    // The window goes away, and a new sign-in finishes before the check does.
    await call(IpcChannel.ClaudeAccountsSignInCancel);
    await signInWith('sk-ant-oat01-second-sign-in-token');
    await vi.waitFor(() => expect(cli.checked).toEqual([TOKEN]));
    answer({ ok: true });
    expect(labels(await saving)).toEqual(['Work']);

    // The newer sign-in was not dropped along with the one just saved.
    cli.check = () => ({ ok: true });
    expect(labels(await call(IpcChannel.ClaudeAccountsAddSignedIn, 'Home'))).toEqual(['Work', 'Home']);
    expect(cli.checked).toEqual([TOKEN, 'sk-ant-oat01-second-sign-in-token']);
  });

  it('says whether the CLI opened a browser by itself, and passes on a sign-in it could not read', async () => {
    expect(await call(IpcChannel.ClaudeAccountsSignInStart, { openBrowser: false })).toEqual({ ok: true, cliOpensBrowser: false });
    expect(cli.run!.openBrowser).toBe(false);
    cli.opensBrowser = true;
    expect(await call(IpcChannel.ClaudeAccountsSignInStart, { openBrowser: false })).toEqual({ ok: true, cliOpensBrowser: true });

    const unread: ClaudeSignInEvent = { type: 'failed', message: 'Claude finished the sign-in, but PopBot could not read the token it printed.', reason: 'no-token' };
    cli.run!.say(unread as SetupTokenEvent);
    expect(told.at(-1)).toEqual(unread);

    cli.found = false;
    expect(await call(IpcChannel.ClaudeAccountsSignInStart)).toEqual({ ok: false, error: 'claude: command not found' });
  });

  it('starts no CLI for a sign-in cancelled while the CLI was still being looked for', async () => {
    // The start awaits the probe; the cancel lands before it answers.
    const starting = call(IpcChannel.ClaudeAccountsSignInStart, { openBrowser: false });
    await call(IpcChannel.ClaudeAccountsSignInCancel);
    expect(await starting).toEqual({ ok: false, error: 'The sign-in was cancelled.' });
    expect(cli.run).toBeNull();

    // Two starts in a row: only the second one runs.
    const first = call(IpcChannel.ClaudeAccountsSignInStart, { openBrowser: false });
    const second = call(IpcChannel.ClaudeAccountsSignInStart, { openBrowser: false });
    expect(await first).toEqual({ ok: false, error: 'The sign-in was cancelled.' });
    expect(await second).toEqual({ ok: true, cliOpensBrowser: false });
    expect(cli.run!.cancelled).toBe(false);
  });
});

describe('why an accounts action failed', () => {
  it('gives a reason the window can word, and only the CLI’s own text as the detail', async () => {
    cli.check = () => ({ ok: false, error: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', refused: true });
    const refused = await call(IpcChannel.ClaudeAccountsAdd, 'Work', 'tok');
    expect(refused).toMatchObject({ ok: false, reason: 'refused', error: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' });

    cli.check = () => ({ ok: false, error: 'no answer', timedOut: true });
    expect(failure(await call(IpcChannel.ClaudeAccountsAdd, 'Work', 'tok'))).toBe('timeout');
    cli.check = () => ({ ok: false, error: 'Credit balance is too low' });
    expect(failure(await call(IpcChannel.ClaudeAccountsAdd, 'Work', 'tok'))).toBe('other');

    cli.found = false;
    expect(await call(IpcChannel.ClaudeAccountsAdd, 'Work', 'tok')).toMatchObject({ reason: 'no-cli', error: 'claude: command not found' });
    cli.found = true;

    cli.check = () => ({ ok: true });
    keyring.available = false;
    const noStore = await call(IpcChannel.ClaudeAccountsAdd, 'Work', 'tok');
    expect(failure(noStore)).toBe('no-store');
    expect(noStore.encryptionAvailable).toBe(false);
    keyring.available = true;

    expect(failure(await call(IpcChannel.ClaudeAccountsSetTokenSignedIn, 'acct_any'))).toBe('sign-in-gone');
    expect(failure(await call(IpcChannel.ClaudeAccountsSetActive, 'acct_nobody'))).toBe('other');
    expect(failure(await call(IpcChannel.ClaudeAccountsAdd, 'Work', '  \n'))).toBe('other');
    // None of that saved anything.
    expect(labels(await call<ClaudeAccountsState>(IpcChannel.ClaudeAccountsList))).toEqual([]);
  });

  it('takes a token with the line breaks and spaces a terminal put inside it', async () => {
    const result = await call(IpcChannel.ClaudeAccountsAdd, 'Work', '  sk-ant-oat01-AAAA\n    BBBB\r\nCCCC \n');
    expect(result.ok).toBe(true);
    expect(cli.checked).toEqual(['sk-ant-oat01-AAAABBBBCCCC']);
    expect(auth.activeClaudeToken()).toBe('sk-ant-oat01-AAAABBBBCCCC');
  });
});

describe('an account that is signed in but out of usage', () => {
  const HOUR = 60 * 60_000;
  const list = async (): Promise<ClaudeAccountsState['accounts']> => (await call<ClaudeAccountsState>(IpcChannel.ClaudeAccountsList)).accounts;

  it('is added all the same, marked out until its reset, and the chats stay where they are', async () => {
    await call(IpcChannel.ClaudeAccountsAdd, 'Work', `${TOKEN}work`);
    const until = Date.now() + 40 * HOUR;
    cli.check = () => ({ ok: true, outOfUsage: { resetsAt: until } });
    const added = await call(IpcChannel.ClaudeAccountsAdd, 'Spare', `${TOKEN}spare`);
    expect(added.ok).toBe(true);
    const [work, spare] = added.accounts;
    expect(work).toMatchObject({ label: 'Work', active: true });
    expect(work.outOfUsageUntil).toBeUndefined();
    expect(spare).toMatchObject({ label: 'Spare', active: false, outOfUsageUntil: until });
    expect(auth.activeClaudeToken()).toBe(`${TOKEN}work`);
  });

  it('is marked when its sign-in came from the browser, and when its token is replaced', async () => {
    await call(IpcChannel.ClaudeAccountsAdd, 'Work', `${TOKEN}work`);
    cli.check = () => ({ ok: true, outOfUsage: { resetsAt: null } });
    await signInWith(`${TOKEN}browser`);
    expect((await call(IpcChannel.ClaudeAccountsAddSignedIn, 'Browser')).ok).toBe(true);
    const browser = (await list()).find((a) => a.label === 'Browser')!;
    // No reset given: out for the usual while.
    expect(browser.outOfUsageUntil).toBeGreaterThan(Date.now() + HOUR);

    // The account in use gets a token whose account is out: the chats move to one that isn't.
    cli.check = (token) => (token.endsWith('fresh') ? { ok: true } : { ok: true, outOfUsage: { resetsAt: null } });
    await call(IpcChannel.ClaudeAccountsAdd, 'Fresh', `${TOKEN}fresh`);
    const work = (await list()).find((a) => a.label === 'Work')!;
    expect(work.active).toBe(true);
    await call(IpcChannel.ClaudeAccountsSetToken, work.id, `${TOKEN}work2`);
    const after = await list();
    expect(after.find((a) => a.label === 'Work')).toMatchObject({ active: false });
    expect(after.find((a) => a.label === 'Work')!.outOfUsageUntil).toBeGreaterThan(Date.now());
    expect(after.find((a) => a.label === 'Fresh')).toMatchObject({ active: true });
  });
});

describe('what every window is told', () => {
  const changes = (): ClaudeAccountsState[] =>
    pushed.filter((p) => p.channel === IpcChannel.ClaudeAccountsChanged).map((p) => p.payload as ClaudeAccountsState);

  it('hears each change to the accounts as it happens', async () => {
    const added = await call(IpcChannel.ClaudeAccountsAdd, 'Work', 'tok-work');
    expect(changes().at(-1)).toEqual({ accounts: added.accounts, encryptionAvailable: true });
    expect(added.accounts).toMatchObject([{ label: 'Work', active: true }]);

    // A chat's sign-in refused: nobody asked, the window hears all the same.
    pushed.length = 0;
    auth.noteClaudeAccountRefused(added.accounts[0].id, Date.now() + 1);
    expect(changes()).toHaveLength(1);
    expect(changes()[0].accounts).toMatchObject([{ label: 'Work', needsSignIn: true }]);
  });

  it('hears which hosts are too old for accounts, and nothing about hosts otherwise', async () => {
    expect(await call<ClaudeAccountsState>(IpcChannel.ClaudeAccountsList)).toEqual({ accounts: [], encryptionAvailable: true });
    hosts.outdated = ['studio'];
    hosts.changed();
    expect(changes()).toEqual([{ accounts: [], encryptionAvailable: true, outdatedHosts: ['studio'] }]);
    expect((await call<ClaudeAccountsState>(IpcChannel.ClaudeAccountsList)).outdatedHosts).toEqual(['studio']);
  });
});

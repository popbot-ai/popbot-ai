import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel, type CodexAccountsResult, type CodexAccountsState, type CodexSignInEvent } from '@shared/ipc';
import { ScriptedCodex, fakeAuthJson } from '../agents/codexTestKit';

// The window, the Codex CLI and the hosts, as the test plays them. The
// accounts are the real module, over a settings table and a keyring held
// in memory; the sign-in is the real runner, against a scripted Codex.
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
const pushed: Array<{ channel: string; payload: unknown }> = [];
const told: CodexSignInEvent[] = [];
const opened: string[] = [];
const settings = new Map<string, unknown>();
const keyring = { available: true };
const cli = { found: true, codex: new ScriptedCodex() };
const hosts = { outdated: [] as string[], changed: (): void => undefined };

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => { pushed.push({ channel, payload }); } },
    }],
  },
  shell: { openExternal: async (url: string) => { opened.push(url); } },
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
vi.mock('../agents/codexProbe', () => ({
  probeCodex: async () => (cli.found ? { ok: true, binaryPath: '/bin/codex' } : { ok: false, error: 'codex: command not found' }),
}));
vi.mock('../agents/CodexAppServerBackend', () => ({
  resolveCodexBinary: (userPath: string | null) => ({ path: userPath ?? 'codex', pathDirs: [] }),
}));
vi.mock('../agents/codexAccountsSync', () => ({
  codexAccountsOutdatedHosts: () => hosts.outdated,
  onCodexAccountsOutdatedHostsChange: (l: () => void) => { hosts.changed = l; return () => undefined; },
}));
// The real sign-in runner, with the scripted Codex in place of the CLI.
vi.mock('../agents/codexSignIn', async (original) => {
  const real = await original<typeof import('../agents/codexSignIn')>();
  return {
    ...real,
    runCodexSignIn: (runner: import('../agents/codexSignIn').CodexHomeRunner, onEvent: Parameters<typeof real.runCodexSignIn>[1]) =>
      real.runCodexSignIn({ ...runner, connect: cli.codex.connect }, onEvent),
  };
});

const { registerCodexAccountsHandlers } = await import('./codexAccounts');
const { loadCodexAccounts } = await import('../agents/codexAccounts');
const auth = await import('../agents/codexAuth');
loadCodexAccounts();
registerCodexAccountsHandlers();

const sender = { isDestroyed: () => false, send: (_channel: string, event: CodexSignInEvent) => { told.push(event); } };
const call = async <T = CodexAccountsResult>(channel: string, ...args: unknown[]): Promise<T> =>
  (await handlers.get(channel)!({ sender }, ...args)) as T;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
let user = 0;
const someone = (): string => `ipc-user-${(user += 1)}`;
let serial = 0;
/** Start a sign-in and have the browser come back as `who` (each sign-in
 *  of the same account has tokens of its own, as a real one does). */
const signInAs = async (who: string, opts: { openBrowser?: boolean; email?: string } = {}): Promise<void> => {
  await call(IpcChannel.CodexAccountsSignInStart, { openBrowser: opts.openBrowser ?? false });
  await flush();
  cli.codex.finishLogin(fakeAuthJson({ user: who, email: opts.email ?? `${who}@example.com`, serial: (serial += 1) }));
  await flush();
};
const labels = (r: CodexAccountsState): string[] => r.accounts.map((a) => a.label);
const listed = (): Promise<CodexAccountsState> => call<CodexAccountsState>(IpcChannel.CodexAccountsList);

beforeEach(async () => {
  await call(IpcChannel.CodexAccountsSignInCancel);
  for (const a of (await listed()).accounts) await call(IpcChannel.CodexAccountsRemove, a.id);
  cli.found = true;
  cli.codex = new ScriptedCodex();
  keyring.available = true;
  hosts.outdated = [];
  pushed.length = 0;
  told.length = 0;
  opened.length = 0;
});

describe('adding a Codex account by signing in', () => {
  it('gives the window the sign-in page, then who signed in — never a token — and saves it under a name', async () => {
    const who = someone();
    expect(await call(IpcChannel.CodexAccountsSignInStart, { openBrowser: true })).toEqual({ ok: true });
    await flush();
    expect(told).toEqual([{ type: 'url', url: 'https://auth.example/authorize?x=1' }]);
    expect(opened).toEqual(['https://auth.example/authorize?x=1']);

    cli.codex.finishLogin(fakeAuthJson({ user: who, email: 'first@example.com', plan: 'pro' }));
    await flush();
    expect(told[1]).toEqual({ type: 'signed-in', email: 'first@example.com', plan: 'pro' });
    expect(JSON.stringify(told)).not.toMatch(/eyJ|rt\./);

    const added = await call(IpcChannel.CodexAccountsAddSignedIn, 'Work');
    expect(added.ok).toBe(true);
    expect(added.accounts).toMatchObject([{ label: 'Work', email: 'first@example.com', plan: 'pro', active: true }]);
    expect(auth.activeCodexAuth()).not.toBeNull();
    // Saved once: the same sign-in cannot be saved again.
    expect(await call(IpcChannel.CodexAccountsAddSignedIn, 'Twice')).toMatchObject({ ok: false, reason: 'sign-in-gone' });
  });

  it('leaves opening the page to the window when only the link was asked for', async () => {
    await call(IpcChannel.CodexAccountsSignInStart, { openBrowser: false });
    await flush();
    expect(told).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('says when the browser signed in to an account that is already here, and will not add it twice', async () => {
    const who = someone();
    await signInAs(who);
    const first = await call(IpcChannel.CodexAccountsAddSignedIn, 'Work');
    told.length = 0;
    await signInAs(who);
    expect(told[1]).toMatchObject({ type: 'signed-in', duplicateOf: first.accounts[0].id });
    expect(await call(IpcChannel.CodexAccountsAddSignedIn, 'Again')).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(labels(await listed())).toEqual(['Work']);
  });

  it('signs an account in again only with the same ChatGPT account', async () => {
    const who = someone();
    await signInAs(who);
    const work = (await call(IpcChannel.CodexAccountsAddSignedIn, 'Work')).accounts[0];
    const before = auth.activeCodexAuth()!.accessToken;

    await signInAs(someone(), { email: 'other@example.com' });
    const wrong = await call(IpcChannel.CodexAccountsRenewSignedIn, work.id);
    expect(wrong).toMatchObject({ ok: false, reason: 'mismatch' });
    expect(wrong.ok ? '' : wrong.error).toContain('other@example.com');
    expect(auth.activeCodexAuth()!.accessToken).toBe(before);

    await signInAs(who);
    expect((await call(IpcChannel.CodexAccountsRenewSignedIn, work.id)).ok).toBe(true);
    expect(auth.activeCodexAuth()!.accessToken).not.toBe(before);
  });

  it('passes on why a sign-in did not finish, and lets another start', async () => {
    await call(IpcChannel.CodexAccountsSignInStart, {});
    await flush();
    cli.codex.failLogin('You do not have access to Codex');
    await flush();
    expect(told[1]).toEqual({ type: 'failed', message: 'You do not have access to Codex' });
    expect(await call(IpcChannel.CodexAccountsAddSignedIn, 'Work')).toMatchObject({ ok: false, reason: 'sign-in-gone' });
    cli.codex = new ScriptedCodex();
    told.length = 0;
    await signInAs(someone());
    expect((await call(IpcChannel.CodexAccountsAddSignedIn, 'Work')).ok).toBe(true);
  });

  it('cancelled, forgets the sign-in — even one the browser had already finished', async () => {
    await signInAs(someone());
    await call(IpcChannel.CodexAccountsSignInCancel);
    expect(await call(IpcChannel.CodexAccountsAddSignedIn, 'Work')).toMatchObject({ ok: false, reason: 'sign-in-gone' });

    // Cancelled before the browser came back: what arrives later is not heard.
    told.length = 0;
    await call(IpcChannel.CodexAccountsSignInStart, {});
    await flush();
    const stale = cli.codex;
    await call(IpcChannel.CodexAccountsSignInCancel);
    stale.finishLogin(fakeAuthJson({ user: someone() }));
    await flush();
    expect(told).toHaveLength(1);
    expect(labels(await listed())).toEqual([]);
  });

  it('says so when there is no Codex to sign in with, or nowhere safe to keep a sign-in', async () => {
    cli.found = false;
    expect(await call(IpcChannel.CodexAccountsSignInStart, {})).toEqual({ ok: false, error: 'The Codex CLI is not installed.' });
    cli.found = true;
    keyring.available = false;
    expect(await call(IpcChannel.CodexAccountsSignInStart, {})).toMatchObject({ ok: false });
    expect((await listed()).encryptionAvailable).toBe(false);
  });
});

describe('what every window is told about Codex accounts', () => {
  const changes = (): CodexAccountsState[] =>
    pushed.filter((p) => p.channel === IpcChannel.CodexAccountsChanged).map((p) => p.payload as CodexAccountsState);

  it('hears of every change, with no token in it', async () => {
    await signInAs(someone());
    await call(IpcChannel.CodexAccountsAddSignedIn, 'Work');
    await signInAs(someone());
    const two = await call(IpcChannel.CodexAccountsAddSignedIn, 'Home');
    pushed.length = 0;
    await call(IpcChannel.CodexAccountsSetActive, two.accounts[1].id);
    await call(IpcChannel.CodexAccountsRename, two.accounts[1].id, 'Personal');
    expect(changes().at(-1)!.accounts.map((a) => [a.label, a.active])).toEqual([['Work', false], ['Personal', true]]);
    expect(JSON.stringify(pushed)).not.toMatch(/eyJ|rt\./);
  });

  it('names hosts too old for Codex accounts only once there are accounts to send', async () => {
    hosts.outdated = ['Old host'];
    expect((await listed()).outdatedHosts).toBeUndefined();
    await signInAs(someone());
    const added = await call(IpcChannel.CodexAccountsAddSignedIn, 'Work');
    expect(added.outdatedHosts).toEqual(['Old host']);
  });
});

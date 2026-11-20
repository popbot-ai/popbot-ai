import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptedCodex, fakeAuthJson, type FakeSignIn } from './codexTestKit';

// The settings table and the OS's encrypted store, as the test sets them.
const settings = new Map<string, unknown>();
const keyring = { available: true };
const KEY = 'agent.codex.accounts';
const EXHAUSTED_KEY = 'agent.codex.exhausted';

vi.mock('../diagLog', () => ({ dlog: () => undefined }));
vi.mock('../persistence/settings', () => ({
  getSetting: (k: string) => settings.get(k) ?? null,
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

const accounts = await import('./codexAccounts');
const auth = await import('./codexAuth');
const { readCodexAuthJson } = await import('./codexSignIn');
type SignedIn = import('./codexSignIn').CodexSignedIn;

const DAY = 24 * 3600_000;
let serial = 0;
/** A sign-in as codexSignIn.ts hands it over. Each test's users are its own. */
const signedIn = (o: FakeSignIn & { outOfUsageUntil?: number | null } = {}): SignedIn => {
  serial += 1;
  const authJson = fakeAuthJson({ serial, ...o });
  return { authJson, facts: readCodexAuthJson(authJson)!, outOfUsageUntil: o.outOfUsageUntil ?? null };
};
const list = () => accounts.listCodexAccounts();
const inUse = (): string | undefined => list().find((a) => a.active)?.label;
const id = (label: string): string => list().find((a) => a.label === label)!.id;
const storedTokenOf = (label: string): string => {
  const s = settings.get(KEY) as { accounts: Array<{ label: string; sealed: string }> };
  const sealed = s.accounts.find((a) => a.label === label)!.sealed;
  return readCodexAuthJson(Buffer.from(sealed, 'base64').toString('utf8').slice('sealed:'.length))!.accessToken;
};

let user = 0;
const someone = (): string => `user-${(user += 1)}`;

beforeEach(() => {
  settings.clear();
  keyring.available = true;
  accounts.loadCodexAccounts();
});

describe('Codex accounts, stored', () => {
  it('names an account by its email, makes the first one the account in use, and never shows a token', () => {
    const a = someone();
    const added = accounts.addCodexAccount('', signedIn({ user: a, email: 'first@example.com', plan: 'pro' }));
    expect(added).toMatchObject({ label: 'first@example.com', email: 'first@example.com', plan: 'pro', active: true });
    accounts.addCodexAccount('Spare', signedIn({ user: someone(), email: 'second@example.com', plan: 'plus' }));
    expect(list().map((x) => [x.label, x.active, x.plan])).toEqual([['first@example.com', true, 'pro'], ['Spare', false, 'plus']]);
    expect(JSON.stringify(list())).not.toMatch(/eyJ|rt\./);
    // What a Codex process is handed is the access token and the workspace.
    expect(auth.activeCodexAuth()).toMatchObject({ accessToken: storedTokenOf('first@example.com'), chatgptAccountId: 'ws-1', planType: 'pro' });
  });

  it('keeps the sign-in encrypted, not in plain text', () => {
    accounts.addCodexAccount('Work', signedIn({ user: someone() }));
    const raw = JSON.stringify(settings.get(KEY));
    expect(raw).not.toContain('rt.');
    expect(raw).not.toContain('access_token');
  });

  it('will not add the same ChatGPT account twice', () => {
    const u = someone();
    accounts.addCodexAccount('Work', signedIn({ user: u }));
    let caught: unknown;
    try { accounts.addCodexAccount('Again', signedIn({ user: u })); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(accounts.CodexAccountError);
    expect((caught as InstanceType<typeof accounts.CodexAccountError>).reason).toBe('duplicate');
    expect((caught as Error).message).toContain('Work');
    expect(list()).toHaveLength(1);
    expect(accounts.codexAccountHolding(signedIn({ user: u }).facts.identity)).toBe(id('Work'));
  });

  it('takes a new sign-in for an account only from the same ChatGPT account', () => {
    const u = someone();
    accounts.addCodexAccount('Work', signedIn({ user: u }));
    const before = storedTokenOf('Work');
    let caught: unknown;
    try { accounts.renewCodexAccount(id('Work'), signedIn({ user: someone(), email: 'other@example.com' })); } catch (err) { caught = err; }
    expect((caught as InstanceType<typeof accounts.CodexAccountError>).reason).toBe('mismatch');
    expect((caught as Error).message).toContain('other@example.com');
    expect(storedTokenOf('Work')).toBe(before);

    accounts.renewCodexAccount(id('Work'), signedIn({ user: u }));
    expect(storedTokenOf('Work')).not.toBe(before);
    expect(auth.activeCodexAuth()?.accessToken).toBe(storedTokenOf('Work'));
  });

  it('switches every chat when another account is chosen, and back to this computer’s own sign-in on "none"', () => {
    accounts.addCodexAccount('Work', signedIn({ user: someone() }));
    accounts.addCodexAccount('Home', signedIn({ user: someone() }));
    const heard: string[] = [];
    const off = auth.onActiveCodexAuthChange((c) => heard.push(c));
    accounts.setActiveCodexAccount(id('Home'));
    expect(inUse()).toBe('Home');
    accounts.setActiveCodexAccount(null);
    expect(inUse()).toBeUndefined();
    expect(auth.activeCodexAuth()).toBeNull();
    expect(heard).toEqual(['account', 'account']);
    off();
  });

  it('moves on when the account in use is removed', () => {
    accounts.addCodexAccount('Work', signedIn({ user: someone() }));
    accounts.addCodexAccount('Home', signedIn({ user: someone() }));
    accounts.removeCodexAccount(id('Work'));
    expect(inUse()).toBe('Home');
  });

  it('refuses to keep a sign-in where nothing can encrypt it', () => {
    keyring.available = false;
    let caught: unknown;
    try { accounts.addCodexAccount('Work', signedIn({ user: someone() })); } catch (err) { caught = err; }
    expect((caught as InstanceType<typeof accounts.CodexAccountError>).reason).toBe('no-store');
    expect(list()).toHaveLength(0);
  });

  it('says which sign-in cannot be read here, and runs nothing on it', () => {
    settings.set(KEY, {
      activeId: 'cdx_lost',
      accounts: [{ id: 'cdx_lost', label: 'Lost', email: null, plan: null, identity: 'x:y', addedAt: 1, sealed: Buffer.from('from another computer').toString('base64') }],
    });
    accounts.loadCodexAccounts();
    expect(list()[0]).toMatchObject({ unreadable: true, active: false });
    expect(auth.activeCodexAuth()).toBeNull();
  });
});

describe('a Codex account out of usage', () => {
  it('found so at sign-in: added all the same, marked, and the chats stay where they are', () => {
    accounts.addCodexAccount('Work', signedIn({ user: someone() }));
    const until = Date.now() + 2 * DAY;
    accounts.addCodexAccount('Spare', signedIn({ user: someone(), outOfUsageUntil: until }));
    expect(inUse()).toBe('Work');
    expect(list().find((a) => a.label === 'Spare')?.outOfUsageUntil).toBe(until);
    expect(settings.get(EXHAUSTED_KEY)).toMatchObject({ [id('Spare')]: until });
  });

  it('found so in a chat: every chat moves to the next account, and that is stored', () => {
    accounts.addCodexAccount('Work', signedIn({ user: someone() }));
    accounts.addCodexAccount('Home', signedIn({ user: someone() }));
    const outcome = accounts.failOverCodexAccount(id('Work'), Date.now() + DAY);
    expect(outcome).toMatchObject({ kind: 'switched', toLabel: 'Home' });
    expect(inUse()).toBe('Home');
    expect((settings.get(KEY) as { activeId: string }).activeId).toBe(id('Home'));
  });

  it('adopts what a host knows is out, and moves off it', () => {
    accounts.addCodexAccount('Work', signedIn({ user: someone() }));
    accounts.addCodexAccount('Home', signedIn({ user: someone() }));
    accounts.adoptExhaustedCodexAccounts({ [id('Work')]: Date.now() + DAY });
    expect(inUse()).toBe('Home');
  });
});

describe('keeping a sign-in renewed', () => {
  /** Codex, renewing: writes a newer sign-in for the same account. */
  const renewingCodex = (next: (was: string) => string | null, fail?: string): ScriptedCodex => {
    const codex = new ScriptedCodex();
    codex.answer = (method, _params, home) => {
      if (method !== 'account/read') return { result: {} };
      if (fail) return { error: { code: -32603, message: fail } };
      const fresh = next(home);
      if (fresh) writeFileSync(join(home, 'auth.json'), fresh);
      return { result: {} };
    };
    return codex;
  };
  const use = (codex: ScriptedCodex): void => accounts.startCodexAccountRenewal(async () => ({ codexPath: 'codex', connect: codex.connect }));

  it('renews an account whose token is close to its end, and leaves a fresh one alone', async () => {
    const u = someone();
    accounts.addCodexAccount('Old', signedIn({ user: u, expiresAt: Date.now() + 2 * DAY }));
    accounts.addCodexAccount('Fresh', signedIn({ user: someone(), expiresAt: Date.now() + 9 * DAY }));
    const oldToken = storedTokenOf('Old');
    const freshToken = storedTokenOf('Fresh');
    const codex = renewingCodex(() => fakeAuthJson({ user: u, serial: 900, expiresAt: Date.now() + 10 * DAY }));
    use(codex);
    const heard: string[] = [];
    const off = auth.onActiveCodexAuthChange((c) => heard.push(c));
    await accounts.renewDueCodexAccounts();
    expect(codex.methods.filter((m) => m === 'account/read')).toHaveLength(1);
    expect(storedTokenOf('Old')).not.toBe(oldToken);
    expect(storedTokenOf('Fresh')).toBe(freshToken);
    // The account in use has a newer token: nothing moves.
    expect(heard).toEqual(['token']);
    expect(auth.activeCodexAuth()?.accessToken).toBe(storedTokenOf('Old'));
    off();
  });

  it('marks an account whose sign-in OpenAI will not renew: it needs signing in again and nothing runs on it', async () => {
    const u = someone();
    accounts.addCodexAccount('Dead', signedIn({ user: u, expiresAt: Date.now() + DAY }));
    accounts.addCodexAccount('Fine', signedIn({ user: someone() }));
    use(renewingCodex(() => null, 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.'));
    await accounts.renewCodexAccountNow(id('Dead'));
    expect(list().find((a) => a.label === 'Dead')).toMatchObject({ needsSignIn: true });
    expect(accounts.codexAccountSecrets().accounts.map((a) => a.label)).toEqual(['Fine']);
    // Signed in again, it is whole.
    accounts.renewCodexAccount(id('Dead'), signedIn({ user: u }));
    expect(list().find((a) => a.label === 'Dead')?.needsSignIn).toBeUndefined();
    expect(accounts.codexAccountSecrets().accounts).toHaveLength(2);
  });

  it('keeps the sign-in it has when a renewal could not be tried', async () => {
    accounts.addCodexAccount('Work', signedIn({ user: someone(), expiresAt: Date.now() + DAY }));
    const before = storedTokenOf('Work');
    use(renewingCodex(() => null, 'error sending request: dns error'));
    await accounts.renewCodexAccountNow(id('Work'));
    expect(storedTokenOf('Work')).toBe(before);
    expect(list()[0].needsSignIn).toBeUndefined();
  });

  it('renews one account once however many ask at the same moment', async () => {
    const u = someone();
    accounts.addCodexAccount('Work', signedIn({ user: u, expiresAt: Date.now() + DAY }));
    const codex = renewingCodex(() => fakeAuthJson({ user: u, serial: 901 }));
    use(codex);
    await Promise.all([accounts.renewCodexAccountNow(id('Work')), accounts.renewCodexAccountNow(id('Work')), accounts.renewCodexAccountNow(id('Work'))]);
    expect(codex.methods.filter((m) => m === 'account/read')).toHaveLength(1);
  });

  it('gives a Codex process that was refused its token the renewed one', async () => {
    const u = someone();
    accounts.addCodexAccount('Work', signedIn({ user: u }));
    const stale = auth.activeCodexAuth()!.accessToken;
    use(renewingCodex(() => fakeAuthJson({ user: u, serial: 902 })));
    const next = await auth.freshCodexAuth(id('Work'), stale);
    expect(next?.accessToken).toBe(storedTokenOf('Work'));
    expect(next?.accessToken).not.toBe(stale);
  });
});

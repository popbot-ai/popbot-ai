import { beforeEach, describe, expect, it } from 'vitest';
import * as auth from './codexAuth';
import { fakeJwt } from './codexTestKit';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const acct = (id: string, token = `tok-${id}`): auth.CodexAccountSecret => ({ id, label: id.toUpperCase(), accessToken: token, chatgptAccountId: `ws-${id}`, planType: 'pro' });

beforeEach(() => {
  auth.setCodexAccounts([], null, NOW);
  auth.setCodexTokenRenewer(null);
});

describe('the Codex account in use', () => {
  it('is nothing until an account is chosen: this computer’s own sign-in applies', () => {
    expect(auth.activeCodexAuth()).toBeNull();
    auth.setCodexAccounts([acct('a')], null, NOW);
    expect(auth.activeCodexAuth()).toBeNull();
    expect(auth.activeCodexAccountId()).toBeNull();
  });

  it('hands a Codex process the account’s token and workspace', () => {
    auth.setCodexAccounts([acct('a'), acct('b')], 'b', NOW);
    expect(auth.activeCodexAuth()).toEqual({ accountId: 'b', accessToken: 'tok-b', chatgptAccountId: 'ws-b', planType: 'pro' });
    expect(auth.activeCodexAccount()).toEqual({ id: 'b', label: 'B' });
  });

  it('says whether the chats must move, or only have a newer token to ask for', () => {
    const heard: string[] = [];
    const off = auth.onActiveCodexAuthChange((c) => heard.push(c));
    expect(auth.setCodexAccounts([acct('a'), acct('b')], 'a', NOW)).toBe('account');   // accounts turned on
    expect(auth.setCodexAccounts([acct('a'), acct('b')], 'a', NOW)).toBeNull();        // nothing new
    expect(auth.setCodexAccounts([acct('a', 'tok-a2'), acct('b')], 'a', NOW)).toBe('token');   // renewed
    expect(auth.setCodexAccounts([acct('a', 'tok-a2'), acct('b', 'tok-b2')], 'a', NOW)).toBeNull();   // another account's token
    expect(auth.setCodexAccounts([acct('a', 'tok-a2'), acct('b', 'tok-b2')], 'b', NOW)).toBe('account');
    expect(auth.setCodexAccounts([acct('a', 'tok-a2'), acct('b', 'tok-b2')], null, NOW)).toBe('account');   // turned off
    expect(heard).toEqual(['account', 'token', 'account', 'account']);
    off();
  });

  it('leaves out an account with no token, and an active id that is not there', () => {
    auth.setCodexAccounts([acct('a'), { ...acct('b'), accessToken: '' }], 'b', NOW);
    expect(auth.activeCodexAuth()).toBeNull();
  });
});

describe('out of usage', () => {
  it('moves the chats to the next account that has some, and says so', () => {
    auth.setCodexAccounts([acct('a'), acct('b'), acct('c')], 'a', NOW);
    const heard: string[] = [];
    const off = auth.onActiveCodexAuthChange((c) => heard.push(c));
    expect(auth.failOverCodexFromExhausted('a', NOW + 3 * HOUR, NOW)).toEqual({ kind: 'switched', from: 'a', to: 'b', toLabel: 'B' });
    expect(auth.activeCodexAccountId()).toBe('b');
    expect(heard).toEqual(['account']);
    // Another chat on the old account reporting the same limit moves nothing more.
    expect(auth.failOverCodexFromExhausted('a', NOW + 3 * HOUR, NOW)).toMatchObject({ kind: 'switched', to: 'b' });
    expect(heard).toEqual(['account']);
    expect(auth.exhaustedCodexAccounts(NOW)).toEqual({ a: NOW + 3 * HOUR });
    off();
  });

  it('gives up only when every account is out, and says when the first is back', () => {
    auth.setCodexAccounts([acct('a'), acct('b')], 'a', NOW);
    auth.failOverCodexFromExhausted('a', NOW + 5 * HOUR, NOW);
    expect(auth.failOverCodexFromExhausted('b', NOW + 2 * HOUR, NOW)).toEqual({ kind: 'none-left', earliestReset: NOW + 2 * HOUR });
    expect(auth.activeCodexAccountId()).toBe('b');
  });

  it('has nowhere to move when no account is in use', () => {
    expect(auth.failOverCodexFromExhausted(null, null, NOW)).toEqual({ kind: 'no-accounts' });
  });

  it('counts an account as back once its time has passed, and guesses a time when none was given', () => {
    auth.setCodexAccounts([acct('a'), acct('b')], 'a', NOW);
    auth.failOverCodexFromExhausted('a', null, NOW);
    expect(auth.isCodexExhausted('a', NOW + HOUR)).toBe(true);
    expect(auth.isCodexExhausted('a', NOW + 6 * HOUR)).toBe(false);
  });

  it('will not be switched back onto an account known to be out (a desktop that has not heard yet)', () => {
    // What is out of usage is remembered for as long as the process runs:
    // accounts of this test's own.
    auth.setCodexAccounts([acct('x'), acct('y')], 'x', NOW);
    auth.noteCodexExhausted({ x: NOW + HOUR }, NOW);
    auth.setCodexAccounts([acct('x'), acct('y')], 'x', NOW);
    expect(auth.activeCodexAccountId()).toBe('y');
  });
});

describe('a token OpenAI turns down', () => {
  it('is answered with a newer one the account already has', async () => {
    auth.setCodexAccounts([acct('a', 'new')], 'a', NOW);
    expect(await auth.freshCodexAuth('a', 'old')).toMatchObject({ accessToken: 'new' });
    expect(auth.refusedCodexAccounts()).toEqual([]);
  });

  it('has the desktop renew the sign-in, once, and answers with what that gave', async () => {
    auth.setCodexAccounts([acct('a', 'old')], 'a', NOW);
    let asked = 0;
    auth.setCodexTokenRenewer(async (id) => {
      asked += 1;
      auth.setCodexAccounts([acct(id, 'renewed')], id, NOW);
    });
    expect(await auth.freshCodexAuth('a', 'old')).toMatchObject({ accessToken: 'renewed' });
    expect(asked).toBe(1);
  });

  it('marks the account refused when there is nothing newer to be had — and failover passes it by', async () => {
    auth.setCodexAccounts([acct('p'), acct('q'), acct('r')], 'p', NOW);
    const told: string[] = [];
    const off = auth.onCodexAccountRefused((id) => told.push(id));
    auth.setCodexTokenRenewer(async () => { throw new Error('OpenAI said no'); });
    expect(await auth.freshCodexAuth('q', 'tok-q')).toBeNull();
    expect(auth.refusedCodexAccounts()).toEqual(['q']);
    expect(told).toEqual(['q']);
    expect(auth.failOverCodexFromExhausted('p', null, NOW)).toMatchObject({ kind: 'switched', to: 'r' });
    // A newer token for it starts clean.
    auth.setCodexAccounts([acct('p'), acct('q', 'tok-q2'), acct('r')], 'r', NOW);
    expect(auth.refusedCodexAccounts()).toEqual([]);
    off();
  });

  it('ignores a refusal of a token the account no longer uses', () => {
    auth.setCodexAccounts([acct('a', 'new')], 'a', NOW);
    auth.noteCodexAccountRefused('a', 'old');
    expect(auth.refusedCodexAccounts()).toEqual([]);
  });
});

describe('what a token says of itself', () => {
  it('reads when it ends', () => {
    expect(auth.tokenExpiry(fakeJwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
    expect(auth.tokenExpiry(fakeJwt({}))).toBeNull();
    expect(auth.tokenExpiry('not-a-token')).toBeNull();
    expect(auth.jwtClaims('a.%%%.c')).toBeNull();
  });
});

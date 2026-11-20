import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LineTransport } from './codexRpc';
import { fakeAuthJson, fakeJwt } from './codexTestKit';

vi.mock('../diagLog', () => ({ dlog: () => undefined }));

const { codexOutOfUsage, readCodexAuthJson, renewCodexSignIn, runCodexSignIn } = await import('./codexSignIn');
type RunEvent = import('./codexSignIn').CodexSignInRunEvent;

/**
 * A scripted `codex app-server` in a private home. `answer` decides each
 * reply (null: none yet); the test plays the browser with `finishLogin`.
 */
class FakeCodex implements LineTransport {
  readonly methods: string[] = [];
  home = '';
  closed = false;
  answer: (method: string, params: Record<string, unknown>) => { result?: unknown; error?: { code: number; message: string } } | null =
    (method) => (method === 'account/login/start' ? { result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example/authorize?x=1' } } : { result: {} });
  private line: (line: string) => void = () => undefined;
  private closeHandler: (reason: string) => void = () => undefined;

  send(text: string): void {
    const msg = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (msg.method) this.methods.push(msg.method);
    if (msg.id === undefined || !msg.method) return;
    const reply = this.answer(msg.method, msg.params ?? {});
    if (reply) queueMicrotask(() => this.line(JSON.stringify({ id: msg.id, ...reply })));
  }
  onLine(handler: (line: string) => void): void { this.line = handler; }
  onClose(handler: (reason: string) => void): void { this.closeHandler = handler; }
  close(): void { this.closed = true; }
  notify(method: string, params: unknown): void { this.line(JSON.stringify({ method, params })); }
  die(reason: string): void { this.closeHandler(reason); }
  /** The browser came back: Codex saves the sign-in and says so. */
  finishLogin(authJson: string | null, outcome: { success: boolean; error?: string } = { success: true }): void {
    // After a cancel the home is already gone (as Codex would be): nothing to save into.
    if (authJson && existsSync(this.home)) writeFileSync(join(this.home, 'auth.json'), authJson);
    this.notify('account/login/completed', { loginId: 'login-1', success: outcome.success, error: outcome.error ?? null });
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function signIn(codex = new FakeCodex()) {
  const events: RunEvent[] = [];
  const run = runCodexSignIn({ codexPath: 'codex', connect: (home) => { codex.home = home; return codex; } }, (e) => events.push(e));
  return { codex, events, run };
}

describe('what a sign-in says of itself', () => {
  it('reads the token, the workspace, who it is and when it ends', () => {
    const ends = Date.UTC(2026, 10, 26, 17, 0);
    expect(readCodexAuthJson(fakeAuthJson({ user: 'user-7', workspace: 'ws-9', email: 'seven@example.com', plan: 'plus', expiresAt: ends }))).toMatchObject({
      chatgptAccountId: 'ws-9',
      identity: 'user-7:ws-9',
      email: 'seven@example.com',
      plan: 'plus',
      expiresAt: ends,
    });
  });

  it('tells two ChatGPT accounts apart, and one account’s two sign-ins as the same', () => {
    const id = (o: Parameters<typeof fakeAuthJson>[0]): string => readCodexAuthJson(fakeAuthJson(o))!.identity;
    expect(id({ user: 'u1', serial: 1 })).toBe(id({ user: 'u1', serial: 2 }));
    expect(id({ user: 'u1' })).not.toBe(id({ user: 'u2' }));
    // The same person in another workspace is another account to run on.
    expect(id({ user: 'u1', workspace: 'personal' })).not.toBe(id({ user: 'u1', workspace: 'team' }));
  });

  it('is nothing when it is not a ChatGPT sign-in Codex could run on', () => {
    expect(readCodexAuthJson('not json')).toBeNull();
    expect(readCodexAuthJson(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x', tokens: null }))).toBeNull();
    expect(readCodexAuthJson(JSON.stringify({ tokens: { access_token: fakeJwt({}), account_id: '' } }))).toBeNull();
  });
});

describe('whether an account has usage left', () => {
  const NOW = 1_800_000_000_000;
  const at = (ms: number): number => Math.floor(ms / 1000);
  it('has, while nothing says otherwise', () => {
    expect(codexOutOfUsage(null, NOW)).toBeNull();
    expect(codexOutOfUsage({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 42, resetsAt: at(NOW + 1000) }, secondary: null, rateLimitReachedType: null } }, NOW)).toBeNull();
  });
  it('is out when a limit is full, until the last full limit resets', () => {
    expect(codexOutOfUsage({ rateLimits: { primary: { usedPercent: 100, resetsAt: at(NOW + 3_600_000) }, secondary: { usedPercent: 100, resetsAt: at(NOW + 86_400_000) } } }, NOW))
      .toEqual({ resetsAt: NOW + 86_400_000 });
    // A limit that is not full does not hold it back.
    expect(codexOutOfUsage({ rateLimits: { primary: { usedPercent: 100, resetsAt: at(NOW + 3_600_000) }, secondary: { usedPercent: 60, resetsAt: at(NOW + 86_400_000) } } }, NOW))
      .toEqual({ resetsAt: NOW + 3_600_000 });
  });
  it('is out when Codex says so without a full limit, and says when if it can', () => {
    expect(codexOutOfUsage({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 80, resetsAt: at(NOW + 7_200_000) }, rateLimitReachedType: 'workspace_member_credits_depleted' } }, NOW))
      .toEqual({ resetsAt: NOW + 7_200_000 });
    expect(codexOutOfUsage({ ordinaryUsageAllowed: false, rateLimits: null }, NOW)).toEqual({ resetsAt: null });
  });
});

describe('signing a ChatGPT account in', () => {
  it('gives the sign-in page, then the sign-in Codex saved — and leaves nothing behind', async () => {
    const { codex, events } = signIn();
    await flush();
    expect(codex.methods).toEqual(['initialize', 'initialized', 'account/login/start']);
    expect(events).toEqual([{ type: 'url', url: 'https://auth.example/authorize?x=1' }]);
    const home = codex.home;
    expect(existsSync(home)).toBe(true);

    const saved = fakeAuthJson({ user: 'user-1', email: 'one@example.com', plan: 'pro' });
    codex.finishLogin(saved);
    await flush();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'signed-in', signIn: { authJson: saved, outOfUsageUntil: null, facts: { email: 'one@example.com', plan: 'pro', identity: 'user-1:ws-1' } } });
    expect(codex.closed).toBe(true);
    expect(existsSync(home)).toBe(false);
  });

  it('starts Codex in a home of its own, never this computer’s', async () => {
    const { codex } = signIn();
    await flush();
    expect(codex.home).toMatch(/popbot-codex-account-/);
    expect(codex.home).not.toContain('.codex');
    codex.finishLogin(null, { success: false, error: 'closed' });
    await flush();
  });

  it('says when the account that signed in has no usage left, and until when', async () => {
    const codex = new FakeCodex();
    const reset = Math.floor(Date.now() / 1000) + 7200;
    const base = codex.answer;
    codex.answer = (method, params) => (method === 'account/rateLimits/read'
      ? { result: { ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, resetsAt: reset }, secondary: null, rateLimitReachedType: 'rate_limit_reached' } } }
      : base(method, params));
    const { events } = signIn(codex);
    await flush();
    codex.finishLogin(fakeAuthJson());
    await flush();
    expect(events[1]).toMatchObject({ type: 'signed-in', signIn: { outOfUsageUntil: reset * 1000 } });
  });

  it('does not refuse a sign-in because the usage could not be read', async () => {
    const codex = new FakeCodex();
    const base = codex.answer;
    codex.answer = (method, params) => (method === 'account/rateLimits/read' ? { error: { code: -32603, message: 'backend unavailable' } } : base(method, params));
    const { events } = signIn(codex);
    await flush();
    codex.finishLogin(fakeAuthJson());
    await flush();
    expect(events[1]).toMatchObject({ type: 'signed-in', signIn: { outOfUsageUntil: null } });
  });

  it('fails in ChatGPT’s words when the browser sign-in did not complete', async () => {
    const { codex, events } = signIn();
    await flush();
    codex.finishLogin(null, { success: false, error: 'You do not have access to Codex' });
    await flush();
    expect(events[1]).toEqual({ type: 'failed', message: 'You do not have access to Codex' });
    expect(codex.closed).toBe(true);
  });

  it('fails when Codex says it signed in but saved nothing PopBot can read', async () => {
    const { codex, events } = signIn();
    await flush();
    codex.finishLogin(null);
    await flush();
    expect(events[1]).toMatchObject({ type: 'failed' });
    expect((events[1] as { message: string }).message).toMatch(/could not read the sign-in/);
  });

  it('fails when Codex goes away, or cannot give a page at all', async () => {
    const a = signIn();
    await flush();
    a.codex.die('codex app-server stopped (exit code 1)');
    await flush();
    expect(a.events[1]).toMatchObject({ type: 'failed' });

    const noPage = new FakeCodex();
    noPage.answer = (method) => (method === 'account/login/start' ? { error: { code: -32600, message: 'ChatGPT login is disabled' } } : { result: {} });
    const b = signIn(noPage);
    await flush();
    expect(b.events).toEqual([{ type: 'failed', message: 'ChatGPT login is disabled' }]);
  });

  it('cancelled, says nothing more — even if the browser finishes afterwards', async () => {
    const { codex, events, run } = signIn();
    await flush();
    run.cancel();
    expect(codex.methods).toContain('account/login/cancel');
    expect(codex.closed).toBe(true);
    codex.finishLogin(fakeAuthJson());
    await flush();
    expect(events).toHaveLength(1);
  });
});

describe('renewing a sign-in', () => {
  const renewer = (codex: FakeCodex) => ({ codexPath: 'codex', connect: (home: string) => { codex.home = home; return codex; } });

  it('has Codex renew it in a home of its own and hands back what Codex wrote', async () => {
    const codex = new FakeCodex();
    const old = fakeAuthJson({ serial: 1 });
    const fresh = fakeAuthJson({ serial: 2, plan: 'pro' });
    let seenInHome: string | null = null;
    let asked: unknown = null;
    codex.answer = (method, params) => {
      if (method === 'account/read') {
        asked = params;
        seenInHome = readFileSync(join(codex.home, 'auth.json'), 'utf8');
        writeFileSync(join(codex.home, 'auth.json'), fresh);
      }
      return { result: {} };
    };
    const renewal = await renewCodexSignIn(renewer(codex), old);
    expect(asked).toEqual({ refreshToken: true });
    expect(seenInHome).toBe(old);
    expect(renewal).toMatchObject({ ok: true, authJson: fresh });
    expect(codex.closed).toBe(true);
    expect(existsSync(codex.home)).toBe(false);
  });

  it('calls a sign-in OpenAI will not renew dead, and anything else only a miss', async () => {
    const dead = new FakeCodex();
    dead.answer = (method) => (method === 'account/read'
      ? { error: { code: -32603, message: 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.' } }
      : { result: {} });
    expect(await renewCodexSignIn(renewer(dead), fakeAuthJson())).toMatchObject({ ok: false, dead: true });

    const offline = new FakeCodex();
    offline.answer = (method) => (method === 'account/read' ? { error: { code: -32603, message: 'error sending request: dns error' } } : { result: {} });
    expect(await renewCodexSignIn(renewer(offline), fakeAuthJson())).toMatchObject({ ok: false, dead: false });

    // Codex answered, but kept the token it had.
    expect(await renewCodexSignIn(renewer(new FakeCodex()), fakeAuthJson())).toMatchObject({ ok: false, dead: false });
  });

  it('leaves no sign-in file behind, whatever happened — not even for a moment after', async () => {
    // Renewed, failed, cancelled, signed in: the private home is gone as each returns.
    const renewed = new FakeCodex();
    renewed.answer = (method) => {
      if (method === 'account/read') writeFileSync(join(renewed.home, 'auth.json'), fakeAuthJson({ serial: 9 }));
      return { result: {} };
    };
    await renewCodexSignIn(renewer(renewed), fakeAuthJson({ serial: 8 }));
    expect(existsSync(join(renewed.home, 'auth.json'))).toBe(false);

    const failed = new FakeCodex();
    failed.answer = (method) => (method === 'account/read' ? { error: { code: -32603, message: 'dns error' } } : { result: {} });
    await renewCodexSignIn(renewer(failed), fakeAuthJson());
    expect(existsSync(join(failed.home, 'auth.json'))).toBe(false);

    const cancelled = signIn();
    await flush();
    writeFileSync(join(cancelled.codex.home, 'auth.json'), fakeAuthJson());   // the browser finished just as Cancel was pressed
    cancelled.run.cancel();
    expect(existsSync(join(cancelled.codex.home, 'auth.json'))).toBe(false);

    const done = signIn();
    await flush();
    done.codex.finishLogin(fakeAuthJson());
    await flush();
    expect(existsSync(done.codex.home)).toBe(false);
  });

  it('believes the file over the answer: a renewal Codex wrote counts even if the call then failed', async () => {
    const codex = new FakeCodex();
    const fresh = fakeAuthJson({ serial: 5 });
    codex.answer = (method) => {
      if (method !== 'account/read') return { result: {} };
      writeFileSync(join(codex.home, 'auth.json'), fresh);
      return { error: { code: -32603, message: 'workspace metadata request timed out' } };
    };
    expect(await renewCodexSignIn(renewer(codex), fakeAuthJson({ serial: 4 }))).toMatchObject({ ok: true, authJson: fresh });
  });

  it('will not try a sign-in it cannot read', async () => {
    expect(await renewCodexSignIn(renewer(new FakeCodex()), '{}')).toMatchObject({ ok: false, dead: true });
  });
});

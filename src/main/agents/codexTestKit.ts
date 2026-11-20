import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Test helpers for Codex accounts: sign-ins shaped like Codex's own
 * auth.json, with tokens that say of themselves what real ones do. Not
 * shipped in any bundle that matters — only the tests import it.
 */

/** A token shaped like a JWT (unsigned): what jwtClaims reads. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

export interface FakeSignIn {
  user?: string;
  workspace?: string;
  email?: string | null;
  plan?: string;
  /** When the access token ends (ms). */
  expiresAt?: number;
  /** Tells one access token of the same account from the next. */
  serial?: number;
  refreshToken?: string;
}

/** Codex's auth.json for a ChatGPT sign-in. */
export function fakeAuthJson(o: FakeSignIn = {}): string {
  const user = o.user ?? 'user-1';
  const workspace = o.workspace ?? 'ws-1';
  const exp = Math.floor((o.expiresAt ?? Date.now() + 10 * 24 * 3600_000) / 1000);
  const auth = { chatgpt_user_id: user, chatgpt_account_id: workspace, chatgpt_plan_type: o.plan ?? 'pro' };
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ email: o.email === undefined ? `${user}@example.com` : o.email, 'https://api.openai.com/auth': auth }),
      access_token: fakeJwt({ exp, jti: `t${o.serial ?? 1}`, 'https://api.openai.com/auth': auth }),
      refresh_token: o.refreshToken ?? `rt.${user}.${o.serial ?? 1}`,
      account_id: workspace,
    },
    last_refresh: new Date().toISOString(),
  });
}

/**
 * A scripted `codex app-server` for a private home (codexSignIn.ts's
 * `connect` seam): answers every request with `{}` unless `answer` says
 * otherwise, and can play the browser coming back from a sign-in.
 */
export class ScriptedCodex {
  readonly methods: string[] = [];
  home = '';
  closed = false;
  answer: (method: string, params: Record<string, unknown>, home: string) => { result?: unknown; error?: { code: number; message: string } } | null =
    (method) => (method === 'account/login/start'
      ? { result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example/authorize?x=1' } }
      : { result: {} });
  private line: (line: string) => void = () => undefined;

  /** What codexSignIn.ts's `connect` is given. */
  connect = (home: string): { send(line: string): void; onLine(h: (line: string) => void): void; onClose(h: (reason: string) => void): void; close(): void } => {
    this.home = home;
    this.closed = false;
    return {
      send: (text: string) => {
        const msg = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown> };
        if (msg.method) this.methods.push(msg.method);
        if (msg.id === undefined || !msg.method) return;
        const reply = this.answer(msg.method, msg.params ?? {}, home);
        if (reply) queueMicrotask(() => this.line(JSON.stringify({ id: msg.id, ...reply })));
      },
      onLine: (handler: (line: string) => void) => { this.line = handler; },
      onClose: () => undefined,
      close: () => { this.closed = true; },
    };
  };

  /** The browser sign-in did not complete. */
  failLogin(error: string): void {
    this.line(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'login-1', success: false, error } }));
  }

  /** The browser came back: Codex saves the sign-in and says so. */
  finishLogin(authJson: string): void {
    // After a cancel the home is already gone (as Codex would be): nothing to save into.
    if (existsSync(this.home)) writeFileSync(join(this.home, 'auth.json'), authJson);
    this.line(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null } }));
  }
}

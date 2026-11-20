/**
 * A Codex account's sign-in, made and renewed by Codex itself.
 *
 * PopBot never speaks OpenAI's sign-in protocol. It runs `codex
 * app-server` in a private, throwaway Codex home — a folder of its own,
 * so this computer's own Codex sign-in (~/.codex) is neither read nor
 * touched — and lets Codex do the work there:
 *
 *   signing in   `account/login/start` gives the ChatGPT sign-in page;
 *                the browser hands the result back to Codex, which
 *                writes its `auth.json` in the private home.
 *   renewing     the stored `auth.json` is put back in a private home
 *                and Codex is asked to renew it (`account/read` with
 *                `refreshToken`); it rewrites the file.
 *
 * Either way the file is read, the home is deleted, and the caller keeps
 * the file's text (codexAccounts.ts stores it encrypted). It is in a
 * file only while Codex is working on it — seconds for a renewal — in a
 * folder only this user can read, and the file is deleted the moment it
 * has been read.
 *
 * A sign-in must never be in two places that both renew it: OpenAI
 * replaces the renewal token every time, and the copy that renews second
 * is refused. That is why an account is signed in here rather than
 * borrowed from ~/.codex, and why hosts are given only access tokens.
 *
 * No Electron here, and Codex is reached through `connect`, so all of
 * this is tested against a scripted app-server.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dlog } from '../diagLog';
import { CodexRpcClient, spawnCodexAppServer, type LineTransport } from './codexRpc';
import { jwtClaims, tokenExpiry } from './codexAuth';

// ── What a sign-in says of itself ────────────────────────────────────

/** What PopBot reads out of Codex's auth.json. Nothing here is verified:
 *  it is what the sign-in says of itself, used to name and tell accounts apart. */
export interface CodexSignInFacts {
  accessToken: string;
  /** The ChatGPT workspace the sign-in is for. */
  chatgptAccountId: string;
  /** Who signed in, and in which workspace: the same for two sign-ins of
   *  one ChatGPT account, different for two accounts. */
  identity: string;
  email: string | null;
  plan: string | null;
  /** When the access token stops working (ms). */
  expiresAt: number | null;
}

const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Read a Codex auth.json. Null when it is not a ChatGPT sign-in Codex
 *  could run on (no access token, or no workspace). */
export function readCodexAuthJson(authJson: string): CodexSignInFacts | null {
  let parsed: unknown;
  try { parsed = JSON.parse(authJson); } catch { return null; }
  const tokens = (parsed as { tokens?: Record<string, unknown> } | null)?.tokens;
  const accessToken = text(tokens?.access_token);
  if (!tokens || !accessToken) return null;
  const access = jwtClaims(accessToken) ?? {};
  const id = jwtClaims(text(tokens.id_token) ?? '') ?? {};
  const accessAuth = (access[AUTH_CLAIM] ?? {}) as Record<string, unknown>;
  const idAuth = (id[AUTH_CLAIM] ?? {}) as Record<string, unknown>;
  const chatgptAccountId = text(tokens.account_id) ?? text(accessAuth.chatgpt_account_id) ?? text(idAuth.chatgpt_account_id);
  if (!chatgptAccountId) return null;
  const email = text(id.email) ?? text((access[PROFILE_CLAIM] as Record<string, unknown> | undefined)?.email);
  const user = text(accessAuth.chatgpt_user_id) ?? text(idAuth.chatgpt_user_id) ?? text(access.sub) ?? email ?? 'unknown';
  return {
    accessToken,
    chatgptAccountId,
    identity: `${user}:${chatgptAccountId}`,
    email,
    plan: text(accessAuth.chatgpt_plan_type) ?? text(idAuth.chatgpt_plan_type),
    expiresAt: tokenExpiry(accessToken),
  };
}

/** Codex's `account/rateLimits/read` answer, as far as it is read here. */
interface RateLimits {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: {
    primary?: { usedPercent?: number; resetsAt?: number | null } | null;
    secondary?: { usedPercent?: number; resetsAt?: number | null } | null;
    rateLimitReachedType?: string | null;
  } | null;
}

/**
 * Whether an account has no usage left, and until when (ms; null when
 * Codex did not say). Null: it has usage, or Codex could not tell.
 */
export function codexOutOfUsage(limits: RateLimits | null | undefined, now = Date.now()): { resetsAt: number | null } | null {
  if (!limits) return null;
  const windows = [limits.rateLimits?.primary, limits.rateLimits?.secondary].filter((w): w is NonNullable<typeof w> => !!w);
  const full = windows.filter((w) => typeof w.usedPercent === 'number' && w.usedPercent >= 100);
  const out = limits.ordinaryUsageAllowed === false || !!limits.rateLimits?.rateLimitReachedType || full.length > 0;
  if (!out) return null;
  // The account is back when the LAST of the limits it has hit resets.
  const resets = (full.length > 0 ? full : windows)
    .map((w) => (typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : 0))
    .filter((t) => t > now);
  return { resetsAt: resets.length > 0 ? Math.max(...resets) : null };
}

// ── A private Codex home ─────────────────────────────────────────────

export interface CodexHomeRunner {
  codexPath: string;
  pathDirs?: string[];
  /** Test seam: the app-server for a home (default: the real CLI). */
  connect?: (home: string) => LineTransport;
}

const INIT = {
  clientInfo: { name: 'popbot', title: 'PopBot', version: '0' },
  capabilities: { experimentalApi: true, requestAttestation: false },
};

function newHome(): string {
  // mkdtemp makes it readable by this user only.
  return mkdtempSync(join(tmpdir(), 'popbot-codex-account-'));
}

/**
 * Delete a private home. The sign-in file goes first and at once — it is
 * the only secret there, and it must not outlive this call even if the
 * app quits a moment later. The rest (Codex's own databases) may still be
 * being written as Codex exits, so the folder is tried again shortly.
 */
function dropHome(home: string): void {
  try { rmSync(join(home, 'auth.json'), { force: true }); } catch { /* not there */ }
  const all = (): void => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* busy: the OS clears its temp folder */ }
  };
  all();
  setTimeout(all, 500).unref?.();
}

function connectTo(runner: CodexHomeRunner, home: string): LineTransport {
  if (runner.connect) return runner.connect(home);
  return spawnCodexAppServer(runner.codexPath, runner.pathDirs ?? [], {
    // The sign-in goes in this home's auth.json whatever the user's own
    // Codex is set to keep (a keyring could not be read back from here).
    args: ['-c', 'cli_auth_credentials_store=file'],
    // Nothing of this process's own Codex credentials may leak in: the
    // sign-in made here must be the one the browser gave.
    env: { CODEX_HOME: home, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined, OPENAI_API_KEY: undefined },
  });
}

function readAuthJson(home: string): string | null {
  try { return readFileSync(join(home, 'auth.json'), 'utf8'); } catch { return null; }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Signing in ───────────────────────────────────────────────────────

export interface CodexSignedIn {
  /** Codex's auth.json for this sign-in, verbatim. */
  authJson: string;
  facts: CodexSignInFacts;
  /** Signed in, but with no usage left until then (ms; 0: not said when). Null: has usage. */
  outOfUsageUntil: number | null;
}

export type CodexSignInRunEvent =
  /** The ChatGPT sign-in page for this attempt. */
  | { type: 'url'; url: string }
  | { type: 'signed-in'; signIn: CodexSignedIn }
  | { type: 'failed'; message: string };

export interface CodexSignInRun {
  /** Stop, saying nothing more. */
  cancel(): void;
}

/** Long enough to sign in at leisure; short enough not to leave Codex
 *  listening forever behind a closed dialog. */
const SIGN_IN_TIME_LIMIT_MS = 15 * 60_000;

/**
 * Sign a ChatGPT account in. One attempt per run: it ends with
 * `signed-in`, with `failed`, or silently when cancelled. The page is
 * not opened here — the caller decides whether to (the user may want it
 * in a window signed in to another ChatGPT account).
 */
export function runCodexSignIn(runner: CodexHomeRunner, onEvent: (event: CodexSignInRunEvent) => void): CodexSignInRun {
  const home = newHome();
  let over = false;
  let loginId: string | null = null;
  let rpc: CodexRpcClient | null = null;
  let completed: (outcome: { success: boolean; error: string | null }) => void = () => undefined;
  const completion = new Promise<{ success: boolean; error: string | null }>((resolve) => { completed = resolve; });

  const end = (): void => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    try { rpc?.close(); } catch { /* already gone */ }
    dropHome(home);
  };
  const fail = (message: string): void => {
    if (over) return;
    end();
    dlog('codex.sign-in.failed', { message: message.slice(0, 200) });
    onEvent({ type: 'failed', message });
  };
  const timer = setTimeout(() => fail('The sign-in was left waiting too long.'), SIGN_IN_TIME_LIMIT_MS);

  void (async () => {
    try {
      rpc = new CodexRpcClient(connectTo(runner, home), {
        onNotification: (method, params) => {
          if (method !== 'account/login/completed') return;
          const p = (params ?? {}) as { loginId?: string | null; success?: boolean; error?: string | null };
          if (loginId && p.loginId && p.loginId !== loginId) return;
          completed({ success: p.success === true, error: p.error ?? null });
        },
        // Codex asks nothing of a client that is only signing in.
        onServerRequest: (id) => rpc?.respondError(id, -32601, 'not handled while signing in'),
        onClose: (reason) => fail(`Codex stopped before the sign-in finished: ${reason}`),
      });
      const client = rpc;
      await client.request('initialize', INIT);
      client.notify('initialized');
      const started = await client.request<{ type?: string; loginId?: string; authUrl?: string }>('account/login/start', { type: 'chatgpt' });
      if (over) return;
      if (!started?.authUrl) throw new Error('Codex did not give a sign-in page.');
      loginId = started.loginId ?? null;
      dlog('codex.sign-in.start', {});
      onEvent({ type: 'url', url: started.authUrl });

      const outcome = await completion;
      if (over) return;
      if (!outcome.success) throw new Error(outcome.error || 'ChatGPT did not complete the sign-in.');

      // Whether the account can run anything right now. Not knowing is
      // not a reason to refuse the sign-in.
      let limits: RateLimits | null = null;
      try { limits = await client.request<RateLimits>('account/rateLimits/read', {}); } catch { /* unknown */ }
      const authJson = readAuthJson(home);
      const facts = authJson ? readCodexAuthJson(authJson) : null;
      if (!authJson || !facts) throw new Error('Codex signed in, but PopBot could not read the sign-in it saved.');
      const out = codexOutOfUsage(limits);
      end();
      dlog('codex.sign-in.done', { plan: facts.plan, outOfUsage: !!out });
      onEvent({ type: 'signed-in', signIn: { authJson, facts, outOfUsageUntil: out ? (out.resetsAt ?? 0) : null } });
    } catch (err) {
      fail(errorText(err));
    }
  })();

  return {
    cancel() {
      if (over) return;
      // Best effort: lets Codex stop listening for the browser at once.
      if (loginId) rpc?.request('account/login/cancel', { loginId }).catch(() => undefined);
      end();
      dlog('codex.sign-in.cancelled', {});
    },
  };
}

// ── Renewing ─────────────────────────────────────────────────────────

/** How Codex words a sign-in OpenAI will not renew any more. */
const SIGN_IN_DEAD = /refresh token (?:has expired|was already used|was revoked|is invalid)|log out and sign in again|sign in again|reauthori[sz]ation required|invalid_grant|401/i;
const RENEW_TIME_LIMIT_MS = 90_000;

export type CodexRenewal =
  /** Codex renewed it: the new auth.json, which replaces the old one. */
  | { ok: true; authJson: string; facts: CodexSignInFacts }
  /** `dead`: OpenAI will not renew this sign-in — the account must sign
   *  in again. Otherwise it could not be tried just now. */
  | { ok: false; dead: boolean; error: string };

/**
 * Have Codex renew a sign-in. The auth.json given is spent whether or
 * not this succeeds in being read back — OpenAI replaces the renewal
 * token as it renews — so the caller stores the answer at once.
 */
export async function renewCodexSignIn(runner: CodexHomeRunner, authJson: string): Promise<CodexRenewal> {
  const before = readCodexAuthJson(authJson);
  if (!before) return { ok: false, dead: true, error: 'the saved sign-in is not one Codex can renew' };
  const home = newHome();
  let rpc: CodexRpcClient | null = null;
  let closedWhy: string | null = null;
  try {
    writeFileSync(join(home, 'auth.json'), authJson, { mode: 0o600 });
    rpc = new CodexRpcClient(connectTo(runner, home), {
      onNotification: () => undefined,
      onServerRequest: (id) => rpc?.respondError(id, -32601, 'not handled while renewing'),
      onClose: (reason) => { closedWhy = reason; },
    });
    const client = rpc;
    const work = (async (): Promise<string | null> => {
      await client.request('initialize', INIT);
      client.notify('initialized');
      // In Codex's own words: "requests a proactive token refresh before returning".
      await client.request('account/read', { refreshToken: true });
      return null;
    })();
    const failed = await Promise.race([
      work.catch((err) => errorText(err)),
      new Promise<string>((resolve) => { setTimeout(() => resolve(`Codex did not answer in ${RENEW_TIME_LIMIT_MS / 1000} seconds`), RENEW_TIME_LIMIT_MS).unref?.(); }),
    ]);
    // Whatever Codex said, the file is the truth: it is rewritten only by a renewal that worked.
    const after = readAuthJson(home);
    const facts = after ? readCodexAuthJson(after) : null;
    if (after && facts && facts.accessToken !== before.accessToken) {
      dlog('codex.sign-in.renewed', { expiresAt: facts.expiresAt });
      return { ok: true, authJson: after, facts };
    }
    const why = failed ?? closedWhy ?? 'Codex kept the token it had';
    const dead = SIGN_IN_DEAD.test(why);
    dlog('codex.sign-in.renew-failed', { dead, error: why.slice(0, 200) });
    return { ok: false, dead, error: why };
  } catch (err) {
    return { ok: false, dead: false, error: errorText(err) };
  } finally {
    try { rpc?.close(); } catch { /* already gone */ }
    dropHome(home);
  }
}

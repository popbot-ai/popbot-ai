/**
 * The Codex account PopBot's agents run on, in memory.
 *
 * Codex signs in to ChatGPT, and a sign-in is one login per machine: a
 * second account means signing out of the first. So PopBot keeps its own
 * sign-ins, one per account, with exactly one account active — every
 * Codex chat runs on it, and switching moves them all.
 *
 * What a Codex process is given is the account's ACCESS token — a
 * ChatGPT token good for about ten days — handed to `codex app-server`
 * when it starts (`account/login/start`, type `chatgptAuthTokens`: the
 * mode Codex has for clients that manage accounts themselves). The
 * process keeps it in memory only and never reads or writes this
 * computer's own Codex sign-in (CodexAppServerBackend.ts).
 *
 * The desktop keeps the sign-ins (encrypted, codexAccounts.ts), renews
 * each access token before it runs out, and sends the access tokens —
 * never the sign-ins themselves — to every host; this module is where
 * each side holds them while running. Never written to disk here.
 *
 * No Electron here: the host daemon runs this too.
 */
import type { UsageFailover } from './claudeAuth';

export interface CodexAccountSecret {
  id: string;
  label: string;
  /** A ChatGPT access token (a JWT): what a Codex process runs on. */
  accessToken: string;
  /** The ChatGPT workspace the token is for (Codex asks for it by name). */
  chatgptAccountId: string;
  /** The plan as the sign-in named it, or null: Codex reads it from the token. */
  planType: string | null;
}

/** What a Codex process is handed to run on an account. */
export interface CodexAuth {
  accountId: string;
  accessToken: string;
  chatgptAccountId: string;
  planType: string | null;
}

let accounts: CodexAccountSecret[] = [];
let activeId: string | null = null;
/** Accounts out of usage, and until when (ms). */
const exhausted = new Map<string, number>();
/** Accounts whose current access token OpenAI has refused. */
const refused = new Map<string, string>();
/**
 * `account`: the chats must move (another account, or accounts turned on
 * or off). `token`: the same account has a newer token — nothing moves;
 * a process that needs it asks (freshCodexAuth).
 */
export type CodexAuthChange = 'account' | 'token';
const listeners = new Set<(change: CodexAuthChange) => void>();

function toAuth(a: CodexAccountSecret | undefined): CodexAuth | null {
  return a ? { accountId: a.id, accessToken: a.accessToken, chatgptAccountId: a.chatgptAccountId, planType: a.planType } : null;
}

/** What every Codex agent should be running on, or null: this computer's
 *  own Codex sign-in (~/.codex) applies. */
export function activeCodexAuth(): CodexAuth | null {
  return toAuth(accounts.find((a) => a.id === activeId));
}

export function activeCodexAccount(): { id: string; label: string } | null {
  const a = accounts.find((x) => x.id === activeId);
  return a ? { id: a.id, label: a.label } : null;
}

/** The active account's id, for tagging which account a limit hit. */
export function activeCodexAccountId(): string | null {
  return accounts.some((a) => a.id === activeId) ? activeId : null;
}

function tell(change: CodexAuthChange): void {
  for (const l of listeners) {
    try { l(change); } catch { /* a listener's bug must not stop the others */ }
  }
}

/**
 * Replace the accounts. Says what that changed for the chats (and tells
 * the listeners the same), or null: nothing. An active account known to
 * be out of usage gives way to the next one that isn't (a desktop that
 * hasn't heard yet must not switch a host back onto an exhausted one).
 */
export function setCodexAccounts(next: CodexAccountSecret[], nextActiveId: string | null, now = Date.now()): CodexAuthChange | null {
  const before = activeCodexAuth();
  accounts = next.filter((a) => typeof a.accessToken === 'string' && a.accessToken.length > 0);
  // A refusal was of one token: a newer one starts clean.
  for (const [id, token] of refused) {
    const a = accounts.find((x) => x.id === id);
    if (!a || a.accessToken !== token) refused.delete(id);
  }
  activeId = accounts.some((a) => a.id === nextActiveId) ? nextActiveId : null;
  if (activeId && isCodexExhausted(activeId, now)) activeId = nextAvailableAccount(activeId, now) ?? activeId;
  const after = activeCodexAuth();
  const change: CodexAuthChange | null =
    (before?.accountId ?? null) !== (after?.accountId ?? null) ? 'account'
      : before && after && (before.accessToken !== after.accessToken || before.chatgptAccountId !== after.chatgptAccountId) ? 'token'
        : null;
  if (change) tell(change);
  return change;
}

export function onActiveCodexAuthChange(listener: (change: CodexAuthChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── A fresher token ──────────────────────────────────────────────────
//
// Codex asks its client for a new token when OpenAI turns the one it has
// down (`account/chatgptAuthTokens/refresh`). The desktop can renew a
// sign-in; a host can only wait for the desktop's next push.

let renewer: ((accountId: string) => Promise<void>) | null = null;

/** The desktop's way to renew an account's access token (codexAccounts.ts). */
export function setCodexTokenRenewer(fn: ((accountId: string) => Promise<void>) | null): void {
  renewer = fn;
}

/**
 * A token for `accountId` newer than `staleToken`, which OpenAI just
 * refused — or null when there is none to be had (the account is then
 * marked refused). If the account has already moved on to a newer token,
 * that one is the answer and nothing is renewed.
 */
export async function freshCodexAuth(accountId: string, staleToken: string): Promise<CodexAuth | null> {
  const current = (): CodexAccountSecret | undefined => accounts.find((a) => a.id === accountId);
  if (current() && current()!.accessToken !== staleToken) return toAuth(current());
  if (renewer) {
    try { await renewer(accountId); } catch { /* said by the renewer; no newer token is the outcome */ }
  }
  const after = current();
  if (after && after.accessToken !== staleToken) return toAuth(after);
  noteCodexAccountRefused(accountId, staleToken);
  return null;
}

// ── Out of usage ─────────────────────────────────────────────────────
//
// As for Claude (claudeAuth.ts): when an account runs out of usage, every
// chat moves to the next account that still has some; only when none has
// does a chat give up. An account is out until the reset its limit
// reported (or FALLBACK_OUT_MS).

const FALLBACK_OUT_MS = 5 * 60 * 60_000;

export function isCodexExhausted(id: string, now = Date.now()): boolean {
  const until = exhausted.get(id);
  if (until === undefined) return false;
  if (until <= now) { exhausted.delete(id); return false; }
  return true;
}

/** The next account after `afterId` (in order, wrapping) not out of usage. */
function nextAvailableAccount(afterId: string | null, now = Date.now()): string | null {
  if (accounts.length === 0) return null;
  const start = Math.max(0, accounts.findIndex((a) => a.id === afterId));
  for (let i = 1; i <= accounts.length; i += 1) {
    const a = accounts[(start + i) % accounts.length];
    if (a.id !== afterId && !isCodexExhausted(a.id, now) && !refused.has(a.id)) return a.id;
  }
  return null;
}

/**
 * An account is out of usage until `resetsAt` (ms, or unknown): mark it,
 * and if it is the active one move to the next that isn't. Listeners hear
 * a move as they would any switch. Calls for an account already marked
 * (another chat on it failing a moment later) don't move things again.
 */
export function failOverCodexFromExhausted(accountId: string | null, resetsAt: number | null, now = Date.now()): UsageFailover {
  const failed = accountId ?? activeId;
  if (!failed || !accounts.some((a) => a.id === failed)) return { kind: 'no-accounts' };
  exhausted.set(failed, Math.max(exhausted.get(failed) ?? 0, resetsAt && resetsAt > now ? resetsAt : now + FALLBACK_OUT_MS));
  if (activeId !== failed && activeId && !isCodexExhausted(activeId, now)) {
    return { kind: 'switched', from: failed, to: activeId, toLabel: accounts.find((a) => a.id === activeId)!.label };
  }
  const next = nextAvailableAccount(failed, now);
  if (!next) {
    const resets = accounts.map((a) => exhausted.get(a.id)).filter((t): t is number => typeof t === 'number');
    return { kind: 'none-left', earliestReset: resets.length > 0 ? Math.min(...resets) : null };
  }
  activeId = next;
  tell('account');
  return { kind: 'switched', from: failed, to: next, toLabel: accounts.find((a) => a.id === next)!.label };
}

/** Accounts out of usage right now, and until when — sent between desktop and hosts. */
export function exhaustedCodexAccounts(now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, until] of exhausted) if (until > now) out[id] = until;
  return out;
}

/** Adopt what another side knows is out of usage (a host's reply, a saved list). */
export function noteCodexExhausted(marks: Record<string, number> | null | undefined, now = Date.now()): void {
  for (const [id, until] of Object.entries(marks ?? {})) {
    if (typeof until === 'number' && until > now) exhausted.set(id, Math.max(exhausted.get(id) ?? 0, until));
  }
}

// ── A refused sign-in ────────────────────────────────────────────────
//
// When OpenAI refuses an account's token and there is no newer one, the
// account is marked until it has another token, so the window can say
// which account needs signing in again and failover passes it by.

const refusedListeners = new Set<(id: string) => void>();

/** OpenAI refused `token` for this account. A refusal of a token the
 *  account no longer uses says nothing about the one it has now. */
export function noteCodexAccountRefused(id: string, token: string): void {
  const a = accounts.find((x) => x.id === id);
  if (!a || a.accessToken !== token || refused.has(id)) return;
  refused.set(id, token);
  for (const l of refusedListeners) {
    try { l(id); } catch { /* a listener's bug must not stop the others */ }
  }
}

export function refusedCodexAccounts(): string[] {
  return [...refused.keys()];
}

export function onCodexAccountRefused(listener: (id: string) => void): () => void {
  refusedListeners.add(listener);
  return () => refusedListeners.delete(listener);
}

// ── Reading a token ──────────────────────────────────────────────────

/** A JWT's claims, unverified — only ever read for what the token says
 *  of itself (when it ends, whose it is). Null when it is not a JWT. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** When an access token stops working (ms), or null when it does not say. */
export function tokenExpiry(token: string): number | null {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

/**
 * The Claude account PopBot's agents run on, in memory.
 *
 * A Claude Code login made with `claude auth login` has a fixed lifetime,
 * and every CLI process reads it once, at start: a re-login elsewhere
 * never reaches a session already running, and an unattended loop has
 * no one to sign it in again. So PopBot runs Claude on long-lived tokens
 * (`claude setup-token`, one year), one per account, with exactly one
 * account active — every chat runs on it, and switching moves them all.
 *
 * The desktop keeps the accounts (encrypted, claudeAccounts.ts) and sends
 * them to every host; this module is where each side holds them while
 * running. Never written to disk here; ClaudeBackend hands the active
 * token to each CLI it starts (on a file descriptor, not in its
 * environment) and answers the CLI's own requests for a fresh one.
 *
 * No Electron here: the host daemon runs this too.
 */

export interface ClaudeAccountSecret {
  id: string;
  label: string;
  token: string;
}

let accounts: ClaudeAccountSecret[] = [];
let activeId: string | null = null;
/** Accounts out of usage, and until when (ms). */
const exhausted = new Map<string, number>();
/** Accounts whose current token Claude has refused in a chat. */
const refused = new Set<string>();
/** When each account's current token was set here (ms). */
const tokenSetAt = new Map<string, number>();
/** A host's own CLAUDE_CODE_OAUTH_TOKEN, used until a desktop sends accounts. */
let envFallback: string | null = null;
const listeners = new Set<(token: string | null) => void>();

/** The token every Claude agent should be running on, or null: the CLI's
 *  own login (the Keychain / ~/.claude) applies. */
export function activeClaudeToken(): string | null {
  return accounts.find((a) => a.id === activeId)?.token ?? envFallback;
}

export function activeClaudeAccount(): { id: string; label: string } | null {
  const a = accounts.find((x) => x.id === activeId);
  return a ? { id: a.id, label: a.label } : envFallback ? { id: 'env', label: 'CLAUDE_CODE_OAUTH_TOKEN' } : null;
}

/** Replace the accounts. Listeners hear only when the active token changes.
 *  An active account known to be out of usage gives way to the next one
 *  that isn't (a desktop that hasn't heard yet must not switch a host
 *  back onto an exhausted account). */
export function setClaudeAccounts(next: ClaudeAccountSecret[], nextActiveId: string | null, now = Date.now()): boolean {
  const before = activeClaudeToken();
  const tokens = new Map(accounts.map((a) => [a.id, a.token]));
  accounts = next.filter((a) => typeof a.token === 'string' && a.token.length > 0);
  // A new token starts clean: what Claude refused was the one before.
  for (const a of accounts) {
    if (tokens.get(a.id) === a.token) continue;
    tokenSetAt.set(a.id, now);
    refused.delete(a.id);
  }
  for (const id of tokenSetAt.keys()) {
    if (!accounts.some((a) => a.id === id)) { tokenSetAt.delete(id); refused.delete(id); }
  }
  activeId = accounts.some((a) => a.id === nextActiveId) ? nextActiveId : null;
  if (activeId && isExhausted(activeId, now)) activeId = nextAvailableAccount(activeId, now) ?? activeId;
  const after = activeClaudeToken();
  if (after === before) return false;
  for (const l of listeners) {
    try { l(after); } catch { /* a listener's bug must not stop the others */ }
  }
  return true;
}

/** Host start-up: take CLAUDE_CODE_OAUTH_TOKEN from this process's
 *  environment as the fallback account, and remove it from the
 *  environment so the agents' own commands never inherit it. */
export function adoptEnvClaudeToken(): void {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) envFallback = token;
}

export function onActiveClaudeTokenChange(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Out of usage ─────────────────────────────────────────────────────
//
// When an account runs out of usage, every chat moves to the next account
// that still has some; only when none has does a chat give up. An account
// is out until the reset its limit reported (or FALLBACK_OUT_MS).

const FALLBACK_OUT_MS = 5 * 60 * 60_000;

/**
 * The account is out of usage — a plan limit, not a transient 429 — in
 * the words the CLI uses when it reports one as text ("You've hit your
 * limit · resets 5pm", "5-hour limit reached", "Claude AI usage limit
 * reached", "You've hit your org's monthly spend limit"). The structured
 * signal is the SDK's rate_limit_event; this catches a CLI that only says
 * it. Not "usage credits": a model the plan doesn't include is a
 * different account question.
 */
export const USAGE_LIMIT_TEXT = /usage limit|spend limit|hit your (?:usage )?limit|(?:5|five)[- ]hour limit|weekly limit|limit reached[^.]*reset/i;

export function isExhausted(id: string, now = Date.now()): boolean {
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
    if (a.id !== afterId && !isExhausted(a.id, now)) return a.id;
  }
  return null;
}

export type UsageFailover =
  | { kind: 'switched'; from: string; to: string; toLabel: string }
  | { kind: 'none-left'; earliestReset: number | null }
  /** Not on one of PopBot's accounts (the CLI's own login): nothing to switch to. */
  | { kind: 'no-accounts' };

/**
 * The active account is out of usage until `resetsAt` (ms, or unknown):
 * mark it, and move to the next account that isn't. Listeners hear the
 * new token as they would any switch. Calls for an account already marked
 * (another chat on the same account failing a moment later) don't move
 * the active account again.
 */
export function failOverFromExhausted(accountId: string | null, resetsAt: number | null, now = Date.now()): UsageFailover {
  const failed = accountId ?? activeId;
  if (!failed || !accounts.some((a) => a.id === failed)) return { kind: 'no-accounts' };
  exhausted.set(failed, Math.max(exhausted.get(failed) ?? 0, resetsAt && resetsAt > now ? resetsAt : now + FALLBACK_OUT_MS));
  if (activeId !== failed && activeId && !isExhausted(activeId, now)) {
    const label = accounts.find((a) => a.id === activeId)!.label;
    return { kind: 'switched', from: failed, to: activeId, toLabel: label };
  }
  const next = nextAvailableAccount(failed, now);
  if (!next) {
    const resets = accounts.map((a) => exhausted.get(a.id)).filter((t): t is number => typeof t === 'number');
    return { kind: 'none-left', earliestReset: resets.length > 0 ? Math.min(...resets) : null };
  }
  const before = activeClaudeToken();
  activeId = next;
  const after = activeClaudeToken();
  if (after !== before) {
    for (const l of listeners) {
      try { l(after); } catch { /* a listener's bug must not stop the others */ }
    }
  }
  return { kind: 'switched', from: failed, to: next, toLabel: accounts.find((a) => a.id === next)!.label };
}

/** Accounts out of usage right now, and until when — sent between desktop and hosts. */
export function exhaustedAccounts(now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, until] of exhausted) if (until > now) out[id] = until;
  return out;
}

/** Adopt what another side knows is out of usage (a host's reply, a saved list). */
export function noteExhausted(marks: Record<string, number> | null | undefined, now = Date.now()): void {
  for (const [id, until] of Object.entries(marks ?? {})) {
    if (typeof until === 'number' && until > now) exhausted.set(id, Math.max(exhausted.get(id) ?? 0, until));
  }
}

/** The active account's id, for tagging which account a limit hit. */
export function activeClaudeAccountId(): string | null {
  return accounts.some((a) => a.id === activeId) ? activeId : null;
}

// ── A refused sign-in ────────────────────────────────────────────────
//
// When Claude refuses an account's token in a chat, the account is marked
// until that token is replaced, so the window can say which account needs
// signing in again. Nothing moves by itself, and the mark is kept in
// memory only: a token still refused is found again at the next failure.

const refusedListeners = new Set<(id: string) => void>();

/**
 * Claude refused this account's sign-in in a session started at
 * `sessionStartedAt` (ms). A session from before the account's current
 * token was set ran on the one before, so it says nothing about this one.
 * Listeners hear a new mark, not a repeat of one.
 */
export function noteClaudeAccountRefused(id: string, sessionStartedAt: number): void {
  const since = tokenSetAt.get(id);
  if (since === undefined || sessionStartedAt < since || refused.has(id)) return;
  refused.add(id);
  for (const l of refusedListeners) {
    try { l(id); } catch { /* a listener's bug must not stop the others */ }
  }
}

/** The same token was checked again and works: what was refused before
 *  no longer stands. (A changed token is cleared by setClaudeAccounts.) */
export function clearClaudeAccountRefused(id: string): void {
  refused.delete(id);
}

export function refusedClaudeAccounts(): string[] {
  return [...refused];
}

export function onClaudeAccountRefused(listener: (id: string) => void): () => void {
  refusedListeners.add(listener);
  return () => refusedListeners.delete(listener);
}

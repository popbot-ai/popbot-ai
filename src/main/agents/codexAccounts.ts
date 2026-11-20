/**
 * PopBot's Codex accounts, on the desktop: each a name and a ChatGPT
 * sign-in made inside PopBot (codexSignIn.ts), exactly one active. Every
 * Codex chat runs on the active one — here and on every host
 * (codexAccountsSync.ts) — and switching moves them all (AgentHost
 * restarts each at its next idle moment, resuming its thread).
 *
 * A sign-in is Codex's own auth.json, stored encrypted with the OS's own
 * store through Electron's safeStorage — never in plain text. What runs
 * the chats is the access token inside it, good for about ten days:
 * PopBot has Codex renew each sign-in a few days before that
 * (renewDueCodexAccounts), and at once when OpenAI turns a token down.
 * The running app holds the access tokens in memory (codexAuth.ts).
 */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { CodexAccountInfo, CodexAccountsFailure } from '@shared/ipc';
import { getSetting, setSetting } from '../persistence/settings';
import { dlog } from '../diagLog';
import { claudeAccountsEncryptionAvailable } from './claudeAccounts';
import type { UsageFailover } from './claudeAuth';
import {
  activeCodexAccountId,
  exhaustedCodexAccounts,
  failOverCodexFromExhausted,
  isCodexExhausted,
  noteCodexExhausted,
  onCodexAccountRefused,
  refusedCodexAccounts,
  setCodexAccounts,
  setCodexTokenRenewer,
  type CodexAccountSecret,
} from './codexAuth';
import { readCodexAuthJson, renewCodexSignIn, type CodexHomeRunner, type CodexSignedIn } from './codexSignIn';

const KEY = 'agent.codex.accounts';
/** Accounts out of usage, and until when (ms): kept across restarts. */
const EXHAUSTED_KEY = 'agent.codex.exhausted';

interface StoredAccount {
  id: string;
  label: string;
  email: string | null;
  plan: string | null;
  /** Who signed in, and in which workspace (codexSignIn.ts): how a second
   *  sign-in of the same ChatGPT account is recognised. */
  identity: string;
  /** When its current sign-in was made. */
  addedAt: number;
  /** Codex's auth.json, encrypted with safeStorage, base64. */
  sealed: string;
  /** OpenAI will not renew this sign-in any more: it must be made again. */
  dead?: boolean;
}

interface Stored {
  activeId: string | null;
  accounts: StoredAccount[];
}

/** An accounts action that failed for a reason the window words itself
 *  (CodexAccountsFailure); the message is only the detail under it. */
export class CodexAccountError extends Error {
  constructor(public readonly reason: CodexAccountsFailure, message: string) {
    super(message);
    this.name = 'CodexAccountError';
  }
}

const NO_STORE = 'This system has no encrypted credential store for PopBot to keep the sign-in in.';

const listeners = new Set<() => void>();
let offRefused: (() => void) | null = null;
/** Sealed sign-ins already logged as unreadable: the list is read often. */
const unsealFailed = new Set<string>();

function stored(): Stored {
  const s = getSetting<Stored>(KEY);
  return { activeId: s?.activeId ?? null, accounts: Array.isArray(s?.accounts) ? s!.accounts : [] };
}

function unseal(a: StoredAccount): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(a.sealed, 'base64'));
  } catch (err) {
    if (!unsealFailed.has(a.sealed)) {
      unsealFailed.add(a.sealed);
      dlog('codex.accounts.unseal-failed', { id: a.id, error: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
}

function seal(authJson: string): string {
  return safeStorage.encryptString(authJson).toString('base64');
}

/**
 * What a Codex process needs of each account, for this process and the
 * hosts: the access token and the workspace it is for — never the
 * sign-in. An account whose sign-in can't be read, or that OpenAI will
 * not renew, is left out: nothing can run on it.
 */
export function codexAccountSecrets(): { activeId: string | null; accounts: CodexAccountSecret[] } {
  const s = stored();
  const accounts: CodexAccountSecret[] = [];
  for (const a of s.accounts) {
    if (a.dead) continue;
    const authJson = unseal(a);
    const facts = authJson ? readCodexAuthJson(authJson) : null;
    if (facts) accounts.push({ id: a.id, label: a.label, accessToken: facts.accessToken, chatgptAccountId: facts.chatgptAccountId, planType: facts.plan });
  }
  return { activeId: s.activeId, accounts };
}

/** Put what is stored into memory. A move made there (the active account
 *  is out of usage) is stored too, as for Claude accounts. */
function intoMemory(s: Stored): void {
  const secrets = codexAccountSecrets();
  setCodexAccounts(secrets.accounts, secrets.activeId);
  const activeId = activeCodexAccountId();
  if (activeId && activeId !== s.activeId) setSetting(KEY, { ...s, activeId });
}

function save(next: Stored): void {
  setSetting(KEY, next);
  intoMemory(next);
  notify();
}

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* a listener's bug must not stop the others */ }
  }
}

/** Load the stored accounts into memory (at launch). */
export function loadCodexAccounts(): void {
  noteCodexExhausted(getSetting<Record<string, number>>(EXHAUSTED_KEY));
  intoMemory(stored());
  // A token refused in a chat (codexAuth.ts) is news for the window too.
  offRefused ??= onCodexAccountRefused(() => notify());
}

/** The accounts as the renderer sees them: never a token. `active` is the
 *  account the chats are on right now, which is what memory holds. */
export function listCodexAccounts(): CodexAccountInfo[] {
  const s = stored();
  const out = exhaustedCodexAccounts();
  const activeId = activeCodexAccountId();
  const refused = new Set(refusedCodexAccounts());
  return s.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    email: a.email,
    plan: a.plan,
    addedAt: a.addedAt,
    active: a.id === activeId,
    ...(out[a.id] ? { outOfUsageUntil: out[a.id] } : {}),
    ...(unseal(a) ? {} : { unreadable: true }),
    ...(a.dead || refused.has(a.id) ? { needsSignIn: true } : {}),
  }));
}

export function onCodexAccountsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The id of the account that already holds this ChatGPT sign-in, if any. */
export function codexAccountHolding(identity: string): string | null {
  return stored().accounts.find((a) => a.identity === identity)?.id ?? null;
}

/** Save a sign-in just made as a new account (the first becomes active). */
export function addCodexAccount(label: string, signIn: CodexSignedIn): CodexAccountInfo {
  if (!claudeAccountsEncryptionAvailable()) throw new CodexAccountError('no-store', NO_STORE);
  const s = stored();
  const holder = s.accounts.find((a) => a.identity === signIn.facts.identity);
  if (holder) throw new CodexAccountError('duplicate', `That ChatGPT account is already here as “${holder.label}”.`);
  const account: StoredAccount = {
    id: `cdx_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    label: label.trim() || signIn.facts.email || `Account ${s.accounts.length + 1}`,
    email: signIn.facts.email,
    plan: signIn.facts.plan,
    identity: signIn.facts.identity,
    addedAt: Date.now(),
    sealed: seal(signIn.authJson),
  };
  save({ activeId: s.activeId ?? account.id, accounts: [...s.accounts, account] });
  const active = activeCodexAccountId() === account.id;
  dlog('codex.accounts.added', { id: account.id, active, plan: account.plan });
  if (signIn.outOfUsageUntil !== null) noteCodexAccountOutOfUsage(account.id, signIn.outOfUsageUntil || null);
  return { id: account.id, label: account.label, email: account.email, plan: account.plan, addedAt: account.addedAt, active };
}

/** Replace an account's sign-in with one just made — which must be of
 *  the same ChatGPT account, or the name on the card would be a lie. */
export function renewCodexAccount(id: string, signIn: CodexSignedIn): void {
  if (!claudeAccountsEncryptionAvailable()) throw new CodexAccountError('no-store', NO_STORE);
  const s = stored();
  const account = s.accounts.find((a) => a.id === id);
  if (!account) throw new Error(`no account ${id}`);
  if (account.identity !== signIn.facts.identity) {
    throw new CodexAccountError('mismatch', `The browser signed in as ${signIn.facts.email ?? 'another ChatGPT account'}, not ${account.email ?? account.label}.`);
  }
  save({
    ...s,
    accounts: s.accounts.map((a) => (a.id === id
      ? { ...a, email: signIn.facts.email ?? a.email, plan: signIn.facts.plan ?? a.plan, addedAt: Date.now(), sealed: seal(signIn.authJson), dead: undefined }
      : a)),
  });
  dlog('codex.accounts.signed-in-again', { id });
  if (signIn.outOfUsageUntil !== null) noteCodexAccountOutOfUsage(id, signIn.outOfUsageUntil || null);
}

export function removeCodexAccount(id: string): void {
  const s = stored();
  const accounts = s.accounts.filter((a) => a.id !== id);
  save({ activeId: s.activeId === id ? (accounts[0]?.id ?? null) : s.activeId, accounts });
  dlog('codex.accounts.removed', { id });
}

/** Make an account the one every Codex chat runs on (null: this
 *  computer's own Codex sign-in). */
export function setActiveCodexAccount(id: string | null): void {
  const s = stored();
  if (id !== null && !s.accounts.some((a) => a.id === id)) throw new Error(`no account ${id}`);
  if (s.activeId === id) return;
  save({ ...s, activeId: id });
  dlog('codex.accounts.active', { id });
}

export function renameCodexAccount(id: string, label: string): void {
  const s = stored();
  save({ ...s, accounts: s.accounts.map((a) => (a.id === id ? { ...a, label: label.trim() || a.label } : a)) });
}

// ── Out of usage ─────────────────────────────────────────────────────

/** An account ran out of usage (a chat's usage-limit event): mark it,
 *  move every chat to the next account that has usage, and keep both
 *  across restarts. Hosts hear through the usual push. */
export function failOverCodexAccount(accountId: string | null, resetsAt: number | null): UsageFailover {
  const was = activeCodexAccountId();
  const outcome = failOverCodexFromExhausted(accountId, resetsAt);
  setSetting(EXHAUSTED_KEY, exhaustedCodexAccounts());
  if (outcome.kind === 'switched') {
    const s = stored();
    if (s.activeId !== outcome.to) setSetting(KEY, { ...s, activeId: outcome.to });
    if (was !== outcome.to) dlog('codex.accounts.failover', { from: outcome.from, to: outcome.to });
  } else if (outcome.kind === 'none-left') {
    dlog('codex.accounts.all-out', { earliestReset: outcome.earliestReset });
  }
  notify();
  return outcome;
}

/** A sign-in found the account with no usage left (until `resetsAt`, ms,
 *  when Codex said): marked as a chat's limit would mark it. */
export function noteCodexAccountOutOfUsage(id: string, resetsAt: number | null): void {
  dlog('codex.accounts.out-of-usage', { id, resetsAt });
  failOverCodexAccount(id, resetsAt);
}

/** What a host knows is out of usage: adopt it, and move off the active
 *  account if it is one of them. */
export function adoptExhaustedCodexAccounts(marks: Record<string, number> | null | undefined): void {
  if (!marks || Object.keys(marks).length === 0) return;
  const before = JSON.stringify(exhaustedCodexAccounts());
  noteCodexExhausted(marks);
  if (JSON.stringify(exhaustedCodexAccounts()) === before) return;
  setSetting(EXHAUSTED_KEY, exhaustedCodexAccounts());
  const active = stored().activeId;
  if (active && isCodexExhausted(active)) failOverCodexAccount(active, marks[active] ?? null);
  else notify();
}

// ── Renewing ─────────────────────────────────────────────────────────

/** An access token lasts about ten days; it is renewed when this much of
 *  that is left, so a host given it today still has days on it. */
const RENEW_WHEN_LEFT_MS = 4 * 24 * 60 * 60_000;
const RENEW_CHECK_EVERY_MS = 3 * 60 * 60_000;

/** Renewals under way, one per account: a second asker waits for the first. */
const renewing = new Map<string, Promise<void>>();
let runner: (() => Promise<CodexHomeRunner | null>) | null = null;

/**
 * Have Codex renew one account's sign-in now, and store what comes back.
 * One at a time per account: the sign-in being renewed is spent by the
 * renewal, so two at once would leave one of them refused.
 */
export function renewCodexAccountNow(id: string): Promise<void> {
  const running = renewing.get(id);
  if (running) return running;
  const work = (async (): Promise<void> => {
    const account = stored().accounts.find((a) => a.id === id);
    const authJson = account ? unseal(account) : null;
    const how = runner ? await runner() : null;
    if (!account || !authJson || !how) return;
    const renewal = await renewCodexSignIn(how, authJson);
    // Read again: the accounts may have changed while Codex was at it.
    const s = stored();
    if (!s.accounts.some((a) => a.id === id)) return;
    if (renewal.ok) {
      save({ ...s, accounts: s.accounts.map((a) => (a.id === id ? { ...a, plan: renewal.facts.plan ?? a.plan, sealed: seal(renewal.authJson), dead: undefined } : a)) });
      dlog('codex.accounts.renewed', { id, expiresAt: renewal.facts.expiresAt });
    } else if (renewal.dead) {
      save({ ...s, accounts: s.accounts.map((a) => (a.id === id ? { ...a, dead: true } : a)) });
      dlog('codex.accounts.sign-in-dead', { id, error: renewal.error.slice(0, 200) });
    } else {
      dlog('codex.accounts.renew-failed', { id, error: renewal.error.slice(0, 200) });
    }
  })().finally(() => renewing.delete(id));
  renewing.set(id, work);
  return work;
}

/** Renew every account whose access token is close to its end. */
export async function renewDueCodexAccounts(now = Date.now()): Promise<void> {
  for (const a of stored().accounts) {
    if (a.dead) continue;
    const authJson = unseal(a);
    const facts = authJson ? readCodexAuthJson(authJson) : null;
    if (!facts) continue;
    if (facts.expiresAt !== null && facts.expiresAt - now > RENEW_WHEN_LEFT_MS) continue;
    await renewCodexAccountNow(a.id);
  }
}

let renewalStarted = false;

/**
 * Keep the sign-ins renewed: shortly after launch, every few hours, and
 * whenever a Codex process is told its token is no good (codexAuth.ts
 * asks through the renewer). `how` finds the Codex CLI to do it with.
 */
export function startCodexAccountRenewal(how: () => Promise<CodexHomeRunner | null>): void {
  runner = how;
  setCodexTokenRenewer((id) => renewCodexAccountNow(id));
  if (renewalStarted) return;
  renewalStarted = true;
  setTimeout(() => void renewDueCodexAccounts(), 20_000).unref?.();
  setInterval(() => void renewDueCodexAccounts(), RENEW_CHECK_EVERY_MS).unref?.();
}

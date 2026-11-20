/**
 * PopBot's Claude accounts, on the desktop: each a name and a long-lived
 * token (`claude setup-token`), exactly one active. Every Claude chat runs
 * on the active one — here and on every host (claudeAccountsSync.ts) —
 * and switching moves them all (AgentHost restarts each at its next idle
 * moment, resuming its session).
 *
 * Tokens are stored encrypted with the OS's own store through Electron's
 * safeStorage — the Keychain on macOS, DPAPI on Windows, the Secret
 * Service on Linux — never in plain text; the running app holds them in
 * memory (claudeAuth.ts).
 */
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { ClaudeAccountInfo, ClaudeAccountsFailure } from '@shared/ipc';
import { getSetting, setSetting } from '../persistence/settings';
import { dlog } from '../diagLog';
import {
  activeClaudeAccountId,
  clearClaudeAccountRefused,
  exhaustedAccounts,
  failOverFromExhausted,
  isExhausted,
  noteExhausted,
  onClaudeAccountRefused,
  refusedClaudeAccounts,
  setClaudeAccounts,
  type ClaudeAccountSecret,
  type UsageFailover,
} from './claudeAuth';
import { judgeTokenCheck, type ClaudeTokenCheck } from './claudeTokenCheck';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

const KEY = 'agent.claude.accounts';
/** Accounts out of usage, and until when (ms): kept across restarts. */
const EXHAUSTED_KEY = 'agent.claude.exhausted';

interface StoredAccount {
  id: string;
  label: string;
  addedAt: number;
  /** The token, encrypted with safeStorage, base64. */
  sealed: string;
}

interface Stored {
  activeId: string | null;
  accounts: StoredAccount[];
}

/** An accounts action that failed for a reason the window words itself
 *  (ClaudeAccountsFailure); the message is only the detail under it. */
export class ClaudeAccountError extends Error {
  constructor(public readonly reason: ClaudeAccountsFailure, message: string) {
    super(message);
    this.name = 'ClaudeAccountError';
  }
}

const NO_STORE = 'This system has no encrypted credential store for PopBot to keep the token in.';

/** A token as it is kept and sent. None has whitespace in it; one copied
 *  from a terminal that wrapped it comes with a line break in the middle. */
function bareToken(token: string): string {
  return token.replace(/\s+/g, '');
}

const listeners = new Set<() => void>();
/** Set once loadClaudeAccounts() is listening for refused sign-ins. */
let offRefused: (() => void) | null = null;
/** Sealed tokens already logged as unreadable: the list is read often. */
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
      dlog('claude.accounts.unseal-failed', { id: a.id, error: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
}

/** The accounts with their tokens, for this process and the hosts. */
export function claudeAccountSecrets(): { activeId: string | null; accounts: ClaudeAccountSecret[] } {
  const s = stored();
  const accounts: ClaudeAccountSecret[] = [];
  for (const a of s.accounts) {
    const token = unseal(a);
    if (token) accounts.push({ id: a.id, label: a.label, token });
  }
  return { activeId: s.activeId, accounts };
}

/**
 * Put what is stored into memory. An active account that is out of usage
 * gives way there to the next one (claudeAuth.ts); that move is stored
 * too, so the account shown as in use — and the one the next launch
 * starts on — is the one the chats are really on. Only a move is stored:
 * no account active in memory (its token can't be read) leaves the
 * stored choice alone.
 */
function intoMemory(s: Stored): void {
  const secrets = claudeAccountSecrets();
  setClaudeAccounts(secrets.accounts, secrets.activeId);
  const activeId = activeClaudeAccountId();
  if (activeId && activeId !== s.activeId) setSetting(KEY, { ...s, activeId });
}

function save(next: Stored): void {
  setSetting(KEY, next);
  intoMemory(next);
  notify();
}

/** Load the stored accounts into memory (at launch). */
export function loadClaudeAccounts(): void {
  noteExhausted(getSetting<Record<string, number>>(EXHAUSTED_KEY));
  intoMemory(stored());
  // A sign-in refused in a chat (claudeAuth.ts) is news for the window too.
  offRefused ??= onClaudeAccountRefused(() => notify());
}

/** The accounts as the renderer sees them: never a token. `active` is the
 *  account the chats are on right now, which is what memory holds. */
export function listClaudeAccounts(): ClaudeAccountInfo[] {
  const s = stored();
  const out = exhaustedAccounts();
  const activeId = activeClaudeAccountId();
  const refused = new Set(refusedClaudeAccounts());
  return s.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    addedAt: a.addedAt,
    active: a.id === activeId,
    ...(out[a.id] ? { outOfUsageUntil: out[a.id] } : {}),
    // claudeAccountSecrets() leaves such an account out, so no chat can run on it.
    ...(unseal(a) ? {} : { unreadable: true }),
    ...(refused.has(a.id) ? { needsSignIn: true } : {}),
  }));
}

/** Whether tokens can be stored encrypted here (false on a Linux box with
 *  no keyring, where safeStorage would only obfuscate them). */
export function claudeAccountsEncryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return backend !== 'basic_text';
}

export function addClaudeAccount(label: string, token: string): ClaudeAccountInfo {
  if (!claudeAccountsEncryptionAvailable()) throw new ClaudeAccountError('no-store', NO_STORE);
  const s = stored();
  const account: StoredAccount = {
    id: `acct_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    label: label.trim() || `Account ${s.accounts.length + 1}`,
    addedAt: Date.now(),
    sealed: safeStorage.encryptString(bareToken(token)).toString('base64'),
  };
  // The first account becomes active; later ones wait to be picked.
  save({ activeId: s.activeId ?? account.id, accounts: [...s.accounts, account] });
  const active = activeClaudeAccountId() === account.id;
  dlog('claude.accounts.added', { id: account.id, active });
  return { id: account.id, label: account.label, addedAt: account.addedAt, active };
}

export function removeClaudeAccount(id: string): void {
  const s = stored();
  const accounts = s.accounts.filter((a) => a.id !== id);
  save({ activeId: s.activeId === id ? (accounts[0]?.id ?? null) : s.activeId, accounts });
  dlog('claude.accounts.removed', { id });
}

/** Make an account the one every chat runs on (null: the CLI's own login). */
export function setActiveClaudeAccount(id: string | null): void {
  const s = stored();
  if (id !== null && !s.accounts.some((a) => a.id === id)) throw new Error(`no account ${id}`);
  if (s.activeId === id) return;
  save({ ...s, activeId: id });
  dlog('claude.accounts.active', { id });
}

/** Replace an account's token (a new `claude setup-token`). */
export function setClaudeAccountToken(id: string, token: string): void {
  if (!claudeAccountsEncryptionAvailable()) throw new ClaudeAccountError('no-store', NO_STORE);
  const s = stored();
  if (!s.accounts.some((a) => a.id === id)) throw new Error(`no account ${id}`);
  const sealed = safeStorage.encryptString(bareToken(token)).toString('base64');
  // The token was just checked: the same one saved again is no longer refused.
  clearClaudeAccountRefused(id);
  save({ ...s, accounts: s.accounts.map((a) => (a.id === id ? { ...a, sealed, addedAt: Date.now() } : a)) });
  dlog('claude.accounts.token-replaced', { id });
}

export function renameClaudeAccount(id: string, label: string): void {
  const s = stored();
  save({ ...s, accounts: s.accounts.map((a) => (a.id === id ? { ...a, label: label.trim() || a.label } : a)) });
}

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* a listener's bug must not stop the others */ }
  }
}

/**
 * An account ran out of usage (a chat's usage-limit event): mark it, move
 * every chat to the next account that has usage, and keep both across
 * restarts. Hosts hear through the usual push (claudeAccountsSync.ts).
 */
export function failOverClaudeAccount(accountId: string | null, resetsAt: number | null): UsageFailover {
  const was = activeClaudeAccountId();
  const outcome = failOverFromExhausted(accountId, resetsAt);
  setSetting(EXHAUSTED_KEY, exhaustedAccounts());
  if (outcome.kind === 'switched') {
    const s = stored();
    if (s.activeId !== outcome.to) setSetting(KEY, { ...s, activeId: outcome.to });
    // Logged only when the chats really moved: an account marked out while
    // another is in use (a later chat's report, a token check) moves nothing.
    if (was !== outcome.to) dlog('claude.accounts.failover', { from: outcome.from, to: outcome.to });
  } else if (outcome.kind === 'none-left') {
    dlog('claude.accounts.all-out', { earliestReset: outcome.earliestReset });
  }
  notify();
  return outcome;
}

/** A token check found the account signed in but out of usage (until
 *  `resetsAt`, ms, when Claude said): marked as a chat's limit would mark
 *  it, so it waits its turn instead of being the account chats fail on. */
export function noteClaudeAccountOutOfUsage(id: string, resetsAt: number | null): void {
  dlog('claude.accounts.out-of-usage', { id, resetsAt });
  failOverClaudeAccount(id, resetsAt);
}

/** What a host knows is out of usage: adopt it, and move off the active
 *  account if it is one of them. */
export function adoptExhaustedClaudeAccounts(marks: Record<string, number> | null | undefined): void {
  if (!marks || Object.keys(marks).length === 0) return;
  const before = JSON.stringify(exhaustedAccounts());
  noteExhausted(marks);
  if (JSON.stringify(exhaustedAccounts()) === before) return;
  setSetting(EXHAUSTED_KEY, exhaustedAccounts());
  const active = stored().activeId;
  if (active && isExhausted(active)) failOverClaudeAccount(active, marks[active] ?? null);
  else notify();
}

export function onClaudeAccountsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type { ClaudeTokenCheck } from './claudeTokenCheck';

const CHECK_TIME_LIMIT_MS = 90_000;

/**
 * Does Claude take this sign-in? One tiny request through the Claude CLI
 * on it — the token on file descriptor 3, as every chat gets it — so a
 * pasted token is checked before any chat depends on it. Run against an
 * empty config folder: with the machine's own login there, a refused
 * token falls back to that login and the check would pass on the wrong
 * one. What the CLI answers is read by claudeTokenCheck.ts: an account
 * that is signed in but out of usage passes, and is said to be so.
 *
 * Every verdict is logged with the token's length — never the token — so
 * a copy cut short at a terminal's edge can be told from a real refusal.
 */
export function verifyClaudeToken(binary: string, token: string): Promise<ClaudeTokenCheck> {
  const bare = bareToken(token);
  const configDir = mkdtempSync(join(tmpdir(), 'popbot-claude-check-'));
  return new Promise<ClaudeTokenCheck>((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const viaFd = process.platform !== 'win32';
    if (viaFd) env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = '3';
    else env.CLAUDE_CODE_OAUTH_TOKEN = bare;
    const child = spawn(
      binary,
      ['-p', '--model', 'claude-haiku-5-5', '--max-turns', '1', '--output-format', 'stream-json', '--verbose', 'Reply with exactly: OK'],
      { env, stdio: viaFd ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    if (viaFd) {
      const fd = child.stdio[3] as Writable | null;
      fd?.on('error', () => undefined);
      fd?.end(bare);
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: `The Claude CLI gave no answer in ${CHECK_TIME_LIMIT_MS / 1000} seconds.`, timedOut: true });
    }, CHECK_TIME_LIMIT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(judgeTokenCheck(code, stdout, stderr)); });
  })
    .then((check) => {
      dlog('claude.accounts.check', check.ok
        ? { ok: true, tokenLength: bare.length, ...(check.outOfUsage ? { outOfUsage: true, resetsAt: check.outOfUsage.resetsAt } : {}) }
        : { ok: false, tokenLength: bare.length, refused: check.refused === true, timedOut: check.timedOut === true, said: check.error });
      return check;
    })
    .finally(() => rmSync(configDir, { recursive: true, force: true }));
}

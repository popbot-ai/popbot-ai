import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { IpcChannel, type ClaudeAccountsResult, type ClaudeAccountsState, type ClaudeSignInEvent } from '@shared/ipc';
import {
  ClaudeAccountError,
  addClaudeAccount,
  claudeAccountsEncryptionAvailable,
  listClaudeAccounts,
  noteClaudeAccountOutOfUsage,
  onClaudeAccountsChange,
  removeClaudeAccount,
  renameClaudeAccount,
  setActiveClaudeAccount,
  setClaudeAccountToken,
  verifyClaudeToken,
} from '../agents/claudeAccounts';
import { claudeAccountsOutdatedHosts, onClaudeAccountsOutdatedHostsChange } from '../agents/claudeAccountsSync';
import { probeClaude } from '../agents/claudeProbe';
import { runSetupToken, type SetupTokenRun } from '../agents/claudeSetupToken';

function state(): ClaudeAccountsState {
  const outdatedHosts = claudeAccountsOutdatedHosts();
  return {
    accounts: listClaudeAccounts(),
    encryptionAvailable: claudeAccountsEncryptionAvailable(),
    ...(outdatedHosts.length > 0 ? { outdatedHosts } : {}),
  };
}

/** Tell every window how the accounts now stand. The window that asked
 *  for a change hears it here as well, just before its own answer. */
function pushState(): void {
  const s = state();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.ClaudeAccountsChanged, s);
  }
}

async function run(fn: () => void | Promise<void>): Promise<ClaudeAccountsResult> {
  try {
    await fn();
    return { ok: true, ...state() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      // The window words its message by the reason; `error` is the detail.
      reason: err instanceof ClaudeAccountError ? err.reason : 'other',
      ...state(),
    };
  }
}

/** What a token's check found: the token as it is stored, and whether the
 *  account it signs in is out of usage (until `resetsAt`, ms, if known). */
interface Verified {
  token: string;
  outOfUsage?: { resetsAt: number | null };
}

/** A token is checked with one tiny request before it is kept. A sign-in
 *  Claude takes passes even when the account has no usage left: that is
 *  an account to keep, and it is marked so once saved (keep()). */
async function verified(token: string): Promise<Verified> {
  // All whitespace goes, not only the ends: a token copied from a terminal
  // that wrapped it arrives with line breaks inside.
  const t = typeof token === 'string' ? token.replace(/\s+/g, '') : '';
  if (!t) throw new Error('Paste the token `claude setup-token` printed.');
  const probe = await probeClaude();
  if (!probe.ok || !probe.binaryPath) throw new ClaudeAccountError('no-cli', probe.error ?? 'The Claude CLI is not installed.');
  const check = await verifyClaudeToken(probe.binaryPath, t);
  if (!check.ok) throw new ClaudeAccountError(check.timedOut ? 'timeout' : check.refused ? 'refused' : 'other', check.error);
  return { token: t, ...(check.outOfUsage ? { outOfUsage: check.outOfUsage } : {}) };
}

/** Save a checked token with `save` (which says whose it now is), and mark
 *  that account out of usage if that is what the check found. */
function keep(v: Verified, save: (token: string) => string): void {
  const id = save(v.token);
  if (v.outOfUsage) noteClaudeAccountOutOfUsage(id, v.outOfUsage.resetsAt);
}

const adding = (label: unknown) => (token: string): string => addClaudeAccount(typeof label === 'string' ? label : '', token).id;
const replacing = (id: unknown) => (token: string): string => {
  setClaudeAccountToken(String(id), token);
  return String(id);
};

// ── A sign-in PopBot runs itself (agents/claudeSetupToken.ts) ────────
//
// One at a time. The token it produces waits here, in memory, for the
// window to say which account it is for. It stays until an account has
// been saved with it — a check that fails or times out can be run again
// without another trip through the browser — and is dropped when the
// sign-in is cancelled or restarted, and after PENDING_TTL_MS.

const PENDING_TTL_MS = 10 * 60_000;
let signIn: SetupTokenRun | null = null;
let attempt: object | null = null;
let pendingToken: { token: string; at: number; checking: boolean } | null = null;

function tell(wc: WebContents, event: ClaudeSignInEvent): void {
  if (!wc.isDestroyed()) wc.send(IpcChannel.ClaudeAccountsSignInEvent, event);
}

function stopSignIn(): void {
  signIn?.cancel();
  signIn = null;
  attempt = null;
  pendingToken = null;
}

/**
 * Check the token the sign-in produced, then save it with `save`. The
 * token is read, not taken: it is let go only once it is saved, and only
 * if it is still the one waiting (a newer sign-in may have put another in
 * its place while this one was being checked). A check already running
 * when the sign-in is cancelled still finishes and saves.
 */
async function saveSignedIn(save: (token: string) => string): Promise<void> {
  if (pendingToken && Date.now() - pendingToken.at > PENDING_TTL_MS) pendingToken = null;
  const p = pendingToken;
  if (!p) throw new ClaudeAccountError('sign-in-gone', 'That sign-in is no longer waiting. Sign in again.');
  // One check at a time, or the same sign-in could be saved twice.
  if (p.checking) throw new Error('PopBot is already checking this sign-in.');
  p.checking = true;
  try {
    keep(await verified(p.token), save);
    if (pendingToken === p) pendingToken = null;
  } finally {
    p.checking = false;
  }
}

export function registerClaudeAccountsHandlers(): void {
  // The window is told of every change, so it never has to ask again: a
  // save, a failover, a sign-in refused in a chat, a host found too old.
  onClaudeAccountsChange(pushState);
  onClaudeAccountsOutdatedHostsChange(pushState);

  ipcMain.handle(IpcChannel.ClaudeAccountsSignInStart, async (e, opts?: { openBrowser?: boolean }) => {
    stopSignIn();
    // This attempt's marker, claimed before anything is awaited: a later
    // start replaces it, and what an older attempt still says is dropped.
    // (The runner may report a failure before it has even returned.) A
    // cancel or another start that arrives while the CLI is still being
    // looked for takes the marker too — and then no CLI is started at all,
    // where it used to start with nothing left to stop it.
    const mine = {};
    attempt = mine;
    const probe = await probeClaude();
    if (attempt !== mine) return { ok: false as const, error: 'The sign-in was cancelled.' };
    if (!probe.ok || !probe.binaryPath) {
      attempt = null;
      return { ok: false as const, error: probe.error ?? 'The Claude CLI is not installed.' };
    }
    const wc = e.sender;
    const started = runSetupToken(probe.binaryPath, { openBrowser: opts?.openBrowser === true }, (event) => {
      if (attempt !== mine) return;
      if (event.type === 'token') {
        signIn = null;
        pendingToken = { token: event.token, at: Date.now(), checking: false };
        tell(wc, { type: 'token-ready' });
        return;
      }
      if (event.type === 'code-refused' || event.type === 'failed') {
        signIn = null;
        attempt = null;
      }
      tell(wc, event);
    });
    if (attempt === mine) signIn = started;
    return { ok: true as const, cliOpensBrowser: started.opensBrowser };
  });
  ipcMain.handle(IpcChannel.ClaudeAccountsSignInCode, (_e, code: string) => signIn?.sendCode(typeof code === 'string' ? code : '') ?? false);
  ipcMain.handle(IpcChannel.ClaudeAccountsSignInCancel, () => stopSignIn());
  ipcMain.handle(IpcChannel.ClaudeAccountsAddSignedIn, (_e, label: string) => run(() => saveSignedIn(adding(label))));
  ipcMain.handle(IpcChannel.ClaudeAccountsSetTokenSignedIn, (_e, id: string) => run(() => saveSignedIn(replacing(id))));

  ipcMain.handle(IpcChannel.ClaudeAccountsList, () => state());
  ipcMain.handle(IpcChannel.ClaudeAccountsAdd, (_e, label: string, token: string) =>
    run(async () => keep(await verified(token), adding(label))));
  ipcMain.handle(IpcChannel.ClaudeAccountsSetToken, (_e, id: string, token: string) =>
    run(async () => keep(await verified(token), replacing(id))));
  ipcMain.handle(IpcChannel.ClaudeAccountsRename, (_e, id: string, label: string) =>
    run(() => renameClaudeAccount(String(id), typeof label === 'string' ? label : '')));
  ipcMain.handle(IpcChannel.ClaudeAccountsRemove, (_e, id: string) => run(() => removeClaudeAccount(String(id))));
  ipcMain.handle(IpcChannel.ClaudeAccountsSetActive, (_e, id: string | null) =>
    run(() => setActiveClaudeAccount(typeof id === 'string' ? id : null)));
}

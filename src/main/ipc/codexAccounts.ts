import { BrowserWindow, ipcMain, shell, type WebContents } from 'electron';
import { IpcChannel, type CodexAccountsResult, type CodexAccountsState, type CodexSignInEvent } from '@shared/ipc';
import { claudeAccountsEncryptionAvailable } from '../agents/claudeAccounts';
import {
  CodexAccountError,
  addCodexAccount,
  codexAccountHolding,
  listCodexAccounts,
  onCodexAccountsChange,
  removeCodexAccount,
  renameCodexAccount,
  renewCodexAccount,
  setActiveCodexAccount,
  startCodexAccountRenewal,
} from '../agents/codexAccounts';
import { codexAccountsOutdatedHosts, onCodexAccountsOutdatedHostsChange } from '../agents/codexAccountsSync';
import { resolveCodexBinary } from '../agents/CodexAppServerBackend';
import { probeCodex } from '../agents/codexProbe';
import { runCodexSignIn, type CodexHomeRunner, type CodexSignInRun, type CodexSignedIn } from '../agents/codexSignIn';

function state(): CodexAccountsState {
  const accounts = listCodexAccounts();
  // A host too old for Codex accounts only matters once there are some.
  const outdatedHosts = accounts.length > 0 ? codexAccountsOutdatedHosts() : [];
  return {
    accounts,
    encryptionAvailable: claudeAccountsEncryptionAvailable(),
    ...(outdatedHosts.length > 0 ? { outdatedHosts } : {}),
  };
}

/** Tell every window how the accounts now stand. */
function pushState(): void {
  const s = state();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.CodexAccountsChanged, s);
  }
}

async function run(fn: () => void | Promise<void>): Promise<CodexAccountsResult> {
  try {
    await fn();
    return { ok: true, ...state() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      // The window words its message by the reason; `error` is the detail.
      reason: err instanceof CodexAccountError ? err.reason : 'other',
      ...state(),
    };
  }
}

/**
 * The Codex CLI that signs in and renews: the user's own when there is
 * one (it is the freshest), else the one that ships with PopBot. Null
 * when neither can be found.
 */
async function codexRunner(): Promise<CodexHomeRunner | null> {
  const probe = await probeCodex();
  const bin = resolveCodexBinary(probe.ok && probe.binaryPath ? probe.binaryPath : null);
  // `codex` bare means nothing was found: resolveCodexBinary's last resort.
  if (bin.path === 'codex' && !probe.ok) return null;
  return { codexPath: bin.path, pathDirs: bin.pathDirs };
}

// ── A sign-in PopBot runs itself (agents/codexSignIn.ts) ─────────────
//
// One at a time. The sign-in it produces waits here, in memory, for the
// window to say which account it is for; it is dropped when the sign-in
// is cancelled or restarted, once it is saved, and after PENDING_TTL_MS.

const PENDING_TTL_MS = 10 * 60_000;
let signIn: CodexSignInRun | null = null;
let attempt: object | null = null;
let pending: { signIn: CodexSignedIn; at: number } | null = null;

function tell(wc: WebContents, event: CodexSignInEvent): void {
  if (!wc.isDestroyed()) wc.send(IpcChannel.CodexAccountsSignInEvent, event);
}

function stopSignIn(): void {
  signIn?.cancel();
  signIn = null;
  attempt = null;
  pending = null;
}

/** The sign-in waiting to be saved, handed to `save`; let go once saved. */
function saveSignedIn(save: (signIn: CodexSignedIn) => void): void {
  if (pending && Date.now() - pending.at > PENDING_TTL_MS) pending = null;
  const p = pending;
  if (!p) throw new CodexAccountError('sign-in-gone', 'That sign-in is no longer waiting. Sign in again.');
  save(p.signIn);
  if (pending === p) pending = null;
}

export function registerCodexAccountsHandlers(): void {
  onCodexAccountsChange(pushState);
  onCodexAccountsOutdatedHostsChange(pushState);
  startCodexAccountRenewal(codexRunner);

  ipcMain.handle(IpcChannel.CodexAccountsSignInStart, async (e, opts?: { openBrowser?: boolean }) => {
    stopSignIn();
    // This attempt's marker, claimed before anything is awaited: a cancel
    // or another start that arrives while the CLI is being looked for
    // takes it, and then no sign-in is started at all.
    const mine = {};
    attempt = mine;
    if (!claudeAccountsEncryptionAvailable()) {
      attempt = null;
      return { ok: false as const, error: 'This computer has no encrypted place to keep a sign-in.' };
    }
    const how = await codexRunner();
    if (attempt !== mine) return { ok: false as const, error: 'The sign-in was cancelled.' };
    if (!how) {
      attempt = null;
      return { ok: false as const, error: 'The Codex CLI is not installed.' };
    }
    const wc = e.sender;
    const started = runCodexSignIn(how, (event) => {
      if (attempt !== mine) return;
      if (event.type === 'url') {
        // The page is the user's to open when they asked for the link only
        // (to open it where another ChatGPT account is signed in).
        if (opts?.openBrowser === true) void shell.openExternal(event.url).catch(() => undefined);
        tell(wc, event);
        return;
      }
      signIn = null;
      if (event.type === 'signed-in') {
        pending = { signIn: event.signIn, at: Date.now() };
        const duplicateOf = codexAccountHolding(event.signIn.facts.identity);
        tell(wc, {
          type: 'signed-in',
          email: event.signIn.facts.email,
          plan: event.signIn.facts.plan,
          ...(duplicateOf ? { duplicateOf } : {}),
          ...(event.signIn.outOfUsageUntil ? { outOfUsageUntil: event.signIn.outOfUsageUntil } : {}),
        });
        return;
      }
      attempt = null;
      tell(wc, event);
    });
    if (attempt === mine) signIn = started;
    return { ok: true as const };
  });
  ipcMain.handle(IpcChannel.CodexAccountsSignInCancel, () => stopSignIn());
  ipcMain.handle(IpcChannel.CodexAccountsAddSignedIn, (_e, label: string) =>
    run(() => saveSignedIn((made) => { addCodexAccount(typeof label === 'string' ? label : '', made); })));
  ipcMain.handle(IpcChannel.CodexAccountsRenewSignedIn, (_e, id: string) =>
    run(() => saveSignedIn((made) => renewCodexAccount(String(id), made))));

  ipcMain.handle(IpcChannel.CodexAccountsList, () => state());
  ipcMain.handle(IpcChannel.CodexAccountsRename, (_e, id: string, label: string) =>
    run(() => renameCodexAccount(String(id), typeof label === 'string' ? label : '')));
  ipcMain.handle(IpcChannel.CodexAccountsRemove, (_e, id: string) => run(() => removeCodexAccount(String(id))));
  ipcMain.handle(IpcChannel.CodexAccountsSetActive, (_e, id: string | null) =>
    run(() => setActiveCodexAccount(typeof id === 'string' ? id : null)));
}

/**
 * Every decision the Claude accounts pane makes (PrefsClaudeAccounts.tsx),
 * kept apart from React so it can be unit-tested: the repo has no
 * component-test harness. Pure — no `window`, no clock of its own; the
 * caller passes `now`.
 */
import type {
  ClaudeAccountInfo,
  ClaudeAccountsFailure,
  ClaudeAccountsState,
  ClaudeSignInEvent,
} from '@shared/ipc';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A sign-in token lasts one year from the moment it is made, and it is
 *  made at or before the moment it is saved — so past this age it has
 *  certainly expired. */
export const SIGN_IN_LIFETIME_MS = 365 * DAY_MS;
/** From here on the card says the sign-in is almost a year old. */
export const SIGN_IN_EXPIRING_MS = 335 * DAY_MS;

// ── Accounts ─────────────────────────────────────────────────────────

/** Out of usage right now: a mark at or before `now` counts as cleared. */
export function isOut(a: ClaudeAccountInfo, now: number): boolean {
  return a.outOfUsageUntil != null && a.outOfUsageUntil > now;
}

/**
 * What to say of an account just added. Its check may have found it signed
 * in but out of usage: it is kept all the same, and saying it "can be
 * switched to" would contradict the line above it on its card.
 */
export function addedVerdict(added: ClaudeAccountInfo, now: number): 'addedOut' | 'addedInUse' | 'addedStandby' {
  if (isOut(added, now)) return 'addedOut';
  return added.active ? 'addedInUse' : 'addedStandby';
}

/** The account every chat runs on, if any. */
export function inUse(accounts: ClaudeAccountInfo[]): ClaudeAccountInfo | null {
  return accounts.find((a) => a.active) ?? null;
}

export function isExpired(a: ClaudeAccountInfo, now: number): boolean {
  return now - a.addedAt >= SIGN_IN_LIFETIME_MS;
}

/** The accounts a chat can be run on. One whose saved sign-in can't be
 *  read is not among them: main leaves it out of the list failover walks
 *  (claudeAccountSecrets in main/agents/claudeAccounts.ts). */
function usable(accounts: ClaudeAccountInfo[]): ClaudeAccountInfo[] {
  return accounts.filter((a) => !a.unreadable);
}

/** The first usable account after `from` (down the list, wrapping) that
 *  is not out of usage — nextAvailableAccount in main/agents/claudeAuth.ts. */
function nextAvailable(accounts: ClaudeAccountInfo[], from: ClaudeAccountInfo, now: number): ClaudeAccountInfo | null {
  const list = usable(accounts);
  if (list.length === 0) return null;
  const start = Math.max(0, list.findIndex((a) => a.id === from.id));
  for (let i = 1; i <= list.length; i += 1) {
    const a = list[(start + i) % list.length];
    if (a.id !== from.id && !isOut(a, now)) return a;
  }
  return null;
}

/**
 * The account chats would move to if the one in use ran out of usage
 * now — the one card that carries "Next up". Failover goes round from the
 * account in use and never returns to the top by itself, so this is a
 * position relative to it, not a rank.
 */
export function nextUp(accounts: ClaudeAccountInfo[], now: number): ClaudeAccountInfo | null {
  const active = inUse(accounts);
  return active ? nextAvailable(accounts, active, now) : null;
}

/** No account a chat could run on has usage left. */
function allOut(accounts: ClaudeAccountInfo[], now: number): boolean {
  const list = usable(accounts);
  return list.length > 0 && list.every((a) => isOut(a, now));
}

// ── One card ─────────────────────────────────────────────────────────

/** Which row of the status table a card is on (first match wins). */
export type CardKind =
  | 'unreadable' | 'refused' | 'expired' | 'outInUse' | 'out'
  | 'expiring' | 'inUse' | 'next' | 'saved';

export interface CardView {
  kind: CardKind;
  /** The pill that names the card's problem. "In use" and "Next up" are
   *  separate pills, shown alongside it. */
  statePill: 'unreadable' | 'refused' | 'expired' | 'out' | null;
  /** The status line: the key under `prefs.accounts.status.`. */
  status: 'unreadable' | 'unreadableNoStore' | 'refused' | 'expired' | 'outInUse' | 'out' | 'expiring' | 'saved' | 'next';
  /** How the status line is marked: red, amber, or not at all. */
  tone: 'error' | 'wait' | null;
  inUse: boolean;
  nextUp: boolean;
  /** Whether the card offers "Use this account". */
  canUse: boolean;
  /** The card shows "Use this account" but it can't be pressed yet: the
   *  account is out of usage, and PopBot would move the chats straight
   *  off it again. Shown all the same, so where to switch is never a
   *  mystery; the status line says when it comes back. */
  useWaits: boolean;
  /** Whether its sign-in can be replaced here at all: a new one needs an
   *  encrypted place to be kept. */
  canSignIn: boolean;
  /** "Sign in again" is the card's main button: it is what fixes it. */
  signInPrimary: boolean;
}

export function cardView(
  a: ClaudeAccountInfo,
  accounts: ClaudeAccountInfo[],
  now: number,
  encryptionAvailable: boolean,
): CardView {
  const active = a.active;
  const next = nextUp(accounts, now)?.id === a.id;
  const base = { inUse: active, nextUp: next, canSignIn: encryptionAvailable };
  const row = (
    kind: CardKind,
    status: CardView['status'],
    statePill: CardView['statePill'],
    tone: CardView['tone'],
    canUse: boolean,
    signInPrimary: boolean,
  ): CardView => ({ ...base, kind, status, statePill, tone, canUse, useWaits: kind === 'out', signInPrimary: signInPrimary && encryptionAvailable });

  if (a.unreadable) return row('unreadable', encryptionAvailable ? 'unreadable' : 'unreadableNoStore', 'unreadable', 'error', false, true);
  if (a.needsSignIn) return row('refused', 'refused', 'refused', 'error', false, true);
  if (isExpired(a, now)) return row('expired', 'expired', 'expired', 'error', false, true);
  if (isOut(a, now)) {
    return active
      ? row('outInUse', 'outInUse', 'out', 'wait', false, false)
      : row('out', 'out', 'out', 'wait', false, false);
  }
  if (now - a.addedAt >= SIGN_IN_EXPIRING_MS) return row('expiring', 'expiring', null, 'wait', !active, true);
  if (active) return row('inUse', 'saved', null, null, false, false);
  if (next) return row('next', 'next', null, null, true, false);
  return row('saved', 'saved', null, null, true, false);
}

// ── The page ─────────────────────────────────────────────────────────

/** Which lead sentence the pane opens with: the key under `prefs.accounts.lead.`. */
export type LeadKind = 'noStore' | 'empty' | 'off' | 'allOut' | 'one' | 'many' | 'othersOut';

export function leadKind(state: ClaudeAccountsState, now: number): LeadKind {
  const { accounts } = state;
  if (accounts.length === 0) return state.encryptionAvailable ? 'empty' : 'noStore';
  if (!inUse(accounts)) return 'off';
  if (allOut(accounts, now)) return 'allOut';
  // An account that can't be read can't take over either, so it does not
  // count as a second one.
  if (usable(accounts).length <= 1) return 'one';
  return nextUp(accounts, now) ? 'many' : 'othersOut';
}

export type AlertView =
  | { kind: 'noStore' }
  /** Every account is out of usage; `account` gets usage back first, at `until`. */
  | { kind: 'allOut' | 'oneOut'; account: ClaudeAccountInfo; until: number };

/** The one alert bar above the cards, if anything is wrong enough for one. */
export function alertKind(state: ClaudeAccountsState, now: number): AlertView | null {
  // Without a store nothing here can be added or fixed, so that is the
  // one thing to say.
  if (!state.encryptionAvailable) return { kind: 'noStore' };
  const { accounts } = state;
  if (!inUse(accounts) || !allOut(accounts, now)) return null;
  let first: ClaudeAccountInfo | null = null;
  for (const a of usable(accounts)) {
    if (!first || (a.outOfUsageUntil ?? Infinity) < (first.outOfUsageUntil ?? Infinity)) first = a;
  }
  if (first?.outOfUsageUntil == null) return null;
  return { kind: accounts.length === 1 ? 'oneOut' : 'allOut', account: first, until: first.outOfUsageUntil };
}

/**
 * Whether the nav item carries its attention mark: the account in use has
 * a refused or expired sign-in, or an account is in use and every account
 * is out of usage. Nothing else lights it — in particular never a host.
 */
export function needsAttention(state: ClaudeAccountsState | null, now: number): boolean {
  if (!state) return false;
  const active = inUse(state.accounts);
  if (!active) return false;
  if (active.needsSignIn || isExpired(active, now)) return true;
  return allOut(state.accounts, now);
}

// ── The title bar's switcher ─────────────────────────────────────────

/** One line of the title bar's account menu. */
export interface SwitchRow {
  id: string;
  label: string;
  inUse: boolean;
  /** Pressing the line moves the chats to this account. */
  canUse: boolean;
  /** What the line says after the name (the key under
   *  `titlebar.account.row.`), or null: nothing to add. `signIn` is a
   *  Codex account's "sign-in needed" (codexAccountsView.ts). */
  note: 'inUse' | 'next' | 'out' | 'outInUse' | 'refused' | 'expired' | 'unreadable' | 'signIn' | null;
  /** When an out-of-usage account is back (ms). */
  until?: number;
}

/**
 * The name as a title-bar chip shows it: what comes before the "@" of an
 * address, since the chip has room for little and its logo already says
 * whose account it is. A name with no "@" is shown whole — and so is one
 * that starts with it, which has nothing before it to show. The full
 * name stays in the chip's tooltip and in its menu.
 */
export function shortAccountName(label: string): string {
  const name = label.trim();
  const at = name.indexOf('@');
  return at > 0 ? name.slice(0, at).trimEnd() || name : name;
}

/** What a title-bar chip shows: the name on the button and one line per
 *  account. Made for Claude accounts here and for Codex accounts in
 *  codexAccountsView.ts; one component draws both (AccountSwitcher.tsx). */
export interface SwitcherView {
  /** The account the chats run on; null: none (the computer's own sign-in). */
  name: string | null;
  attention: boolean;
  rows: SwitchRow[];
}

/**
 * The title bar's answer to "which account am I on, and how do I
 * switch": null when there are no accounts (nothing is shown), else the
 * name on the button and one line per account. The lines follow the
 * cards in Preferences exactly — what can be pressed there can be
 * pressed here — so the two never disagree.
 */
export function accountSwitcher(state: ClaudeAccountsState | null, now: number): SwitcherView | null {
  if (!state || state.accounts.length === 0) return null;
  const rows = state.accounts.map((a): SwitchRow => {
    const view = cardView(a, state.accounts, now, state.encryptionAvailable);
    const note: SwitchRow['note'] =
      view.kind === 'unreadable' || view.kind === 'refused' || view.kind === 'expired' || view.kind === 'out' || view.kind === 'outInUse'
        ? view.kind
        : view.inUse ? 'inUse' : view.nextUp ? 'next' : null;
    return {
      id: a.id,
      label: a.label,
      inUse: view.inUse,
      canUse: view.canUse,
      note,
      ...(a.outOfUsageUntil != null && isOut(a, now) ? { until: a.outOfUsageUntil } : {}),
    };
  });
  return { name: inUse(state.accounts)?.label ?? null, attention: needsAttention(state, now), rows };
}

/** The one-line summary on the Agents pane's pointer row. */
export function agentsSummary(state: ClaudeAccountsState): {
  key: 'running' | 'runningOne' | 'none' | 'off';
  vars: { name?: string; count?: number };
} {
  const active = inUse(state.accounts);
  if (state.accounts.length === 0) return { key: 'none', vars: {} };
  if (!active) return { key: 'off', vars: {} };
  if (state.accounts.length === 1) return { key: 'runningOne', vars: { name: active.label } };
  return { key: 'running', vars: { name: active.label, count: state.accounts.length } };
}

/**
 * PopBot moved chats by itself: between two states that no action in the
 * pane caused, the account in use changed and the one before is now out
 * of usage. The card of `to` then says whose place it took.
 */
export function tookOver(
  before: ClaudeAccountInfo[],
  after: ClaudeAccountInfo[],
  now: number,
): { from: ClaudeAccountInfo; to: ClaudeAccountInfo } | null {
  const was = inUse(before);
  const is = inUse(after);
  if (!was || !is || was.id === is.id) return null;
  const from = after.find((a) => a.id === was.id);
  return from && isOut(from, now) ? { from, to: is } : null;
}

// ── Removing ─────────────────────────────────────────────────────────

/**
 * The account in use once `id` is removed, as main will have it
 * (removeClaudeAccount, then setClaudeAccounts): removing another account
 * changes nothing; removing the one in use hands over to the first that
 * remains — or, when that one is out of usage, to the first after it
 * (wrapping) that is not. Null when no account ends up in use.
 */
export function activeAfterRemove(accounts: ClaudeAccountInfo[], id: string, now: number): ClaudeAccountInfo | null {
  const active = inUse(accounts);
  if (!active) return null;
  if (active.id !== id) return active;
  const remaining = accounts.filter((a) => a.id !== id);
  const first = remaining[0];
  // Main can't run chats on a sign-in it can't read, so nothing takes over.
  if (!first || first.unreadable) return null;
  if (!isOut(first, now)) return first;
  return nextAvailable(remaining, first, now) ?? first;
}

/** What the Remove dialog has to say: where chats go, by account. */
export type RemoveView =
  /** The account in use, with others left: chats move to `next`. */
  | { kind: 'inUse'; next: ClaudeAccountInfo }
  /** The account in use and the only one: back to each computer's own sign-in. */
  | { kind: 'only' }
  /** Not in use: chats stay on `active`. */
  | { kind: 'other'; active: ClaudeAccountInfo }
  /** No account is in use (or none will take over): nothing moves. */
  | { kind: 'off' };

export function removeView(accounts: ClaudeAccountInfo[], id: string, now: number): RemoveView {
  const active = inUse(accounts);
  if (!active) return { kind: 'off' };
  if (active.id !== id) return { kind: 'other', active };
  if (accounts.length === 1) return { kind: 'only' };
  const next = activeAfterRemove(accounts, id, now);
  return next ? { kind: 'inUse', next } : { kind: 'off' };
}

// ── Times ────────────────────────────────────────────────────────────

/** How to word a time: by the clock alone when it is today, "tomorrow",
 *  or with its date. Days are the user's own (local) days. */
export function whenKind(ts: number, now: number): 'today' | 'tomorrow' | 'later' {
  const then = new Date(ts);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(then, today)) return 'today';
  // Built from calendar fields, not by adding 24 hours: a day the clocks
  // change is not 24 hours long.
  if (sameDay(then, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1))) return 'tomorrow';
  return 'later';
}

// ── What was typed or pasted ─────────────────────────────────────────

/** A token as it should be sent: one copied across wrapped terminal
 *  lines comes with line breaks and spaces inside it. */
export function cleanToken(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * What a token field holds. Only an API key is certainly wrong; anything
 * else that is not a setup-token is still checked — pasting is the way
 * out when a sign-in can't be read, so a changed prefix must not shut it.
 */
export function tokenLooks(text: string): 'empty' | 'token' | 'api-key' | 'other' {
  const token = cleanToken(text);
  if (!token) return 'empty';
  if (token.startsWith('sk-ant-oat')) return 'token';
  if (token.startsWith('sk-ant-api')) return 'api-key';
  return 'other';
}

/** How long a token from `claude setup-token` is (sk-ant-oat01-…). */
export const SETUP_TOKEN_LENGTH = 108;

/**
 * A token that looks cut short: how many characters it has, or null when
 * it looks whole. A terminal narrower than the token shows it on two
 * lines, and a double-click (or a copy of the first line) takes only the
 * first — 79 characters in an 80-column window. Only a caution: Claude is
 * still asked, in case tokens change length.
 */
export function tokenCutOff(text: string): number | null {
  const token = cleanToken(text);
  return token.startsWith('sk-ant-oat01-') && token.length < SETUP_TOKEN_LENGTH ? token.length : null;
}

/**
 * What the code box holds. A refused code ends the sign-in, so the
 * obvious mistakes — the link itself, a sentence, a token — are caught
 * before anything is sent.
 */
export function codeLooks(text: string): 'empty' | 'token' | 'link' | 'spaces' | 'ok' {
  const code = text.trim();
  if (!code) return 'empty';
  if (cleanToken(code).startsWith('sk-ant-oat')) return 'token';
  if (/^http/i.test(code)) return 'link';
  if (/\s/.test(code)) return 'spaces';
  return 'ok';
}

/** The account that already goes by this name (trimmed, whatever the
 *  case), other than `exceptId` — the one being renamed. */
export function accountNamed(
  name: string,
  accounts: ClaudeAccountInfo[],
  exceptId?: string,
): ClaudeAccountInfo | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return accounts.find((a) => a.id !== exceptId && a.label.trim().toLowerCase() === wanted) ?? null;
}

/** Why a name can't be given to an account: the name is the only way to
 *  tell accounts apart, so it is never empty and never used twice. */
export function nameProblem(
  name: string,
  accounts: ClaudeAccountInfo[],
  exceptId?: string,
): null | 'empty' | 'duplicate' {
  if (!name.trim()) return 'empty';
  return accountNamed(name, accounts, exceptId) ? 'duplicate' : null;
}

/** The account an add produced: the one `after` has that `before` did not. */
export function newAccountIn(before: ClaudeAccountInfo[], after: ClaudeAccountInfo[]): ClaudeAccountInfo | null {
  const known = new Set(before.map((a) => a.id));
  return after.find((a) => !known.has(a.id)) ?? null;
}

// ── A check that did not pass ────────────────────────────────────────

/**
 * How a failed check is put: the headline (a key under `prefs.accounts.`)
 * and the ways on. Chosen by the reason main gives, never by reading the
 * CLI's text — that is only shown as the dim detail line.
 *   again    "Check again": the sign-in is still held, only the check repeats
 *   signIn   "Sign in again": a fresh browser sign-in
 */
export function checkFailure(reason: ClaudeAccountsFailure): {
  headline: 'check.refused' | 'check.timeout' | 'check.noCli' | 'check.gone' | 'check.other' | 'alert.noStore';
  again: boolean;
  signIn: boolean;
} {
  switch (reason) {
    case 'refused': return { headline: 'check.refused', again: true, signIn: true };
    case 'timeout': return { headline: 'check.timeout', again: true, signIn: true };
    case 'no-cli': return { headline: 'check.noCli', again: true, signIn: false };
    case 'sign-in-gone': return { headline: 'check.gone', again: false, signIn: true };
    case 'no-store': return { headline: 'alert.noStore', again: false, signIn: false };
    default: return { headline: 'check.other', again: true, signIn: true };
  }
}

// ── Text with markup in it ───────────────────────────────────────────

const MARK = '\u0000';

/** The value to translate a placeholder with so `splitMarked` finds it. */
export function marker(name: string): string {
  return `${MARK}${name}${MARK}`;
}

/**
 * A translated sentence cut at its markers: plain text and, where a
 * marker stood, its name — so the pane can put an element there (the
 * account's name in bold, the command as code) wherever a language's
 * word order places it.
 */
export function splitMarked(text: string): Array<string | { mark: string }> {
  const out: Array<string | { mark: string }> = [];
  text.split(MARK).forEach((piece, i) => {
    if (i % 2 === 1) out.push({ mark: piece });
    else if (piece) out.push(piece);
  });
  return out;
}

// ── The sign-in PopBot runs ──────────────────────────────────────────
//
// One browser sign-in at a time, for a new account or to replace one
// account's sign-in. Main runs it (agents/claudeSetupToken.ts) and reports
// progress as ClaudeSignInEvents; this is the window's side of it.

/**
 * Whose sign-in it is, fixed when the flow starts:
 *   first    adding the first account
 *   another  adding one more
 *   renew    replacing an account's sign-in
 */
export type SignInMode = 'first' | 'another' | 'renew';

export type SignInPhase =
  /** No sign-in is open. */
  | 'idle'
  /** Asked main to start; no usable link yet. */
  | 'starting'
  /** The link is out; waiting for the code from the sign-in page. */
  | 'waiting'
  | 'checking-code'
  /** Claude would not take the code. That attempt is over. */
  | 'code-refused'
  /** Signed in; main holds the token until the account is named. */
  | 'naming'
  /** The check that the account can run a chat is in flight. It can't be
   *  aborted, so nothing may claim to discard it. */
  | 'verifying'
  | 'check-failed'
  /** The sign-in never started, or ended without a token. */
  | 'failed';

export interface SignInState {
  phase: SignInPhase;
  mode: SignInMode;
  /** PopBot opens the sign-in page itself. Only when there is no other
   *  account the browser could be signed in as instead. */
  autoOpen: boolean;
  /** Which start this is, counted for as long as the pane is open: an
   *  answer to an earlier start is told apart by it. */
  run: number;
  /** Which try within this flow (1 for the first). */
  attempt: number;
  url: string | null;
  /** Claude is waiting for the code: the box can take it. */
  codeReady: boolean;
  /** Whether the CLI opened a page by itself; null until main has said. */
  cliOpensBrowser: boolean | null;
  /** The sign-in page has been opened by someone: step 1 is done. */
  pageOpened: boolean;
  linkCopied: boolean;
  failure: { where: 'start' | 'sign-in'; detail: string; noToken: boolean } | null;
  check: { reason: ClaudeAccountsFailure; error: string } | null;
}

export const SIGN_IN_IDLE: SignInState = {
  phase: 'idle',
  mode: 'first',
  autoOpen: false,
  run: 0,
  attempt: 0,
  url: null,
  codeReady: false,
  cliOpensBrowser: null,
  pageOpened: false,
  linkCopied: false,
  failure: null,
  check: null,
};

export type SignInAction =
  /** Open a flow and ask main for a sign-in. */
  | { type: 'start'; mode: SignInMode; autoOpen: boolean }
  /** Ask again within the same flow (a new code, a new sign-in). */
  | { type: 'restart' }
  /** What signInStart answered, for the start numbered `run`. */
  | { type: 'start-answer'; run: number; answer: { ok: true; cliOpensBrowser: boolean } | { ok: false; error: string } }
  | { type: 'event'; event: ClaudeSignInEvent }
  /** Three seconds have passed since `url` arrived with no newer one. */
  | { type: 'link-timeout'; url: string }
  | { type: 'page-opened' }
  | { type: 'link-copied' }
  /** The check was sent (addSignedIn / setTokenSignedIn). */
  | { type: 'verify' }
  | { type: 'verify-failed'; reason: ClaudeAccountsFailure; error: string }
  /** The flow is over: closed, finished, or left for the token form. */
  | { type: 'close' };

function begin(state: SignInState, mode: SignInMode, autoOpen: boolean, attempt: number): SignInState {
  return { ...SIGN_IN_IDLE, phase: 'starting', mode, autoOpen, run: state.run + 1, attempt };
}

function onSignInEvent(state: SignInState, event: ClaudeSignInEvent): SignInState {
  // Only an attempt that is still running listens: with no flow open, or
  // once this attempt has ended (refused, signed in, failed), what main
  // says belongs to nothing on screen.
  if (state.phase !== 'starting' && state.phase !== 'waiting' && state.phase !== 'checking-code') return state;
  switch (event.type) {
    case 'url': {
      // The last link wins: the first can arrive cut short.
      const next = { ...state, url: event.url };
      return state.phase === 'starting' && state.codeReady ? { ...next, phase: 'waiting' } : next;
    }
    case 'ready-for-code': {
      // Claude asking for the code means the link above it is whole.
      const next = { ...state, codeReady: true };
      return state.phase === 'starting' && state.url !== null ? { ...next, phase: 'waiting' } : next;
    }
    case 'checking-code':
      return state.phase === 'waiting' ? { ...state, phase: 'checking-code' } : state;
    case 'code-refused':
      return { ...state, phase: 'code-refused' };
    case 'token-ready':
      // It can arrive with no code typed (the browser finished by
      // itself). Adding still needs a name; replacing goes straight to
      // the check.
      return { ...state, phase: state.mode === 'renew' ? 'verifying' : 'naming' };
    case 'failed':
      return {
        ...state,
        phase: 'failed',
        failure: { where: 'sign-in', detail: event.message, noToken: event.reason === 'no-token' },
      };
    default:
      return state;
  }
}

export function signInReducer(state: SignInState, action: SignInAction): SignInState {
  switch (action.type) {
    case 'start':
      return begin(state, action.mode, action.autoOpen, 1);
    case 'restart':
      return state.phase === 'idle' ? state : begin(state, state.mode, state.autoOpen, state.attempt + 1);
    case 'start-answer': {
      if (state.phase === 'idle' || action.run !== state.run) return state;
      // "Started" only says what the CLI does about the browser. It never
      // moves the flow: a sign-in that could not be spawned reports its
      // failure before this answer arrives, and must stay failed.
      if (action.answer.ok) return { ...state, cliOpensBrowser: action.answer.cliOpensBrowser };
      if (state.phase !== 'starting') return state;
      return { ...state, phase: 'failed', failure: { where: 'start', detail: action.answer.error, noToken: false } };
    }
    case 'event':
      return onSignInEvent(state, action.event);
    case 'link-timeout':
      // No prompt seen (its wording may have changed): the link has stood
      // unchanged long enough to be taken as whole.
      return state.phase === 'starting' && state.url !== null && state.url === action.url
        ? { ...state, phase: 'waiting' }
        : state;
    case 'page-opened':
      return state.phase === 'waiting' && !state.pageOpened ? { ...state, pageOpened: true } : state;
    case 'link-copied':
      return state.phase === 'waiting' ? { ...state, pageOpened: true, linkCopied: true } : state;
    case 'verify':
      return state.phase === 'naming' || state.phase === 'check-failed'
        ? { ...state, phase: 'verifying', check: null }
        : state;
    case 'verify-failed':
      return state.phase === 'verifying'
        ? { ...state, phase: 'check-failed', check: { reason: action.reason, error: action.error } }
        : state;
    case 'close':
      return { ...SIGN_IN_IDLE, run: state.run };
    default:
      return state;
  }
}

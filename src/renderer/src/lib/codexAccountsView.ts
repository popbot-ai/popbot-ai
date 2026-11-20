/**
 * Every decision the Codex accounts pane makes (PrefsCodexAccounts.tsx),
 * the Codex chip in the title bar and the Codex pointer on the Agents
 * pane, kept apart from React so it can be unit-tested. Pure — no
 * `window`, no clock of its own; the caller passes `now`.
 *
 * A Codex account is a ChatGPT sign-in made inside PopBot. It differs
 * from a Claude account in three ways this file is built around:
 *   - there is nothing to paste and nothing to check: the browser signs
 *     in, and what comes back says who it is (email, plan);
 *   - a sign-in has no fixed end — PopBot renews it — so there is no
 *     "almost a year old" and no "expired", only "sign-in needed" when
 *     OpenAI stops accepting it;
 *   - an account whose sign-in is needed can't run a chat, so it is never
 *     the one chats would move to.
 *
 * What is the same as for Claude accounts is taken from
 * claudeAccountsView.ts rather than written twice.
 */
import type { MessageKey } from '@shared/i18n';
import type {
  CodexAccountInfo,
  CodexAccountsFailure,
  CodexAccountsState,
  CodexSignInEvent,
} from '@shared/ipc';
import { accountNamed, inUse as anyInUse, isOut, type SwitchRow, type SwitcherView } from './claudeAccountsView';

// ── Accounts ─────────────────────────────────────────────────────────

/** The account every Codex chat runs on, if any. */
export function inUse(accounts: CodexAccountInfo[]): CodexAccountInfo | null {
  return anyInUse(accounts) as CodexAccountInfo | null;
}

/** An account a chat could be run on: its sign-in can be read, and works. */
function canRun(a: CodexAccountInfo): boolean {
  return !a.unreadable && !a.needsSignIn;
}

function usable(accounts: CodexAccountInfo[]): CodexAccountInfo[] {
  return accounts.filter(canRun);
}

/** The first account after `from` (down the list, wrapping) that could
 *  run a chat and is not out of usage. */
function nextAvailable(accounts: CodexAccountInfo[], from: CodexAccountInfo, now: number): CodexAccountInfo | null {
  const start = Math.max(0, accounts.findIndex((a) => a.id === from.id));
  for (let i = 1; i <= accounts.length; i += 1) {
    const a = accounts[(start + i) % accounts.length];
    if (a.id !== from.id && canRun(a) && !isOut(a, now)) return a;
  }
  return null;
}

/** The account chats would move to if the one in use ran out of usage
 *  now — the one card that carries "Next up". */
export function nextUp(accounts: CodexAccountInfo[], now: number): CodexAccountInfo | null {
  const active = inUse(accounts);
  return active ? nextAvailable(accounts, active, now) : null;
}

/** No account a chat could run on has usage left. */
function allOut(accounts: CodexAccountInfo[], now: number): boolean {
  const list = usable(accounts);
  return list.length > 0 && list.every((a) => isOut(a, now));
}

// ── Names ────────────────────────────────────────────────────────────

/** ChatGPT's plans by the names people know them by. A plan Codex names
 *  that is not here is shown as Codex spells it, tidied. */
const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

/** What the plan pill says, or null for no pill (no plan, or "unknown"). */
export function planLabel(plan: string | null | undefined): string | null {
  const key = (plan ?? '').trim().toLowerCase();
  if (!key || key === 'unknown') return null;
  if (PLAN_NAMES[key]) return PLAN_NAMES[key];
  return key.split(/[_\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** The email to show beside a name: only when the name is something else. */
export function emailBeside(a: Pick<CodexAccountInfo, 'label' | 'email'>): string | null {
  const email = a.email?.trim();
  if (!email) return null;
  return email.toLowerCase() === a.label.trim().toLowerCase() ? null : email;
}

/** The account that already holds this ChatGPT account, by its email. */
export function accountWithEmail(email: string | null, accounts: CodexAccountInfo[]): CodexAccountInfo | null {
  const wanted = email?.trim().toLowerCase();
  if (!wanted) return null;
  return accounts.find((a) => a.email?.trim().toLowerCase() === wanted) ?? null;
}

/**
 * The name the "Name" field starts with once signed in: the email, which
 * is how the user knows the account — unless another account already
 * goes by it, when the field starts empty rather than with a name that
 * would be refused.
 */
export function suggestedName(email: string | null, accounts: CodexAccountInfo[]): string {
  const name = email?.trim() ?? '';
  return name && !accountNamed(name, accounts) ? name : '';
}

// ── One card ─────────────────────────────────────────────────────────

/** Which row of the status table a card is on (first match wins). */
export type CodexCardKind = 'unreadable' | 'signIn' | 'outInUse' | 'out' | 'inUse' | 'next' | 'saved';

export interface CodexCardView {
  kind: CodexCardKind;
  /** The pill that names the card's problem. "In use", "Next up" and the
   *  plan are separate pills, shown alongside it. */
  statePill: 'unreadable' | 'signIn' | 'out' | null;
  /** The status line: the key under `prefs.codexAccounts.status.`. */
  status: 'unreadable' | 'unreadableNoStore' | 'signIn' | 'signInInUse' | 'outInUse' | 'out' | 'saved' | 'next';
  /** How the status line is marked: red, amber, or not at all. */
  tone: 'error' | 'wait' | null;
  inUse: boolean;
  nextUp: boolean;
  /** Whether the card offers "Use this account". */
  canUse: boolean;
  /** "Use this account" is shown but can't be pressed yet: out of usage. */
  useWaits: boolean;
  /** Whether its sign-in can be replaced here at all: a new one needs an
   *  encrypted place to be kept. */
  canSignIn: boolean;
  /** "Sign in again" is the card's main button: it is what fixes it. */
  signInPrimary: boolean;
  /** The plan pill's words, or null for none. */
  plan: string | null;
  /** The email shown beside the name, when the name is something else. */
  email: string | null;
}

export function cardView(
  a: CodexAccountInfo,
  accounts: CodexAccountInfo[],
  now: number,
  encryptionAvailable: boolean,
): CodexCardView {
  const active = a.active;
  const next = nextUp(accounts, now)?.id === a.id;
  const base = { inUse: active, nextUp: next, canSignIn: encryptionAvailable, plan: planLabel(a.plan), email: emailBeside(a) };
  const row = (
    kind: CodexCardKind,
    status: CodexCardView['status'],
    statePill: CodexCardView['statePill'],
    tone: CodexCardView['tone'],
    canUse: boolean,
    signInPrimary: boolean,
  ): CodexCardView => ({ ...base, kind, status, statePill, tone, canUse, useWaits: kind === 'out', signInPrimary: signInPrimary && encryptionAvailable });

  if (a.unreadable) return row('unreadable', encryptionAvailable ? 'unreadable' : 'unreadableNoStore', 'unreadable', 'error', false, true);
  if (a.needsSignIn) return row('signIn', active ? 'signInInUse' : 'signIn', 'signIn', 'error', false, true);
  if (isOut(a, now)) {
    return active
      ? row('outInUse', 'outInUse', 'out', 'wait', false, false)
      : row('out', 'out', 'out', 'wait', false, false);
  }
  if (active) return row('inUse', 'saved', null, null, false, false);
  if (next) return row('next', 'next', null, null, true, false);
  return row('saved', 'saved', null, null, true, false);
}

// ── The page ─────────────────────────────────────────────────────────

/** Which lead sentence the pane opens with: the key under `prefs.codexAccounts.lead.`. */
export type CodexLeadKind = 'noStore' | 'empty' | 'off' | 'allOut' | 'one' | 'many' | 'othersOut';

export function leadKind(state: CodexAccountsState, now: number): CodexLeadKind {
  const { accounts } = state;
  if (accounts.length === 0) return state.encryptionAvailable ? 'empty' : 'noStore';
  const active = inUse(accounts);
  if (!active) return 'off';
  if (allOut(accounts, now)) return 'allOut';
  // The accounts that could take over. One that can't run a chat can't,
  // so it does not count as a second one — and the account in use is not
  // its own stand-in, whatever state its sign-in is in.
  const others = usable(accounts).filter((a) => a.id !== active.id);
  if (others.length === 0) return 'one';
  return nextUp(accounts, now) ? 'many' : 'othersOut';
}

export type CodexAlertView =
  | { kind: 'noStore' }
  /** The account every chat runs on has a sign-in that no longer works:
   *  no Codex chat can run until it is signed in again, or another
   *  account is picked (`other`: there is one that could run them). */
  | { kind: 'signIn'; account: CodexAccountInfo; other: boolean }
  /** Every account is out of usage; `account` gets usage back first, at `until`. */
  | { kind: 'allOut' | 'oneOut'; account: CodexAccountInfo; until: number };

/** The one alert bar above the cards, if anything is wrong enough for one. */
export function alertKind(state: CodexAccountsState, now: number): CodexAlertView | null {
  if (!state.encryptionAvailable) return { kind: 'noStore' };
  const { accounts } = state;
  const active = inUse(accounts);
  if (!active) return null;
  if (active.needsSignIn || active.unreadable) {
    return { kind: 'signIn', account: active, other: usable(accounts).some((a) => !isOut(a, now)) };
  }
  if (!allOut(accounts, now)) return null;
  let first: CodexAccountInfo | null = null;
  for (const a of usable(accounts)) {
    if (!first || (a.outOfUsageUntil ?? Infinity) < (first.outOfUsageUntil ?? Infinity)) first = a;
  }
  if (first?.outOfUsageUntil == null) return null;
  return { kind: usable(accounts).length === 1 ? 'oneOut' : 'allOut', account: first, until: first.outOfUsageUntil };
}

/**
 * Whether the nav item carries its attention mark: the account in use
 * can't run a chat (its sign-in is needed, or can't be read), or every
 * account is out of usage. Nothing else lights it — never a host, never
 * an account that is merely standing by.
 */
export function needsAttention(state: CodexAccountsState | null, now: number): boolean {
  if (!state) return false;
  const active = inUse(state.accounts);
  if (!active) return false;
  if (active.needsSignIn || active.unreadable) return true;
  return allOut(state.accounts, now);
}

/** Whether Codex chats run on one of PopBot's accounts right now — which
 *  is also when they run through Codex's app server whatever the
 *  "Steer Codex while it works" switch says. */
export function accountInUse(state: CodexAccountsState | null): boolean {
  return !!state && state.accounts.some((a) => a.active);
}

// ── The title bar's chip ─────────────────────────────────────────────

/**
 * The Codex chip's name and menu lines, or null when there are no Codex
 * accounts (no chip). The lines follow the cards exactly: what can be
 * pressed there can be pressed here.
 */
export function accountSwitcher(state: CodexAccountsState | null, now: number): SwitcherView | null {
  if (!state || state.accounts.length === 0) return null;
  const rows = state.accounts.map((a): SwitchRow => {
    const view = cardView(a, state.accounts, now, state.encryptionAvailable);
    const note: SwitchRow['note'] =
      view.kind === 'unreadable' || view.kind === 'signIn' || view.kind === 'out' || view.kind === 'outInUse'
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

// ── The Agents pane's pointer ────────────────────────────────────────

/** A name short enough for a pill; the sentence under it carries it whole. */
function clip(label: string, max = 24): string {
  return label.length > max ? `${label.slice(0, max).trimEnd()}…` : label;
}

export interface CodexPointerView {
  tone: 'done' | 'wait' | 'muted';
  /** Which icon the pill carries (the Agents pane maps it to a class). */
  icon: 'done' | 'wait' | 'notSetUp';
  pill: MessageKey;
  pillVars: { name?: string };
  line: MessageKey;
  vars: { name?: string; count?: number };
  /** Something is wrong with the account chats run on: the button that
   *  opens the Codex accounts section becomes the main one. */
  attention: boolean;
}

/** The pointer's pill and sentence (first match wins). Null until the
 *  accounts are known, so it never claims "no account" before it has an answer. */
export function accountsPointer(state: CodexAccountsState | null, now: number): CodexPointerView | null {
  if (!state) return null;
  const muted = (pill: MessageKey, line: MessageKey): CodexPointerView =>
    ({ tone: 'muted', icon: 'notSetUp', pill, pillVars: {}, line, vars: {}, attention: false });
  if (state.accounts.length === 0) {
    return state.encryptionAvailable
      ? muted('prefs.agents.codexAccounts.pill.none', 'prefs.agents.codexAccounts.line.none')
      : muted('prefs.agents.codexAccounts.pill.off', 'prefs.agents.codexAccounts.line.noStore');
  }
  const active = inUse(state.accounts);
  if (!active) return muted('prefs.agents.codexAccounts.pill.off', 'prefs.agents.codexAccounts.line.off');
  const name = active.label;
  const attention = (line: MessageKey, named = true): CodexPointerView => ({
    tone: 'wait',
    icon: 'wait',
    pill: 'prefs.agents.codexAccounts.pill.attention',
    pillVars: {},
    line,
    vars: named ? { name } : {},
    attention: true,
  });
  if (active.unreadable) return attention('prefs.agents.codexAccounts.line.unreadable');
  if (active.needsSignIn) return attention('prefs.agents.codexAccounts.line.signIn');
  if (allOut(state.accounts, now)) {
    return usable(state.accounts).length === 1
      ? attention('prefs.agents.codexAccounts.line.oneOut')
      : attention('prefs.agents.codexAccounts.line.allOut', false);
  }
  const one = state.accounts.length === 1;
  return {
    tone: 'done',
    icon: 'done',
    pill: 'prefs.agents.codexAccounts.pill.running',
    pillVars: { name: clip(name) },
    line: one ? 'prefs.agents.codexAccounts.line.one' : 'prefs.agents.codexAccounts.line.many',
    vars: one ? { name } : { name, count: state.accounts.length },
    attention: false,
  };
}

// ── Removing ─────────────────────────────────────────────────────────

/** The account in use once `id` is removed: removing another changes
 *  nothing; removing the one in use hands over to the next that could run
 *  chats and has usage — else to the first that could run them at all. */
export function activeAfterRemove(accounts: CodexAccountInfo[], id: string, now: number): CodexAccountInfo | null {
  const active = inUse(accounts);
  if (!active) return null;
  if (active.id !== id) return active;
  const next = nextAvailable(accounts, active, now);
  if (next) return next;
  return usable(accounts.filter((a) => a.id !== id))[0] ?? null;
}

/** What the Remove dialog has to say: where chats go, by account. */
export type CodexRemoveView =
  | { kind: 'inUse'; next: CodexAccountInfo }
  | { kind: 'only' }
  | { kind: 'other'; active: CodexAccountInfo }
  | { kind: 'off' };

export function removeView(accounts: CodexAccountInfo[], id: string, now: number): CodexRemoveView {
  const active = inUse(accounts);
  if (!active) return { kind: 'off' };
  if (active.id !== id) return { kind: 'other', active };
  if (accounts.length === 1) return { kind: 'only' };
  const next = activeAfterRemove(accounts, id, now);
  return next ? { kind: 'inUse', next } : { kind: 'off' };
}

// ── The sign-in ──────────────────────────────────────────────────────

/** `first`: no account yet; `another`: adding to accounts that exist (the
 *  browser is probably signed in to ChatGPT as one of them); `renew`: a
 *  new sign-in for an account that is already here. */
export type CodexSignInMode = 'first' | 'another' | 'renew';

export type CodexSignInPhase =
  /** The panel is open and nothing is started: the two ways to begin. */
  | 'idle'
  /** Main has been asked for a sign-in; the page's link is not here yet. */
  | 'starting'
  /** The link is here: the user is signing in, in a browser. */
  | 'waiting'
  /** Signed in (adding): the account is named and added from here. */
  | 'signed-in'
  /** The sign-in is being saved (an add, or a renewal). */
  | 'saving'
  /** Signed in as a ChatGPT account that is already one of the accounts. */
  | 'duplicate'
  /** Signed in, but main would not save it (`save` says why). */
  | 'save-failed'
  /** The sign-in did not start, or did not finish. */
  | 'failed';

/** How an attempt was started: PopBot opened the page in the browser, or
 *  the link is handed over to be opened where another ChatGPT account is
 *  signed in. */
export type CodexSignInVia = 'open' | 'copy';

export interface CodexSignInState {
  phase: CodexSignInPhase;
  mode: CodexSignInMode;
  /** Counts attempts across the pane's life: a late answer names its own. */
  run: number;
  via: CodexSignInVia | null;
  url: string | null;
  /** The link has been put on the clipboard for this attempt. */
  linkCopied: boolean;
  /** Who the browser signed in as, once it has. */
  who: { email: string | null; plan: string | null; duplicateOf?: string; outOfUsageUntil?: number } | null;
  /** Why the sign-in did not start or finish. */
  failure: { where: 'start' | 'sign-in'; detail: string } | null;
  /** Why a finished sign-in was not saved. */
  save: { reason: CodexAccountsFailure; error: string } | null;
}

export const CODEX_SIGN_IN_IDLE: CodexSignInState = {
  phase: 'idle',
  mode: 'first',
  run: 0,
  via: null,
  url: null,
  linkCopied: false,
  who: null,
  failure: null,
  save: null,
};

export type CodexSignInAction =
  /** A panel opens (or goes back to its start): nothing is running. */
  | { type: 'open'; mode: CodexSignInMode }
  /** The user picked a way to begin; main is asked next. */
  | { type: 'start'; via: CodexSignInVia }
  /** Main's answer to the request for the attempt `run`. */
  | { type: 'start-answer'; run: number; answer: { ok: true } | { ok: false; error: string } }
  | { type: 'event'; event: CodexSignInEvent }
  | { type: 'link-copied' }
  /** The finished sign-in is being saved. */
  | { type: 'save' }
  | { type: 'save-failed'; reason: CodexAccountsFailure; error: string }
  /** The panel closes. */
  | { type: 'close' };

/**
 * The sign-in, one step at a time. Main's events carry no attempt number,
 * so they count only while an attempt is under way (`starting`,
 * `waiting`): what a cancelled sign-in still says is dropped.
 */
export function signInReducer(state: CodexSignInState, action: CodexSignInAction): CodexSignInState {
  switch (action.type) {
    case 'open':
      return { ...CODEX_SIGN_IN_IDLE, mode: action.mode, run: state.run };
    case 'close':
      return { ...CODEX_SIGN_IN_IDLE, mode: state.mode, run: state.run };
    case 'start':
      // One attempt at a time: a second press while the first is being
      // asked for changes nothing.
      if (state.phase === 'starting' || state.phase === 'saving') return state;
      return {
        ...CODEX_SIGN_IN_IDLE,
        mode: state.mode,
        run: state.run + 1,
        phase: 'starting',
        via: action.via,
      };
    case 'start-answer':
      if (action.run !== state.run || (state.phase !== 'starting' && state.phase !== 'waiting')) return state;
      if (action.answer.ok) return state;
      return { ...state, phase: 'failed', failure: { where: 'start', detail: action.answer.error } };
    case 'event': {
      if (state.phase !== 'starting' && state.phase !== 'waiting') return state;
      const { event } = action;
      if (event.type === 'url') return { ...state, phase: 'waiting', url: event.url };
      if (event.type === 'failed') return { ...state, phase: 'failed', failure: { where: 'sign-in', detail: event.message } };
      const who = {
        email: event.email,
        plan: event.plan,
        ...(event.duplicateOf ? { duplicateOf: event.duplicateOf } : {}),
        ...(event.outOfUsageUntil != null ? { outOfUsageUntil: event.outOfUsageUntil } : {}),
      };
      // Adding an account that is already here is refused; renewing with
      // it is what a renewal is (main says so if it is the wrong one).
      if (state.mode !== 'renew' && event.duplicateOf) return { ...state, phase: 'duplicate', who };
      return { ...state, phase: state.mode === 'renew' ? 'saving' : 'signed-in', who };
    }
    case 'link-copied':
      return state.linkCopied ? state : { ...state, linkCopied: true };
    case 'save':
      if (state.phase !== 'signed-in' && state.phase !== 'save-failed') return state;
      return { ...state, phase: 'saving', save: null };
    case 'save-failed':
      if (state.phase !== 'saving') return state;
      // Main found it a duplicate where the event had not said so.
      if (action.reason === 'duplicate' && state.mode !== 'renew') return { ...state, phase: 'duplicate', save: null };
      return { ...state, phase: 'save-failed', save: { reason: action.reason, error: action.error } };
    default:
      return state;
  }
}

/** Whether a sign-in is under way in main that closing the panel must
 *  cancel. Once it is being saved there is nothing left to cancel. */
export function signInRunning(state: CodexSignInState): boolean {
  return state.phase === 'starting' || state.phase === 'waiting' || state.phase === 'signed-in'
    || state.phase === 'duplicate' || state.phase === 'save-failed';
}

/**
 * How a sign-in that was not saved is told, and what is offered: the
 * headline's key under `prefs.codexAccounts.save.`, whether the same
 * sign-in can simply be saved again (`again`), and whether a new sign-in
 * is the way on (`signIn`).
 */
export function saveFailure(reason: CodexAccountsFailure): {
  headline: 'mismatch' | 'gone' | 'noStore' | 'noCli' | 'other';
  again: boolean;
  signIn: boolean;
} {
  switch (reason) {
    case 'mismatch': return { headline: 'mismatch', again: false, signIn: true };
    case 'sign-in-gone': return { headline: 'gone', again: false, signIn: true };
    // Nothing to do in the pane: the system has to be given a store, or Codex.
    case 'no-store': return { headline: 'noStore', again: false, signIn: false };
    case 'no-cli': return { headline: 'noCli', again: false, signIn: false };
    // The sign-in is still held in main: saving it can be tried again.
    default: return { headline: 'other', again: true, signIn: true };
  }
}

/** Which sentence says who signed in: with the plan, without it, or — when
 *  Codex gave no email — neither. The key under `prefs.codexAccounts.signedIn.`. */
export function signedInLine(who: { email: string | null; plan: string | null }): {
  key: 'asPlan' | 'as' | 'plan' | 'bare';
  vars: { email?: string; plan?: string };
} {
  const email = who.email?.trim() || null;
  const plan = planLabel(who.plan);
  if (email && plan) return { key: 'asPlan', vars: { email, plan } };
  if (email) return { key: 'as', vars: { email } };
  if (plan) return { key: 'plan', vars: { plan } };
  return { key: 'bare', vars: {} };
}

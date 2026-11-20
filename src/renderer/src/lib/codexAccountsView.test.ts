import { describe, expect, it } from 'vitest';
import type { CodexAccountInfo, CodexAccountsState, CodexSignInEvent } from '@shared/ipc';
import {
  CODEX_SIGN_IN_IDLE,
  accountInUse,
  accountSwitcher,
  accountWithEmail,
  accountsPointer,
  activeAfterRemove,
  alertKind,
  cardView,
  emailBeside,
  inUse,
  leadKind,
  needsAttention,
  nextUp,
  planLabel,
  removeView,
  saveFailure,
  signInReducer,
  signInRunning,
  signedInLine,
  suggestedName,
  type CodexSignInAction,
  type CodexSignInState,
} from './codexAccountsView';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 19, 12, 0).getTime();

/** An account named by its email, signed in three days ago, unless said otherwise. */
function acct(name: string, over: Partial<CodexAccountInfo> = {}): CodexAccountInfo {
  const email = `${name}@example.com`;
  return { id: name, label: email, email, plan: 'pro', addedAt: NOW - 3 * DAY, active: false, ...over };
}
function st(accounts: CodexAccountInfo[], over: Partial<CodexAccountsState> = {}): CodexAccountsState {
  return { accounts, encryptionAvailable: true, ...over };
}
const out = (hours = 2): Partial<CodexAccountInfo> => ({ outOfUsageUntil: NOW + hours * HOUR });
const view = (a: CodexAccountInfo, all: CodexAccountInfo[], store = true) => cardView(a, all, NOW, store);

describe('which account is next', () => {
  it('is the first after the one in use that could run a chat and has usage', () => {
    const all = [acct('a', { active: true }), acct('b', out()), acct('c'), acct('d')];
    expect(nextUp(all, NOW)?.id).toBe('c');
  });

  it('goes round from the account in use, not from the top', () => {
    const all = [acct('a'), acct('b', { active: true }), acct('c', out())];
    expect(nextUp(all, NOW)?.id).toBe('a');
  });

  it('is never an account whose sign-in is needed or can not be read', () => {
    const all = [acct('a', { active: true }), acct('b', { needsSignIn: true }), acct('c', { unreadable: true }), acct('d')];
    expect(nextUp(all, NOW)?.id).toBe('d');
    expect(nextUp(all.slice(0, 3), NOW)).toBeNull();
  });

  it('is nobody when no account is in use', () => {
    expect(nextUp([acct('a'), acct('b')], NOW)).toBeNull();
    expect(inUse([acct('a'), acct('b')])).toBeNull();
  });
});

describe('names', () => {
  it('words the plans people know and tidies the ones it does not', () => {
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('PLUS')).toBe('Plus');
    expect(planLabel('prolite')).toBe('Pro Lite');
    expect(planLabel('self_serve_business_usage_based')).toBe('Self Serve Business Usage Based');
    expect(planLabel('unknown')).toBeNull();
    expect(planLabel('')).toBeNull();
    expect(planLabel(null)).toBeNull();
  });

  it('shows the email beside a name only when the name is something else', () => {
    expect(emailBeside(acct('a'))).toBeNull();
    expect(emailBeside(acct('a', { label: 'A@Example.com ' }))).toBeNull();
    expect(emailBeside(acct('a', { label: 'Work' }))).toBe('a@example.com');
    expect(emailBeside(acct('a', { label: 'Work', email: null }))).toBeNull();
  });

  it('finds the account that already holds a ChatGPT account by its email', () => {
    const all = [acct('a', { label: 'Work' }), acct('b')];
    expect(accountWithEmail('A@example.com', all)?.id).toBe('a');
    expect(accountWithEmail('z@example.com', all)).toBeNull();
    expect(accountWithEmail(null, all)).toBeNull();
  });

  it('suggests the email as the name, unless that name is taken', () => {
    expect(suggestedName('new@example.com', [acct('a')])).toBe('new@example.com');
    // Another account was renamed to this very address: start empty.
    expect(suggestedName('new@example.com', [acct('a', { label: 'new@example.com' })])).toBe('');
    expect(suggestedName(null, [])).toBe('');
  });
});

describe('cardView', () => {
  it('the account in use: when it was signed in, no button to use it', () => {
    const a = acct('a', { active: true });
    expect(view(a, [a, acct('b')])).toMatchObject({
      kind: 'inUse', statePill: null, status: 'saved', tone: null, inUse: true, nextUp: false,
      canUse: false, useWaits: false, signInPrimary: false, plan: 'Pro', email: null,
    });
  });

  it('the one chats would move to carries Next up and can be switched to', () => {
    const all = [acct('a', { active: true }), acct('b'), acct('c')];
    expect(view(all[1], all)).toMatchObject({ kind: 'next', status: 'next', nextUp: true, canUse: true });
    expect(view(all[2], all)).toMatchObject({ kind: 'saved', status: 'saved', nextUp: false, canUse: true });
  });

  it('out of usage: the button is shown but waits', () => {
    const all = [acct('a', { active: true }), acct('b', out())];
    expect(view(all[1], all)).toMatchObject({ kind: 'out', statePill: 'out', status: 'out', tone: 'wait', canUse: false, useWaits: true });
    const self = acct('a', { active: true, ...out() });
    expect(view(self, [self])).toMatchObject({ kind: 'outInUse', statePill: 'out', status: 'outInUse', inUse: true, canUse: false, useWaits: false });
    // Once the time has passed it is an ordinary account again.
    expect(cardView(all[1], all, NOW + 3 * HOUR, true)).toMatchObject({ kind: 'next', statePill: null, canUse: true });
  });

  it('a sign-in that stopped working: signing in again is the main button, and it says whom it stops', () => {
    const all = [acct('a', { active: true }), acct('b', { needsSignIn: true })];
    expect(view(all[1], all)).toMatchObject({
      kind: 'signIn', statePill: 'signIn', status: 'signIn', tone: 'error', canUse: false, nextUp: false, signInPrimary: true,
    });
    const self = acct('a', { active: true, needsSignIn: true });
    expect(view(self, [self])).toMatchObject({ kind: 'signIn', status: 'signInInUse', inUse: true });
    // It outranks out-of-usage: the sign-in has to be fixed first.
    expect(view(acct('c', { needsSignIn: true, ...out() }), all)).toMatchObject({ kind: 'signIn' });
  });

  it('a sign-in that can not be read', () => {
    const a = acct('a', { unreadable: true });
    expect(view(a, [a])).toMatchObject({ kind: 'unreadable', statePill: 'unreadable', status: 'unreadable', tone: 'error', signInPrimary: true });
    // With no store there is nowhere to keep a new one: nothing is offered.
    expect(view(a, [a], false)).toMatchObject({ status: 'unreadableNoStore', canSignIn: false, signInPrimary: false });
  });

  it('never ages: a sign-in from long ago is an ordinary one', () => {
    const old = acct('a', { active: true, addedAt: NOW - 400 * DAY });
    expect(view(old, [old])).toMatchObject({ kind: 'inUse', statePill: null, tone: null, signInPrimary: false });
  });

  it('carries the plan and, once renamed, the email', () => {
    const a = acct('a', { label: 'Work', plan: 'team' });
    expect(view(a, [a])).toMatchObject({ plan: 'Team', email: 'a@example.com' });
    expect(view(acct('b', { plan: null }), [])).toMatchObject({ plan: null, email: null });
  });
});

describe('leadKind', () => {
  it('walks the cases', () => {
    expect(leadKind(st([]), NOW)).toBe('empty');
    expect(leadKind(st([], { encryptionAvailable: false }), NOW)).toBe('noStore');
    expect(leadKind(st([acct('a'), acct('b')]), NOW)).toBe('off');
    expect(leadKind(st([acct('a', { active: true })]), NOW)).toBe('one');
    expect(leadKind(st([acct('a', { active: true }), acct('b')]), NOW)).toBe('many');
    expect(leadKind(st([acct('a', { active: true }), acct('b', out())]), NOW)).toBe('othersOut');
    expect(leadKind(st([acct('a', { active: true, ...out() }), acct('b', out())]), NOW)).toBe('allOut');
  });

  it('does not count an account that can not run a chat as a second one', () => {
    expect(leadKind(st([acct('a', { active: true }), acct('b', { needsSignIn: true })]), NOW)).toBe('one');
    expect(leadKind(st([acct('a', { active: true }), acct('b', { unreadable: true })]), NOW)).toBe('one');
  });

  it('still sees the spare when the account in use is the one whose sign-in is needed', () => {
    const broken = acct('a', { active: true, needsSignIn: true });
    // Not "add a second account": there is one, and it can take over.
    expect(leadKind(st([broken, acct('b')]), NOW)).toBe('many');
    expect(leadKind(st([broken, acct('b', out())]), NOW)).toBe('allOut');
    expect(leadKind(st([broken]), NOW)).toBe('one');
  });
});

describe('alertKind / needsAttention', () => {
  it('says nothing when all is well, or when no account is in use', () => {
    expect(alertKind(st([acct('a', { active: true }), acct('b', out())]), NOW)).toBeNull();
    expect(alertKind(st([acct('a', { needsSignIn: true })]), NOW)).toBeNull();
    expect(needsAttention(st([acct('a', { needsSignIn: true })]), NOW)).toBe(false);
    expect(needsAttention(null, NOW)).toBe(false);
  });

  it('the store comes first: without one nothing here can be fixed', () => {
    expect(alertKind(st([acct('a', { active: true, needsSignIn: true })], { encryptionAvailable: false }), NOW)).toEqual({ kind: 'noStore' });
  });

  it('the account in use can not run chats: says so, and whether another could', () => {
    const broken = acct('a', { active: true, needsSignIn: true });
    expect(alertKind(st([broken]), NOW)).toEqual({ kind: 'signIn', account: broken, other: false });
    expect(alertKind(st([broken, acct('b')]), NOW)).toMatchObject({ kind: 'signIn', other: true });
    // An out-of-usage spare is no way out right now.
    expect(alertKind(st([broken, acct('b', out())]), NOW)).toMatchObject({ kind: 'signIn', other: false });
    expect(needsAttention(st([broken, acct('b')]), NOW)).toBe(true);
    expect(needsAttention(st([acct('a', { active: true, unreadable: true })]), NOW)).toBe(true);
  });

  it('every account out of usage: which is back first', () => {
    const a = acct('a', { active: true, ...out(5) });
    const b = acct('b', out(2));
    expect(alertKind(st([a, b]), NOW)).toEqual({ kind: 'allOut', account: b, until: NOW + 2 * HOUR });
    expect(alertKind(st([a]), NOW)).toEqual({ kind: 'oneOut', account: a, until: NOW + 5 * HOUR });
    // One that needs a sign-in is not among those that could come back.
    expect(alertKind(st([a, acct('c', { needsSignIn: true })]), NOW)).toMatchObject({ kind: 'oneOut' });
    expect(needsAttention(st([a, b]), NOW)).toBe(true);
    expect(needsAttention(st([a, acct('c')]), NOW)).toBe(false);
  });
});

describe('accountInUse (what locks the steering switch)', () => {
  it('is true only while a Codex account is the one chats run on', () => {
    expect(accountInUse(null)).toBe(false);
    expect(accountInUse(st([]))).toBe(false);
    expect(accountInUse(st([acct('a')]))).toBe(false);
    expect(accountInUse(st([acct('a'), acct('b', { active: true })]))).toBe(true);
  });
});

describe('accountSwitcher (the title bar chip)', () => {
  it('shows nothing until there is an account', () => {
    expect(accountSwitcher(null, NOW)).toBeNull();
    expect(accountSwitcher(st([]), NOW)).toBeNull();
  });

  it('names the account in use, and its lines follow the cards', () => {
    const state = st([
      acct('a', { active: true, label: 'Work' }),
      acct('b', out(3)),
      acct('c'),
      acct('d', { needsSignIn: true }),
      acct('e', { unreadable: true }),
    ]);
    const sw = accountSwitcher(state, NOW)!;
    expect(sw.name).toBe('Work');
    expect(sw.attention).toBe(false);
    expect(sw.rows.map((r) => [r.id, r.canUse, r.note])).toEqual([
      ['a', false, 'inUse'],
      ['b', false, 'out'],
      ['c', true, 'next'],
      ['d', false, 'signIn'],
      ['e', false, 'unreadable'],
    ]);
    expect(sw.rows[1].until).toBe(NOW + 3 * HOUR);
    for (const [i, a] of state.accounts.entries()) {
      expect(sw.rows[i].canUse).toBe(cardView(a, state.accounts, NOW, true).canUse);
    }
  });

  it('says so when no account is in use, and when the one in use needs attention', () => {
    expect(accountSwitcher(st([acct('a')]), NOW)).toMatchObject({ name: null, attention: false });
    const sw = accountSwitcher(st([acct('a', { active: true, needsSignIn: true }), acct('b')]), NOW)!;
    expect(sw).toMatchObject({ attention: true });
    expect(sw.rows[0]).toMatchObject({ inUse: true, canUse: false, note: 'signIn' });
  });
});

describe('accountsPointer (the Agents pane)', () => {
  it('makes no claim before the accounts are known', () => {
    expect(accountsPointer(null, NOW)).toBeNull();
  });

  it('walks the cases', () => {
    expect(accountsPointer(st([]), NOW)).toMatchObject({ tone: 'muted', pill: 'prefs.agents.codexAccounts.pill.none', line: 'prefs.agents.codexAccounts.line.none', attention: false });
    expect(accountsPointer(st([], { encryptionAvailable: false }), NOW)).toMatchObject({ pill: 'prefs.agents.codexAccounts.pill.off', line: 'prefs.agents.codexAccounts.line.noStore' });
    expect(accountsPointer(st([acct('a')]), NOW)).toMatchObject({ pill: 'prefs.agents.codexAccounts.pill.off', line: 'prefs.agents.codexAccounts.line.off' });
    expect(accountsPointer(st([acct('a', { active: true, label: 'Work' })]), NOW)).toEqual({
      tone: 'done', icon: 'done', pill: 'prefs.agents.codexAccounts.pill.running', pillVars: { name: 'Work' },
      line: 'prefs.agents.codexAccounts.line.one', vars: { name: 'Work' }, attention: false,
    });
    expect(accountsPointer(st([acct('a', { active: true, label: 'Work' }), acct('b')]), NOW)).toMatchObject({
      line: 'prefs.agents.codexAccounts.line.many', vars: { name: 'Work', count: 2 },
    });
  });

  it('asks for attention when the account in use can not run chats', () => {
    const attention = { tone: 'wait', icon: 'wait', pill: 'prefs.agents.codexAccounts.pill.attention', attention: true };
    expect(accountsPointer(st([acct('a', { active: true, needsSignIn: true })]), NOW)).toMatchObject({ ...attention, line: 'prefs.agents.codexAccounts.line.signIn' });
    expect(accountsPointer(st([acct('a', { active: true, unreadable: true })]), NOW)).toMatchObject({ ...attention, line: 'prefs.agents.codexAccounts.line.unreadable' });
    expect(accountsPointer(st([acct('a', { active: true, ...out() })]), NOW)).toMatchObject({ ...attention, line: 'prefs.agents.codexAccounts.line.oneOut' });
    expect(accountsPointer(st([acct('a', { active: true, ...out() }), acct('b', out())]), NOW)).toMatchObject({ ...attention, line: 'prefs.agents.codexAccounts.line.allOut', vars: {} });
  });

  it('clips a long name in the pill and keeps it whole in the sentence', () => {
    const long = 'a-very-long-address-indeed@example.com';
    const v = accountsPointer(st([acct('a', { active: true, label: long })]), NOW)!;
    expect(v.pillVars.name).toBe('a-very-long-address-inde…');
    expect(v.vars.name).toBe(long);
  });
});

describe('removing', () => {
  it('another account: nothing moves', () => {
    const all = [acct('a', { active: true }), acct('b')];
    expect(removeView(all, 'b', NOW)).toEqual({ kind: 'other', active: all[0] });
    expect(activeAfterRemove(all, 'b', NOW)?.id).toBe('a');
  });

  it('the account in use: chats move to the next that can run them', () => {
    const all = [acct('a', { active: true }), acct('b', { needsSignIn: true }), acct('c', out()), acct('d')];
    expect(removeView(all, 'a', NOW)).toEqual({ kind: 'inUse', next: all[3] });
    // None has usage: the first that could run a chat at all.
    const outs = [acct('a', { active: true }), acct('b', { needsSignIn: true }), acct('c', out())];
    expect(removeView(outs, 'a', NOW)).toEqual({ kind: 'inUse', next: outs[2] });
  });

  it('the only account, or nobody to take over, or none in use', () => {
    expect(removeView([acct('a', { active: true })], 'a', NOW)).toEqual({ kind: 'only' });
    expect(removeView([acct('a', { active: true }), acct('b', { needsSignIn: true })], 'a', NOW)).toEqual({ kind: 'off' });
    expect(removeView([acct('a'), acct('b')], 'a', NOW)).toEqual({ kind: 'off' });
  });
});

describe('the sign-in', () => {
  const run = (actions: CodexSignInAction[], from: CodexSignInState = CODEX_SIGN_IN_IDLE): CodexSignInState =>
    actions.reduce(signInReducer, from);
  const ev = (event: CodexSignInEvent): CodexSignInAction => ({ type: 'event', event });
  const URL = 'https://auth.example.com/authorize?x=1';
  const signedIn: CodexSignInEvent = { type: 'signed-in', email: 'new@example.com', plan: 'plus' };

  it('opens idle, in its mode', () => {
    expect(run([{ type: 'open', mode: 'another' }])).toMatchObject({ phase: 'idle', mode: 'another', via: null, url: null });
  });

  it('PopBot opens the page: asked, the link arrives, the user signs in, the account is named and saved', () => {
    let s = run([{ type: 'open', mode: 'first' }, { type: 'start', via: 'open' }]);
    expect(s).toMatchObject({ phase: 'starting', via: 'open', run: 1 });
    s = run([{ type: 'start-answer', run: 1, answer: { ok: true } }], s);
    expect(s.phase).toBe('starting');
    s = run([ev({ type: 'url', url: URL })], s);
    expect(s).toMatchObject({ phase: 'waiting', url: URL, linkCopied: false });
    s = run([ev(signedIn)], s);
    expect(s).toMatchObject({ phase: 'signed-in', who: { email: 'new@example.com', plan: 'plus' } });
    s = run([{ type: 'save' }], s);
    expect(s.phase).toBe('saving');
    expect(signInRunning(s)).toBe(false);
  });

  it('the link may arrive before the answer to the request', () => {
    const s = run([{ type: 'open', mode: 'first' }, { type: 'start', via: 'copy' }, ev({ type: 'url', url: URL }), { type: 'start-answer', run: 1, answer: { ok: true } }]);
    expect(s).toMatchObject({ phase: 'waiting', via: 'copy', url: URL });
    expect(run([{ type: 'link-copied' }], s).linkCopied).toBe(true);
  });

  it('a start that fails says where; a sign-in that does not finish says why', () => {
    const base: CodexSignInAction[] = [{ type: 'open', mode: 'another' }, { type: 'start', via: 'open' }];
    expect(run([...base, { type: 'start-answer', run: 1, answer: { ok: false, error: 'codex: not found' } }]))
      .toMatchObject({ phase: 'failed', failure: { where: 'start', detail: 'codex: not found' } });
    expect(run([...base, ev({ type: 'url', url: URL }), ev({ type: 'failed', message: 'The sign-in was left waiting too long.' })]))
      .toMatchObject({ phase: 'failed', failure: { where: 'sign-in' }, via: 'open' });
  });

  it('ignores the answer of an attempt that is no longer the one', () => {
    const s = run([{ type: 'open', mode: 'first' }, { type: 'start', via: 'open' }, ev({ type: 'failed', message: 'x' }), { type: 'start', via: 'copy' }]);
    expect(s).toMatchObject({ phase: 'starting', run: 2, via: 'copy', failure: null });
    expect(run([{ type: 'start-answer', run: 1, answer: { ok: false, error: 'late' } }], s)).toBe(s);
  });

  it('a second press while the first is being asked for changes nothing', () => {
    const s = run([{ type: 'open', mode: 'first' }, { type: 'start', via: 'open' }]);
    expect(run([{ type: 'start', via: 'copy' }], s)).toBe(s);
  });

  it('drops what a cancelled sign-in still says', () => {
    const idle = run([{ type: 'open', mode: 'another' }, { type: 'start', via: 'open' }, ev({ type: 'url', url: URL }), { type: 'open', mode: 'another' }]);
    expect(idle).toMatchObject({ phase: 'idle', url: null, run: 1 });
    expect(run([ev(signedIn)], idle)).toBe(idle);
    expect(run([ev({ type: 'url', url: URL })], idle)).toBe(idle);
    const closed = run([{ type: 'close' }], idle);
    expect(run([ev({ type: 'failed', message: 'late' })], closed)).toBe(closed);
  });

  it('adding a ChatGPT account that is already here is a duplicate, said at once', () => {
    const s = run([{ type: 'open', mode: 'another' }, { type: 'start', via: 'open' }, ev({ type: 'url', url: URL }), ev({ ...signedIn, duplicateOf: 'a' })]);
    expect(s).toMatchObject({ phase: 'duplicate', who: { duplicateOf: 'a' } });
    expect(signInRunning(s)).toBe(true);
    // The way on is another attempt.
    expect(run([{ type: 'start', via: 'copy' }], s)).toMatchObject({ phase: 'starting', run: 2, who: null });
  });

  it('main may find the duplicate only when asked to save', () => {
    const s = run([{ type: 'open', mode: 'another' }, { type: 'start', via: 'open' }, ev({ type: 'url', url: URL }), ev(signedIn), { type: 'save' }, { type: 'save-failed', reason: 'duplicate', error: 'already added' }]);
    expect(s.phase).toBe('duplicate');
  });

  it('renewing: the save starts as soon as the browser is done, duplicate or not', () => {
    const base: CodexSignInAction[] = [{ type: 'open', mode: 'renew' }, { type: 'start', via: 'open' }, ev({ type: 'url', url: URL })];
    expect(run([...base, ev({ ...signedIn, duplicateOf: 'a' })])).toMatchObject({ phase: 'saving', who: { duplicateOf: 'a' } });
    expect(run([...base, ev(signedIn)]).phase).toBe('saving');
  });

  it('a save that fails keeps why, and can be tried again', () => {
    const s = run([{ type: 'open', mode: 'renew' }, { type: 'start', via: 'open' }, ev({ type: 'url', url: URL }), ev(signedIn), { type: 'save-failed', reason: 'mismatch', error: 'other account' }]);
    expect(s).toMatchObject({ phase: 'save-failed', save: { reason: 'mismatch', error: 'other account' } });
    expect(run([{ type: 'save' }], s)).toMatchObject({ phase: 'saving', save: null });
    // A failure that arrives when nothing is being saved is not this panel's.
    expect(run([{ type: 'save-failed', reason: 'other', error: 'x' }], CODEX_SIGN_IN_IDLE)).toBe(CODEX_SIGN_IN_IDLE);
  });

  it('carries "signed in but out of usage" to the naming step', () => {
    const s = run([{ type: 'open', mode: 'first' }, { type: 'start', via: 'open' }, ev({ type: 'url', url: URL }), ev({ ...signedIn, outOfUsageUntil: NOW + HOUR })]);
    expect(s).toMatchObject({ phase: 'signed-in', who: { outOfUsageUntil: NOW + HOUR } });
  });

  it('knows when there is something in main to cancel', () => {
    const phases = (p: CodexSignInState['phase']): boolean => signInRunning({ ...CODEX_SIGN_IN_IDLE, phase: p });
    expect(['idle', 'saving', 'failed'].map((p) => phases(p as CodexSignInState['phase']))).toEqual([false, false, false]);
    expect(['starting', 'waiting', 'signed-in', 'duplicate', 'save-failed'].map((p) => phases(p as CodexSignInState['phase']))).toEqual([true, true, true, true, true]);
  });
});

describe('what a failed save offers', () => {
  it('a wrong or lost sign-in needs a new one; an unknown failure can be saved again', () => {
    expect(saveFailure('mismatch')).toEqual({ headline: 'mismatch', again: false, signIn: true });
    expect(saveFailure('sign-in-gone')).toEqual({ headline: 'gone', again: false, signIn: true });
    expect(saveFailure('other')).toEqual({ headline: 'other', again: true, signIn: true });
    expect(saveFailure('duplicate')).toMatchObject({ headline: 'other' });
  });

  it('where the pane can do nothing, it offers nothing', () => {
    expect(saveFailure('no-store')).toEqual({ headline: 'noStore', again: false, signIn: false });
    expect(saveFailure('no-cli')).toEqual({ headline: 'noCli', again: false, signIn: false });
  });
});

describe('signedInLine', () => {
  it('says as much as is known', () => {
    expect(signedInLine({ email: 'a@example.com', plan: 'pro' })).toEqual({ key: 'asPlan', vars: { email: 'a@example.com', plan: 'Pro' } });
    expect(signedInLine({ email: 'a@example.com', plan: null })).toEqual({ key: 'as', vars: { email: 'a@example.com' } });
    expect(signedInLine({ email: null, plan: 'team' })).toEqual({ key: 'plan', vars: { plan: 'Team' } });
    expect(signedInLine({ email: ' ', plan: 'unknown' })).toEqual({ key: 'bare', vars: {} });
  });
});

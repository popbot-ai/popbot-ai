import { describe, expect, it } from 'vitest';
import type { ClaudeAccountInfo, ClaudeAccountsState, ClaudeSignInEvent } from '@shared/ipc';
import {
  SIGN_IN_IDLE,
  accountNamed,
  activeAfterRemove,
  agentsSummary,
  alertKind,
  cardView,
  checkFailure,
  cleanToken,
  codeLooks,
  inUse,
  isOut,
  leadKind,
  marker,
  nameProblem,
  needsAttention,
  newAccountIn,
  nextUp,
  removeView,
  signInReducer,
  splitMarked,
  shortAccountName,
  accountSwitcher,
  addedVerdict,
  tokenCutOff,
  tokenLooks,
  tookOver,
  whenKind,
  type SignInAction,
  type SignInState,
} from './claudeAccountsView';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 19, 12, 0).getTime();

/** An account whose sign-in was saved three days ago, unless said otherwise. */
function acct(id: string, over: Partial<ClaudeAccountInfo> = {}): ClaudeAccountInfo {
  return { id, label: id, addedAt: NOW - 3 * DAY, active: false, ...over };
}
function st(accounts: ClaudeAccountInfo[], over: Partial<ClaudeAccountsState> = {}): ClaudeAccountsState {
  return { accounts, encryptionAvailable: true, ...over };
}
const out = (hours = 2): Partial<ClaudeAccountInfo> => ({ outOfUsageUntil: NOW + hours * HOUR });

describe('isOut / inUse', () => {
  it('counts a mark at or before now as cleared', () => {
    expect(isOut(acct('a', { outOfUsageUntil: NOW + 1 }), NOW)).toBe(true);
    expect(isOut(acct('a', { outOfUsageUntil: NOW }), NOW)).toBe(false);
    expect(isOut(acct('a', { outOfUsageUntil: NOW - 1 }), NOW)).toBe(false);
    expect(isOut(acct('a'), NOW)).toBe(false);
  });

  it('finds the account in use, or none', () => {
    expect(inUse([acct('a'), acct('b', { active: true })])?.id).toBe('b');
    expect(inUse([acct('a'), acct('b')])).toBeNull();
  });
});

describe('nextUp', () => {
  it('is the account after the one in use, in list order', () => {
    const list = [acct('a', { active: true }), acct('b'), acct('c')];
    expect(nextUp(list, NOW)?.id).toBe('b');
  });

  it('wraps round to the top of the list', () => {
    const list = [acct('a'), acct('b'), acct('c', { active: true })];
    expect(nextUp(list, NOW)?.id).toBe('a');
  });

  it('skips accounts that are out of usage, and takes them again once their time has passed', () => {
    const list = [acct('a', { active: true }), acct('b', out()), acct('c')];
    expect(nextUp(list, NOW)?.id).toBe('c');
    expect(nextUp(list, NOW + 3 * HOUR)?.id).toBe('b');
  });

  it('is nobody when every other account is out of usage', () => {
    const list = [acct('a', { active: true }), acct('b', out()), acct('c', out())];
    expect(nextUp(list, NOW)).toBeNull();
  });

  it('is nobody with one account, and nobody when no account is in use', () => {
    expect(nextUp([acct('a', { active: true })], NOW)).toBeNull();
    expect(nextUp([acct('a'), acct('b')], NOW)).toBeNull();
  });

  it('never lands on an account whose sign-in cannot be read', () => {
    const list = [acct('a', { active: true }), acct('b', { unreadable: true }), acct('c')];
    expect(nextUp(list, NOW)?.id).toBe('c');
    expect(nextUp([acct('a', { active: true }), acct('b', { unreadable: true })], NOW)).toBeNull();
  });

  it('still lands on an account with a refused or expired sign-in: failover would', () => {
    const list = [acct('a', { active: true }), acct('b', { needsSignIn: true }), acct('c')];
    expect(nextUp(list, NOW)?.id).toBe('b');
  });
});

describe('cardView: the status table, first match wins', () => {
  const others = [acct('work', { active: true }), acct('spare')];
  const view = (a: ClaudeAccountInfo, list = [...others, a], store = true): ReturnType<typeof cardView> =>
    cardView(a, list, NOW, store);

  it('row 1: a sign-in that cannot be read beats everything else', () => {
    const a = acct('x', { unreadable: true, needsSignIn: true, addedAt: NOW - 400 * DAY, ...out() });
    expect(view(a)).toMatchObject({
      kind: 'unreadable', statePill: 'unreadable', status: 'unreadable', tone: 'error', canUse: false, signInPrimary: true,
    });
  });

  it('row 1 without an encrypted store: no "Sign in again" is promised', () => {
    const a = acct('x', { unreadable: true });
    expect(view(a, [...others, a], false)).toMatchObject({
      kind: 'unreadable', status: 'unreadableNoStore', canSignIn: false, signInPrimary: false,
    });
  });

  it('row 2: a refused sign-in beats expired and out of usage', () => {
    const a = acct('x', { needsSignIn: true, addedAt: NOW - 400 * DAY, ...out() });
    expect(view(a)).toMatchObject({
      kind: 'refused', statePill: 'refused', status: 'refused', tone: 'error', canUse: false, signInPrimary: true,
    });
  });

  it('row 3: saved 365 days ago or more is expired, and beats out of usage', () => {
    const a = acct('x', { addedAt: NOW - 365 * DAY, ...out() });
    expect(view(a)).toMatchObject({
      kind: 'expired', statePill: 'expired', status: 'expired', tone: 'error', canUse: false, signInPrimary: true,
    });
    expect(view(acct('x', { addedAt: NOW - 365 * DAY + 1 })).kind).not.toBe('expired');
  });

  it('row 4: out of usage and in use', () => {
    const a = acct('x', { active: true, ...out() });
    expect(view(a, [a, acct('spare')])).toMatchObject({
      kind: 'outInUse', statePill: 'out', status: 'outInUse', tone: 'wait', inUse: true, canUse: false, useWaits: false, signInPrimary: false,
    });
  });

  it('row 5: out of usage and not in use has no "Use this account" at all', () => {
    const a = acct('x', { addedAt: NOW - 340 * DAY, ...out() });
    expect(view(a)).toMatchObject({
      kind: 'out', statePill: 'out', status: 'out', tone: 'wait', canUse: false, useWaits: true, signInPrimary: false,
    });
  });

  it('row 5 ends by itself when the time passes', () => {
    const a = acct('x', out(1));
    expect(cardView(a, [...others, a], NOW + 2 * HOUR, true)).toMatchObject({ statePill: null, canUse: true });
  });

  it('row 6: saved 335 days ago or more is expiring, with no pill', () => {
    const a = acct('x', { addedAt: NOW - 335 * DAY });
    expect(view(a)).toMatchObject({
      kind: 'expiring', statePill: null, status: 'expiring', tone: 'wait', canUse: true, signInPrimary: true,
    });
    const active = acct('x', { active: true, addedAt: NOW - 340 * DAY });
    expect(view(active, [active, acct('spare')])).toMatchObject({ kind: 'expiring', inUse: true, canUse: false });
    expect(view(acct('x', { addedAt: NOW - 335 * DAY + 1 })).kind).not.toBe('expiring');
  });

  it('row 7: in use, nothing wrong', () => {
    const a = acct('x', { active: true });
    expect(view(a, [a, acct('spare')])).toMatchObject({
      kind: 'inUse', statePill: null, status: 'saved', tone: null, inUse: true, nextUp: false, canUse: false, signInPrimary: false,
    });
  });

  it('row 8: next up', () => {
    const a = acct('x');
    expect(view(a, [acct('work', { active: true }), a, acct('spare')])).toMatchObject({
      kind: 'next', statePill: null, status: 'next', tone: null, nextUp: true, canUse: true, useWaits: false, signInPrimary: false,
    });
  });

  it('row 9: otherwise, a saved sign-in that can be used', () => {
    const a = acct('x');
    expect(view(a, [acct('work', { active: true }), acct('spare'), a])).toMatchObject({
      kind: 'saved', statePill: null, status: 'saved', tone: null, nextUp: false, canUse: true, signInPrimary: false,
    });
  });

  it('keeps "Next up" beside a problem: it says where failover goes, not that all is well', () => {
    const a = acct('x', { needsSignIn: true });
    expect(view(a, [acct('work', { active: true }), a])).toMatchObject({ kind: 'refused', nextUp: true });
  });

  it('without an encrypted store a healthy card still offers "Use this account", but no new sign-in', () => {
    const a = acct('x');
    expect(view(a, [...others, a], false)).toMatchObject({ canUse: true, canSignIn: false });
  });
});

describe('leadKind', () => {
  it('no accounts', () => {
    expect(leadKind(st([]), NOW)).toBe('empty');
    expect(leadKind(st([], { encryptionAvailable: false }), NOW)).toBe('noStore');
  });

  it('accounts saved, none in use', () => {
    expect(leadKind(st([acct('a'), acct('b')]), NOW)).toBe('off');
  });

  it('in use and every account out of usage', () => {
    expect(leadKind(st([acct('a', { active: true, ...out() })]), NOW)).toBe('allOut');
    expect(leadKind(st([acct('a', { active: true, ...out() }), acct('b', out())]), NOW)).toBe('allOut');
  });

  it('one account', () => {
    expect(leadKind(st([acct('a', { active: true })]), NOW)).toBe('one');
  });

  it('several, with an account to move to', () => {
    expect(leadKind(st([acct('a', { active: true }), acct('b')]), NOW)).toBe('many');
  });

  it('several, the others out of usage', () => {
    expect(leadKind(st([acct('a', { active: true }), acct('b', out())]), NOW)).toBe('othersOut');
  });

  it('keeps the normal lead for accounts listed where there is no encrypted store', () => {
    expect(leadKind(st([acct('a', { active: true }), acct('b')], { encryptionAvailable: false }), NOW)).toBe('many');
  });

  it('does not count an unreadable account as a second one', () => {
    expect(leadKind(st([acct('a', { active: true }), acct('b', { unreadable: true })]), NOW)).toBe('one');
  });
});

describe('alertKind', () => {
  it('says nothing when nothing is wrong', () => {
    expect(alertKind(st([]), NOW)).toBeNull();
    expect(alertKind(st([acct('a', { active: true }), acct('b', out())]), NOW)).toBeNull();
  });

  it('no encrypted store, with or without accounts', () => {
    expect(alertKind(st([], { encryptionAvailable: false }), NOW)).toEqual({ kind: 'noStore' });
    expect(alertKind(st([acct('a', { active: true, ...out() })], { encryptionAvailable: false }), NOW)).toEqual({ kind: 'noStore' });
  });

  it('every account out: names the one that gets usage back first', () => {
    const list = [acct('work', { active: true, ...out(6) }), acct('personal', out(2)), acct('team', out(4))];
    expect(alertKind(st(list), NOW)).toEqual({ kind: 'allOut', account: list[1], until: NOW + 2 * HOUR });
  });

  it('a single account out of usage has its own wording', () => {
    const only = acct('work', { active: true, ...out(6) });
    expect(alertKind(st([only]), NOW)).toEqual({ kind: 'oneOut', account: only, until: NOW + 6 * HOUR });
  });

  it('clears when the first account is back', () => {
    const list = [acct('work', { active: true, ...out(6) }), acct('personal', out(2))];
    expect(alertKind(st(list), NOW + 3 * HOUR)).toBeNull();
  });

  it('is not shown when no account is in use', () => {
    expect(alertKind(st([acct('a', out()), acct('b', out())]), NOW)).toBeNull();
  });
});

describe('needsAttention', () => {
  it('is off until the accounts are known, with none, and with none in use', () => {
    expect(needsAttention(null, NOW)).toBe(false);
    expect(needsAttention(st([]), NOW)).toBe(false);
    expect(needsAttention(st([acct('a', { needsSignIn: true }), acct('b', out())]), NOW)).toBe(false);
  });

  it('is off for a healthy account in use, whatever the others are', () => {
    const list = [
      acct('a', { active: true }),
      acct('b', { needsSignIn: true }),
      acct('c', { addedAt: NOW - 400 * DAY }),
      acct('d', out()),
    ];
    expect(needsAttention(st(list), NOW)).toBe(false);
  });

  it('is on when the account in use has a refused or expired sign-in', () => {
    expect(needsAttention(st([acct('a', { active: true, needsSignIn: true }), acct('b')]), NOW)).toBe(true);
    expect(needsAttention(st([acct('a', { active: true, addedAt: NOW - 365 * DAY }), acct('b')]), NOW)).toBe(true);
  });

  it('is on when every account is out of usage, and off once one is back', () => {
    const list = [acct('a', { active: true, ...out(6) }), acct('b', out(2))];
    expect(needsAttention(st(list), NOW)).toBe(true);
    expect(needsAttention(st(list), NOW + 3 * HOUR)).toBe(false);
  });

  it('is off for an expiring sign-in and for an outdated host', () => {
    expect(needsAttention(st([acct('a', { active: true, addedAt: NOW - 340 * DAY })]), NOW)).toBe(false);
    expect(needsAttention(st([acct('a', { active: true })], { outdatedHosts: ['studio'] }), NOW)).toBe(false);
  });
});

describe('shortAccountName (what a chip has room for)', () => {
  it('is what comes before the @ of an address', () => {
    expect(shortAccountName('first@example.com')).toBe('first');
    expect(shortAccountName('  first.last+tag@example.com ')).toBe('first.last+tag');
    // Only the first @ counts.
    expect(shortAccountName('odd@name@example.com')).toBe('odd');
  });

  it('shows a name that is not an address whole', () => {
    expect(shortAccountName('Work')).toBe('Work');
    expect(shortAccountName('Personal Max')).toBe('Personal Max');
    expect(shortAccountName('')).toBe('');
  });

  it('shows a name with nothing before its @ whole', () => {
    expect(shortAccountName('@handle')).toBe('@handle');
    expect(shortAccountName(' @ example.com')).toBe('@ example.com');
  });
});

describe('accountSwitcher (the title bar)', () => {
  it('shows nothing until there is an account', () => {
    expect(accountSwitcher(null, NOW)).toBeNull();
    expect(accountSwitcher(st([]), NOW)).toBeNull();
  });

  it('names the account in use and offers the ones that can be switched to', () => {
    const state = st([
      acct('Work', { active: true }),
      acct('Out', { outOfUsageUntil: NOW + 3 * HOUR }),
      acct('Spare'),
      acct('Refused', { needsSignIn: true }),
    ]);
    const sw = accountSwitcher(state, NOW)!;
    expect(sw.name).toBe('Work');
    expect(sw.attention).toBe(false);
    expect(sw.rows.map((r) => [r.label, r.canUse, r.note])).toEqual([
      ['Work', false, 'inUse'],
      ['Out', false, 'out'],
      ['Spare', true, 'next'],
      ['Refused', false, 'refused'],
    ]);
    expect(sw.rows[1].until).toBe(NOW + 3 * HOUR);
    expect(sw.rows[2].until).toBeUndefined();
    // What can be pressed here is what can be pressed on the card.
    for (const [i, a] of state.accounts.entries()) {
      expect(sw.rows[i].canUse).toBe(cardView(a, state.accounts, NOW, true).canUse);
    }
  });

  it('once an out-of-usage time has passed, the account can be switched to again', () => {
    const state = st([acct('Work', { active: true }), acct('Back', { outOfUsageUntil: NOW - 1 })]);
    expect(accountSwitcher(state, NOW)!.rows[1]).toMatchObject({ canUse: true, note: 'next' });
  });

  it('says so when no account is in use, and when the one in use needs attention', () => {
    expect(accountSwitcher(st([acct('a'), acct('b')]), NOW)).toMatchObject({ name: null, attention: false });
    const refused = accountSwitcher(st([acct('Work', { active: true, needsSignIn: true }), acct('Spare')]), NOW)!;
    expect(refused).toMatchObject({ name: 'Work', attention: true });
    expect(refused.rows[0]).toMatchObject({ inUse: true, note: 'refused' });
    const out = accountSwitcher(st([acct('Work', { active: true, outOfUsageUntil: NOW + HOUR })]), NOW)!;
    expect(out.rows[0]).toMatchObject({ inUse: true, canUse: false, note: 'outInUse', until: NOW + HOUR });
  });
});

describe('agentsSummary', () => {
  it('words the pointer row for each state', () => {
    expect(agentsSummary(st([]))).toEqual({ key: 'none', vars: {} });
    expect(agentsSummary(st([acct('a')]))).toEqual({ key: 'off', vars: {} });
    expect(agentsSummary(st([acct('Work', { active: true })]))).toEqual({ key: 'runningOne', vars: { name: 'Work' } });
    expect(agentsSummary(st([acct('a'), acct('Work', { active: true }), acct('c')]))).toEqual({
      key: 'running', vars: { name: 'Work', count: 3 },
    });
  });
});

describe('tookOver', () => {
  const before = [acct('work', { active: true }), acct('team')];

  it('sees PopBot move chats when the account in use ran out', () => {
    const after = [acct('work', out()), acct('team', { active: true })];
    expect(tookOver(before, after, NOW)).toEqual({ from: after[0], to: after[1] });
  });

  it('is not a plain switch: the account before still has usage', () => {
    expect(tookOver(before, [acct('work'), acct('team', { active: true })], NOW)).toBeNull();
  });

  it('is nothing when the account in use did not change, or there was or is none', () => {
    expect(tookOver(before, [acct('work', { active: true, ...out() }), acct('team')], NOW)).toBeNull();
    expect(tookOver([acct('work'), acct('team')], [acct('work', out()), acct('team', { active: true })], NOW)).toBeNull();
    expect(tookOver(before, [acct('work', out()), acct('team')], NOW)).toBeNull();
    expect(tookOver(before, [acct('team', { active: true })], NOW)).toBeNull();
  });
});

describe('activeAfterRemove', () => {
  it('hands over to the first account that remains', () => {
    const list = [acct('a', { active: true }), acct('b'), acct('c')];
    expect(activeAfterRemove(list, 'a', NOW)?.id).toBe('b');
    const last = [acct('a'), acct('b'), acct('c', { active: true })];
    expect(activeAfterRemove(last, 'c', NOW)?.id).toBe('a');
  });

  it('gives way when the first remaining account is out of usage', () => {
    const list = [acct('a', { active: true }), acct('b', out()), acct('c', out()), acct('d')];
    expect(activeAfterRemove(list, 'a', NOW)?.id).toBe('d');
  });

  it('wraps while giving way', () => {
    const list = [acct('a'), acct('b', { active: true })];
    expect(activeAfterRemove([...list, acct('c', out())], 'b', NOW)?.id).toBe('a');
    const firstOut = [acct('a', out()), acct('b', { active: true }), acct('c')];
    expect(activeAfterRemove(firstOut, 'b', NOW)?.id).toBe('c');
  });

  it('stays on the first remaining account when all of them are out', () => {
    const list = [acct('a', { active: true }), acct('b', out()), acct('c', out())];
    expect(activeAfterRemove(list, 'a', NOW)?.id).toBe('b');
  });

  it('changes nothing when another account is removed', () => {
    const list = [acct('a'), acct('b', { active: true }), acct('c')];
    expect(activeAfterRemove(list, 'a', NOW)?.id).toBe('b');
  });

  it('is nobody for the only account, with none in use, or when the first left cannot be read', () => {
    expect(activeAfterRemove([acct('a', { active: true })], 'a', NOW)).toBeNull();
    expect(activeAfterRemove([acct('a'), acct('b')], 'a', NOW)).toBeNull();
    expect(activeAfterRemove([acct('a', { active: true }), acct('b', { unreadable: true }), acct('c')], 'a', NOW)).toBeNull();
  });
});

describe('removeView: the four things the Remove dialog can say', () => {
  it('in use, others remain: names where chats move', () => {
    const list = [acct('a', { active: true }), acct('b', out()), acct('c')];
    expect(removeView(list, 'a', NOW)).toEqual({ kind: 'inUse', next: list[2] });
  });

  it('the only account', () => {
    expect(removeView([acct('a', { active: true })], 'a', NOW)).toEqual({ kind: 'only' });
  });

  it('not in use, another is', () => {
    const list = [acct('a', { active: true }), acct('b')];
    expect(removeView(list, 'b', NOW)).toEqual({ kind: 'other', active: list[0] });
  });

  it('no account in use', () => {
    expect(removeView([acct('a'), acct('b')], 'a', NOW)).toEqual({ kind: 'off' });
    expect(removeView([acct('a')], 'a', NOW)).toEqual({ kind: 'off' });
  });
});

describe('whenKind', () => {
  const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime();

  it('tells today, tomorrow and later apart by the calendar, not by hours', () => {
    expect(whenKind(at(19, 13, 51), at(19, 12))).toBe('today');
    expect(whenKind(at(19, 23, 59), at(19, 0))).toBe('today');
    expect(whenKind(at(20, 0, 5), at(19, 23, 50))).toBe('tomorrow');
    expect(whenKind(at(20, 23, 59), at(19, 0))).toBe('tomorrow');
    expect(whenKind(at(21, 0, 0), at(19, 23, 59))).toBe('later');
  });

  it('crosses a month and a year', () => {
    expect(whenKind(new Date(2026, 11, 1, 9).getTime(), new Date(2026, 10, 30, 9).getTime())).toBe('tomorrow');
    expect(whenKind(new Date(2027, 0, 1, 9).getTime(), new Date(2026, 11, 31, 9).getTime())).toBe('tomorrow');
    expect(whenKind(new Date(2027, 0, 2, 9).getTime(), new Date(2026, 11, 31, 9).getTime())).toBe('later');
  });
});

describe('tokens', () => {
  it('cleanToken removes every space and line break, not only the ends', () => {
    expect(cleanToken('  sk-ant-oat01-abc\n   def\r\n\tghi  ')).toBe('sk-ant-oat01-abcdefghi');
    expect(cleanToken('   ')).toBe('');
  });

  it('tokenLooks', () => {
    expect(tokenLooks('')).toBe('empty');
    expect(tokenLooks(' \n ')).toBe('empty');
    expect(tokenLooks('sk-ant-oat01-abcdef')).toBe('token');
    expect(tokenLooks('sk-ant-api03-abcdef')).toBe('api-key');
    expect(tokenLooks('something-else')).toBe('other');
  });

  it('addedVerdict: an account found out of usage is not said to be ready', () => {
    const base = { id: 'a', label: 'A', addedAt: NOW };
    expect(addedVerdict({ ...base, active: true }, NOW)).toBe('addedInUse');
    expect(addedVerdict({ ...base, active: false }, NOW)).toBe('addedStandby');
    expect(addedVerdict({ ...base, active: false, outOfUsageUntil: NOW + HOUR }, NOW)).toBe('addedOut');
    expect(addedVerdict({ ...base, active: true, outOfUsageUntil: NOW + HOUR }, NOW)).toBe('addedOut');
    // A mark already past is no mark.
    expect(addedVerdict({ ...base, active: false, outOfUsageUntil: NOW - 1 }, NOW)).toBe('addedStandby');
  });

  it('tokenCutOff counts a token shorter than a whole one, and nothing else', () => {
    const whole = 'sk-ant-oat01-' + 'x'.repeat(95);
    expect(whole).toHaveLength(108);
    expect(tokenCutOff(whole)).toBeNull();
    // The first line of a token an 80-column terminal wrapped.
    expect(tokenCutOff(whole.slice(0, 79))).toBe(79);
    // Both lines, as copied: whole once the break between them is gone.
    expect(tokenCutOff(`${whole.slice(0, 79)}\n${whole.slice(79)}  `)).toBeNull();
    expect(tokenCutOff('')).toBeNull();
    // Not this kind of token: other lines under the field speak for those.
    expect(tokenCutOff('sk-ant-api03-short')).toBeNull();
    expect(tokenCutOff('sk-ant-oat02-short')).toBeNull();
    expect(tokenCutOff('something-else')).toBeNull();
  });

  it('tokenLooks reads a token copied across wrapped terminal lines', () => {
    expect(tokenLooks('  sk-ant-\noat01-abc\n  def')).toBe('token');
    expect(tokenLooks('sk-ant-\napi03-abc')).toBe('api-key');
  });
});

describe('codeLooks', () => {
  it('empty', () => {
    expect(codeLooks('')).toBe('empty');
    expect(codeLooks('  \n')).toBe('empty');
  });

  it('the sign-in link pasted instead of the code', () => {
    expect(codeLooks('https://claude.com/cai/oauth/authorize?code=true&client_id=x')).toBe('link');
    expect(codeLooks('  HTTP://example.test/x ')).toBe('link');
  });

  it('anything with a space in it is not a code', () => {
    expect(codeLooks('Paste code here if prompted')).toBe('spaces');
    expect(codeLooks('abc\ndef')).toBe('spaces');
  });

  it('a token in the code box is recognised, however it was wrapped', () => {
    expect(codeLooks('sk-ant-oat01-abcdef')).toBe('token');
    expect(codeLooks(' sk-ant-oat01-abc\n  def ')).toBe('token');
    expect(codeLooks('sk-\nant-oat01-abcdef')).toBe('token');
  });

  it('a code: trimmed, in one piece', () => {
    expect(codeLooks('  aBc123_-xyz#state456  ')).toBe('ok');
  });
});

describe('nameProblem', () => {
  const list = [acct('1', { label: 'Work' }), acct('2', { label: 'Personal Max' })];

  it('refuses an empty name', () => {
    expect(nameProblem('', list)).toBe('empty');
    expect(nameProblem('   ', list)).toBe('empty');
  });

  it('refuses a name another account has, trimmed and whatever the case', () => {
    expect(nameProblem('Work', list)).toBe('duplicate');
    expect(nameProblem('  work ', list)).toBe('duplicate');
    expect(nameProblem('PERSONAL MAX', list)).toBe('duplicate');
  });

  it('lets an account keep its own name', () => {
    expect(nameProblem('work', list, '1')).toBeNull();
    expect(nameProblem('Personal Max', list, '1')).toBe('duplicate');
  });

  it('takes any other name', () => {
    expect(nameProblem('Team seat', list)).toBeNull();
    expect(nameProblem('Work 2', list)).toBeNull();
  });

  it('accountNamed gives the account that has the name, as it is spelled there', () => {
    expect(accountNamed(' WORK ', list)?.label).toBe('Work');
    expect(accountNamed('work', list, '1')).toBeNull();
    expect(accountNamed('', list)).toBeNull();
  });
});

describe('newAccountIn', () => {
  it('finds the account an add produced', () => {
    const before = [acct('a', { active: true })];
    const after = [acct('a', { active: true }), acct('b')];
    expect(newAccountIn(before, after)).toBe(after[1]);
    expect(newAccountIn([], [acct('a', { active: true })])?.active).toBe(true);
  });

  it('is nothing when nothing was added', () => {
    expect(newAccountIn([acct('a')], [acct('a')])).toBeNull();
    expect(newAccountIn([acct('a'), acct('b')], [acct('a')])).toBeNull();
  });
});

describe('checkFailure: headline and ways on, by reason', () => {
  it('follows the table', () => {
    expect(checkFailure('refused')).toEqual({ headline: 'check.refused', again: true, signIn: true });
    expect(checkFailure('timeout')).toEqual({ headline: 'check.timeout', again: true, signIn: true });
    expect(checkFailure('no-cli')).toEqual({ headline: 'check.noCli', again: true, signIn: false });
    expect(checkFailure('sign-in-gone')).toEqual({ headline: 'check.gone', again: false, signIn: true });
    expect(checkFailure('no-store')).toEqual({ headline: 'alert.noStore', again: false, signIn: false });
    expect(checkFailure('other')).toEqual({ headline: 'check.other', again: true, signIn: true });
  });

  it('treats a reason it does not know as "other"', () => {
    expect(checkFailure(undefined as never)).toEqual(checkFailure('other'));
  });
});

describe('splitMarked', () => {
  it('cuts a sentence at its markers, wherever they stand', () => {
    expect(splitMarked(`Every chat runs on ${marker('name')}, here.`)).toEqual([
      'Every chat runs on ', { mark: 'name' }, ', here.',
    ]);
    expect(splitMarked(`${marker('command')} first, ${marker('name')} last`)).toEqual([
      { mark: 'command' }, ' first, ', { mark: 'name' }, ' last',
    ]);
    expect(splitMarked(`ends with ${marker('name')}`)).toEqual(['ends with ', { mark: 'name' }]);
  });

  it('leaves plain text whole', () => {
    expect(splitMarked('Nothing to mark.')).toEqual(['Nothing to mark.']);
  });
});

describe('signInReducer', () => {
  const URL_A = 'https://claude.com/cai/oauth/authorize?code=true&state=a';
  const URL_B = 'https://claude.com/cai/oauth/authorize?code=true&state=b';
  const run = (state: SignInState, ...actions: SignInAction[]): SignInState => actions.reduce(signInReducer, state);
  const ev = (event: ClaudeSignInEvent): SignInAction => ({ type: 'event', event });
  const started = (state: SignInState, cliOpensBrowser = false): SignInAction => ({
    type: 'start-answer', run: state.run, answer: { ok: true, cliOpensBrowser },
  });

  const starting = (mode: SignInState['mode'] = 'first'): SignInState =>
    signInReducer(SIGN_IN_IDLE, { type: 'start', mode, autoOpen: mode === 'first' });
  const waiting = (mode: SignInState['mode'] = 'first'): SignInState => {
    const s = starting(mode);
    return run(s, started(s), ev({ type: 'url', url: URL_A }), ev({ type: 'ready-for-code' }));
  };
  const checking = (mode: SignInState['mode'] = 'first'): SignInState => run(waiting(mode), ev({ type: 'checking-code' }));
  const naming = (): SignInState => run(checking(), ev({ type: 'token-ready' }));

  describe('idle', () => {
    it('start opens a flow at its first attempt, with its mode fixed', () => {
      expect(starting('another')).toMatchObject({
        phase: 'starting', mode: 'another', autoOpen: false, attempt: 1, run: 1,
        url: null, codeReady: false, cliOpensBrowser: null, pageOpened: false,
      });
      expect(starting('first').autoOpen).toBe(true);
    });

    it('ignores every event: no sign-in flow is open', () => {
      const events: ClaudeSignInEvent[] = [
        { type: 'url', url: URL_A },
        { type: 'ready-for-code' },
        { type: 'checking-code' },
        { type: 'code-refused', message: 'no' },
        { type: 'token-ready' },
        { type: 'failed', message: 'gone' },
      ];
      for (const event of events) expect(signInReducer(SIGN_IN_IDLE, ev(event))).toBe(SIGN_IN_IDLE);
    });

    it('ignores a restart and a late answer', () => {
      expect(signInReducer(SIGN_IN_IDLE, { type: 'restart' })).toBe(SIGN_IN_IDLE);
      const closed = run(starting(), { type: 'close' });
      expect(signInReducer(closed, { type: 'start-answer', run: closed.run, answer: { ok: false, error: 'x' } })).toBe(closed);
    });
  });

  describe('starting', () => {
    it('link ready by the prompt: waiting, with the code box open', () => {
      const s = run(starting(), ev({ type: 'url', url: URL_A }));
      expect(s).toMatchObject({ phase: 'starting', url: URL_A, codeReady: false });
      expect(run(s, ev({ type: 'ready-for-code' }))).toMatchObject({ phase: 'waiting', url: URL_A, codeReady: true });
    });

    it('link ready by time: waiting, but the code box stays shut until Claude asks', () => {
      const s = run(starting(), ev({ type: 'url', url: URL_A }), { type: 'link-timeout', url: URL_A });
      expect(s).toMatchObject({ phase: 'waiting', codeReady: false });
      expect(run(s, ev({ type: 'ready-for-code' }))).toMatchObject({ phase: 'waiting', codeReady: true });
    });

    it('the last link wins, and a timer for an older one does nothing', () => {
      const s = run(starting(), ev({ type: 'url', url: URL_A }), ev({ type: 'url', url: URL_B }));
      expect(s.url).toBe(URL_B);
      expect(run(s, { type: 'link-timeout', url: URL_A }).phase).toBe('starting');
      expect(run(s, { type: 'link-timeout', url: URL_B }).phase).toBe('waiting');
    });

    it('a prompt before any link waits for the link', () => {
      const s = run(starting(), ev({ type: 'ready-for-code' }));
      expect(s).toMatchObject({ phase: 'starting', codeReady: true });
      expect(run(s, ev({ type: 'url', url: URL_A }))).toMatchObject({ phase: 'waiting', url: URL_A });
    });

    it('the start answer records what the CLI does about the browser and moves nothing', () => {
      const s = starting('another');
      expect(run(s, started(s, true))).toMatchObject({ phase: 'starting', cliOpensBrowser: true });
      expect(run(s, started(s, false))).toMatchObject({ phase: 'starting', cliOpensBrowser: false });
    });

    it('start not ok: failed, as a sign-in that could not start', () => {
      const s = starting();
      const failed = run(s, { type: 'start-answer', run: s.run, answer: { ok: false, error: 'The Claude CLI is not installed.' } });
      expect(failed).toMatchObject({
        phase: 'failed', failure: { where: 'start', detail: 'The Claude CLI is not installed.', noToken: false },
      });
    });

    it('a failed event: failed, as a sign-in that did not finish', () => {
      expect(run(starting(), ev({ type: 'failed', message: 'spawn ENOENT' }))).toMatchObject({
        phase: 'failed', failure: { where: 'sign-in', detail: 'spawn ENOENT', noToken: false },
      });
    });
  });

  describe('waiting', () => {
    it('Continue sends the code; "checking-code" from main moves on', () => {
      expect(checking().phase).toBe('checking-code');
    });

    it('token-ready: naming when adding, straight to the check when replacing', () => {
      expect(run(waiting('first'), ev({ type: 'token-ready' })).phase).toBe('naming');
      expect(run(waiting('another'), ev({ type: 'token-ready' })).phase).toBe('naming');
      expect(run(waiting('renew'), ev({ type: 'token-ready' })).phase).toBe('verifying');
    });

    it('failed: failed', () => {
      expect(run(waiting(), ev({ type: 'failed', message: 'This account is on hold.' }))).toMatchObject({
        phase: 'failed', failure: { where: 'sign-in', detail: 'This account is on hold.' },
      });
    });

    it('failed with no-token is marked, so the pane can open the token form', () => {
      const s = run(waiting(), ev({ type: 'failed', message: 'x', reason: 'no-token' }));
      expect(s.failure?.noToken).toBe(true);
    });

    it('opening or copying the link finishes step 1', () => {
      const s = waiting('another');
      expect(s.pageOpened).toBe(false);
      expect(run(s, { type: 'page-opened' })).toMatchObject({ pageOpened: true, linkCopied: false });
      expect(run(s, { type: 'link-copied' })).toMatchObject({ pageOpened: true, linkCopied: true });
    });

    it('a newer link replaces the one on show without shutting the code box', () => {
      expect(run(waiting(), ev({ type: 'url', url: URL_B }))).toMatchObject({ phase: 'waiting', url: URL_B, codeReady: true });
    });
  });

  describe('checking-code', () => {
    it('code-refused: that attempt is over', () => {
      expect(run(checking(), ev({ type: 'code-refused', message: 'That code wasn’t accepted.' })).phase).toBe('code-refused');
    });

    it('token-ready: naming or the check', () => {
      expect(run(checking('another'), ev({ type: 'token-ready' })).phase).toBe('naming');
      expect(run(checking('renew'), ev({ type: 'token-ready' })).phase).toBe('verifying');
    });

    it('failed: failed', () => {
      expect(run(checking(), ev({ type: 'failed', message: 'exit 1' })).phase).toBe('failed');
    });
  });

  describe('code-refused', () => {
    const refused = (): SignInState => run(checking('another'), ev({ type: 'code-refused', message: 'no' }));

    it('"Get a new code" starts the next attempt from scratch, in the same mode', () => {
      const before = refused();
      const s = run(before, { type: 'restart' });
      expect(s).toMatchObject({
        phase: 'starting', mode: 'another', autoOpen: false, attempt: 2, run: before.run + 1,
        url: null, codeReady: false, cliOpensBrowser: null, pageOpened: false, linkCopied: false,
      });
    });

    it('says nothing more for the attempt that ended', () => {
      const s = refused();
      expect(run(s, ev({ type: 'token-ready' }))).toBe(s);
      expect(run(s, ev({ type: 'failed', message: 'exit' }))).toBe(s);
    });
  });

  describe('naming', () => {
    it('"Add account" sends the check', () => {
      expect(run(naming(), { type: 'verify' }).phase).toBe('verifying');
    });

    it('is not shaken by anything main still says', () => {
      const s = naming();
      expect(run(s, ev({ type: 'failed', message: 'exit' }))).toBe(s);
      expect(run(s, ev({ type: 'url', url: URL_B }))).toBe(s);
    });
  });

  describe('verifying', () => {
    const verifying = (): SignInState => run(naming(), { type: 'verify' });

    it('ok: the flow closes', () => {
      const s = verifying();
      expect(run(s, { type: 'close' })).toEqual({ ...SIGN_IN_IDLE, run: s.run });
    });

    it('not ok: check-failed, with the reason and the CLI’s own text', () => {
      expect(run(verifying(), { type: 'verify-failed', reason: 'refused', error: '401 OAuth access token is invalid.' })).toMatchObject({
        phase: 'check-failed', check: { reason: 'refused', error: '401 OAuth access token is invalid.' },
      });
    });

    it('a result that arrives when no check is in flight changes nothing', () => {
      const s = naming();
      expect(run(s, { type: 'verify-failed', reason: 'timeout', error: '' })).toBe(s);
    });
  });

  describe('check-failed', () => {
    const failed = (mode: SignInState['mode'] = 'first'): SignInState =>
      mode === 'renew'
        ? run(waiting('renew'), ev({ type: 'token-ready' }), { type: 'verify-failed', reason: 'timeout', error: '' })
        : run(naming(), { type: 'verify' }, { type: 'verify-failed', reason: 'timeout', error: '' });

    it('"Check again" repeats the check, without another sign-in', () => {
      expect(run(failed(), { type: 'verify' })).toMatchObject({ phase: 'verifying', check: null });
      expect(run(failed('renew'), { type: 'verify' })).toMatchObject({ phase: 'verifying', mode: 'renew' });
    });

    it('"Sign in again" starts over', () => {
      expect(run(failed(), { type: 'restart' })).toMatchObject({ phase: 'starting', attempt: 2, check: null });
    });
  });

  describe('failed', () => {
    it('"Start again" starts over', () => {
      const s = run(waiting(), ev({ type: 'failed', message: 'on hold' }));
      expect(run(s, { type: 'restart' })).toMatchObject({ phase: 'starting', attempt: 2, failure: null });
    });

    it('close leaves for the token form', () => {
      const s = run(waiting(), ev({ type: 'failed', message: 'x', reason: 'no-token' }));
      expect(run(s, { type: 'close' }).phase).toBe('idle');
    });
  });

  describe('the three rules', () => {
    it('a start answer of ok never moves a flow that has already failed', () => {
      // A sign-in that can't be spawned reports before signInStart returns.
      const s = starting();
      const failed = run(s, ev({ type: 'failed', message: 'spawn ENOENT' }));
      const after = run(failed, started(s, false));
      expect(after.phase).toBe('failed');
      expect(after.failure).toEqual({ where: 'sign-in', detail: 'spawn ENOENT', noToken: false });
    });

    it('token-ready is accepted from waiting and from checking-code', () => {
      expect(run(waiting(), ev({ type: 'token-ready' })).phase).toBe('naming');
      expect(run(checking(), ev({ type: 'token-ready' })).phase).toBe('naming');
    });

    it('events are ignored when no sign-in flow is open', () => {
      const closed = run(waiting(), { type: 'close' });
      expect(closed.phase).toBe('idle');
      expect(run(closed, ev({ type: 'token-ready' }))).toBe(closed);
      expect(run(closed, ev({ type: 'failed', message: 'late' }))).toBe(closed);
      expect(run(closed, ev({ type: 'url', url: URL_B }))).toBe(closed);
    });
  });

  describe('answers that come late', () => {
    it('an answer to an earlier start is dropped', () => {
      const first = starting('another');
      const second = run(first, ev({ type: 'failed', message: 'x' }), { type: 'restart' });
      const stale: SignInAction = { type: 'start-answer', run: first.run, answer: { ok: false, error: 'old' } };
      expect(run(second, stale)).toBe(second);
      expect(run(second, started(first, true)).cliOpensBrowser).toBeNull();
    });

    it('a flow opened after another was closed does not hear the old answer', () => {
      const first = starting();
      const second = run(first, { type: 'close' }, { type: 'start', mode: 'another', autoOpen: false });
      expect(second.run).toBe(first.run + 1);
      expect(run(second, started(first, true)).cliOpensBrowser).toBeNull();
    });
  });
});

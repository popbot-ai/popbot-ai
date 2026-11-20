import { describe, expect, it } from 'vitest';
import type { ClaudeAccountInfo, ClaudeAccountsState, CloudStatus } from '@shared/ipc';
import { en } from '@shared/i18n/messages/en';
import {
  CLAUDE_EFFORT_CHOICES,
  CODEX_EFFORT_CHOICES,
  ICON,
  accountsPointer,
  apiKeyProblem,
  clipName,
  cloudFooter,
  cloudPill,
  codexCli,
  controlView,
  effortOptionKey,
  failedCheck,
  githubNoteLine,
  githubRow,
  githubTokenProblem,
  keyErrorKind,
  keyFieldLine,
  keyNoteLine,
  keyRow,
  keyWorks,
  lastKeyFailure,
  leaveOutcome,
  lineClass,
  lineIcon,
  markView,
  secretMode,
  shownCodexEffort,
  steerView,
  tokenCloseKey,
  tokenFieldLine,
  withApiKey,
  withGithubToken,
  withWorkspaceId,
  withoutField,
  workspaceLine,
  workspaceView,
  type KeyCheck,
} from './agentsPaneView';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 19, 12, 0).getTime();

/** An account whose sign-in was saved three days ago, unless said otherwise. */
function acct(label: string, over: Partial<ClaudeAccountInfo> = {}): ClaudeAccountInfo {
  return { id: label.toLowerCase(), label, addedAt: NOW - 3 * DAY, active: false, ...over };
}
function st(accounts: ClaudeAccountInfo[], over: Partial<ClaudeAccountsState> = {}): ClaudeAccountsState {
  return { accounts, encryptionAvailable: true, ...over };
}
const out = (hours = 2): Partial<ClaudeAccountInfo> => ({ outOfUsageUntil: NOW + hours * HOUR });

function status(over: Partial<CloudStatus> = {}): CloudStatus {
  return { apiKey: null, githubToken: null, hasSettingsKey: false, ...over };
}
const OK: KeyCheck = { state: 'ok' };
const CHECKING: KeyCheck = { state: 'checking' };
const REJECTED = 'the API key was rejected (invalid x-api-key)';
const FORBIDDEN = 'the API key is not allowed to use Managed Agents (permission denied)';
const NEEDS_WORKSPACE = 'This organization key must name a workspace: set the anthropic-workspace-id header';
const NETWORK = 'Connection error.';

describe('accountsPointer', () => {
  it('is null until the accounts are known', () => {
    expect(accountsPointer(null, NOW)).toBeNull();
  });

  it('says "No account yet" with no accounts and a place to keep one', () => {
    const v = accountsPointer(st([]), NOW);
    expect(v).toMatchObject({
      tone: 'muted',
      icon: ICON.notSetUp,
      pill: 'prefs.agents.accounts.pill.none',
      line: 'prefs.agents.accounts.line.none',
      attention: false,
    });
  });

  it('says "Not using an account" with no accounts and no encrypted store', () => {
    const v = accountsPointer(st([], { encryptionAvailable: false }), NOW);
    expect(v).toMatchObject({
      tone: 'muted',
      pill: 'prefs.agents.accounts.pill.off',
      line: 'prefs.agents.accounts.line.noStore',
      attention: false,
    });
  });

  it('says "Not using an account" when accounts exist but none is in use', () => {
    const v = accountsPointer(st([acct('Work'), acct('Home')]), NOW);
    expect(v).toMatchObject({
      tone: 'muted',
      pill: 'prefs.agents.accounts.pill.off',
      line: 'prefs.agents.accounts.line.off',
      attention: false,
    });
  });

  it('needs attention when the account in use can not be read, whatever else is true', () => {
    const v = accountsPointer(st([acct('Work', { active: true, unreadable: true, needsSignIn: true })]), NOW);
    expect(v).toMatchObject({
      tone: 'wait',
      icon: ICON.wait,
      pill: 'prefs.agents.accounts.pill.attention',
      line: 'prefs.agents.accounts.line.unreadable',
      vars: { name: 'Work' },
      attention: true,
    });
  });

  it('needs attention when Claude refused the sign-in of the account in use', () => {
    const v = accountsPointer(st([acct('Work', { active: true, needsSignIn: true }), acct('Home')]), NOW);
    expect(v).toMatchObject({
      tone: 'wait',
      line: 'prefs.agents.accounts.line.refused',
      vars: { name: 'Work' },
      attention: true,
    });
  });

  it('needs attention when the only account is out of usage', () => {
    const v = accountsPointer(st([acct('Work', { active: true, ...out() })]), NOW);
    expect(v).toMatchObject({
      tone: 'wait',
      line: 'prefs.agents.accounts.line.oneOut',
      vars: { name: 'Work' },
      attention: true,
    });
  });

  it('needs attention when every account is out of usage', () => {
    const v = accountsPointer(st([acct('Work', { active: true, ...out() }), acct('Home', out(5))]), NOW);
    expect(v).toMatchObject({ tone: 'wait', line: 'prefs.agents.accounts.line.allOut', vars: {}, attention: true });
  });

  it('does not call a sign-in expired because a spare account can not be read', () => {
    // needsAttention counts only accounts a chat could run on, so this
    // state needs attention for usage — not for an expired sign-in.
    const v = accountsPointer(st([acct('Work', { active: true, ...out() }), acct('Home', { unreadable: true })]), NOW);
    expect(v).toMatchObject({ line: 'prefs.agents.accounts.line.oneOut', vars: { name: 'Work' }, attention: true });
  });

  it('needs attention when the sign-in of the account in use has expired', () => {
    const v = accountsPointer(st([acct('Work', { active: true, addedAt: NOW - 366 * DAY }), acct('Home')]), NOW);
    expect(v).toMatchObject({
      tone: 'wait',
      line: 'prefs.agents.accounts.line.expired',
      vars: { name: 'Work' },
      attention: true,
    });
  });

  it('is running on the one account', () => {
    const v = accountsPointer(st([acct('Work', { active: true })]), NOW);
    expect(v).toMatchObject({
      tone: 'done',
      icon: ICON.done,
      pill: 'prefs.agents.accounts.pill.running',
      pillVars: { name: 'Work' },
      line: 'prefs.agents.accounts.line.one',
      vars: { name: 'Work' },
      attention: false,
    });
  });

  it('is running on the account in use and counts the others', () => {
    const v = accountsPointer(st([acct('Home'), acct('Work', { active: true }), acct('Lab')]), NOW);
    expect(v).toMatchObject({
      tone: 'done',
      pill: 'prefs.agents.accounts.pill.running',
      line: 'prefs.agents.accounts.line.many',
      vars: { name: 'Work', count: 3 },
      attention: false,
    });
  });

  it('is not alarmed by another account being out of usage', () => {
    const v = accountsPointer(st([acct('Work', { active: true }), acct('Home', out())]), NOW);
    expect(v).toMatchObject({ tone: 'done', attention: false });
  });

  it('clips a long name in the pill and keeps it whole in the sentence', () => {
    const name = 'Proof of Play engineering shared account';
    const v = accountsPointer(st([acct(name, { active: true })]), NOW);
    expect(v?.pillVars.name).toBe('Proof of Play engineerin…');
    expect(v?.vars.name).toBe(name);
  });
});

describe('clipName', () => {
  it('leaves a name of 24 characters or fewer alone', () => {
    expect(clipName('Work')).toBe('Work');
    expect(clipName('a'.repeat(24))).toBe('a'.repeat(24));
  });

  it('cuts at 24 characters and adds an ellipsis', () => {
    expect(clipName('a'.repeat(25))).toBe(`${'a'.repeat(24)}…`);
    expect(clipName('abcdef', 3)).toBe('abc…');
  });

  it('does not leave a space before the ellipsis', () => {
    expect(clipName('ab cdef', 3)).toBe('ab…');
  });
});

describe('default effort', () => {
  it('offers every Claude level and no None for Codex', () => {
    expect(CLAUDE_EFFORT_CHOICES).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
    expect(CODEX_EFFORT_CHOICES).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('shows a saved None as Low and every other level as itself', () => {
    expect(shownCodexEffort('none')).toBe('low');
    for (const effort of CODEX_EFFORT_CHOICES) expect(shownCodexEffort(effort)).toBe(effort);
  });

  it('puts the cost in the text of the two levels that hand work to helper agents', () => {
    expect(effortOptionKey('ultracode')).toBe('prefs.agents.effort.option.ultracode');
    expect(effortOptionKey('ultra')).toBe('prefs.agents.effort.option.ultra');
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) expect(effortOptionKey(effort)).toBeNull();
  });
});

describe('codexCli', () => {
  it('reads the version out of the raw --version text', () => {
    expect(codexCli({ ok: true, version: 'codex-cli 0.167.1' })).toEqual({ version: '0.167.1', ok: true });
  });

  it('is too old below 0.153', () => {
    expect(codexCli({ ok: true, version: 'codex-cli 0.149.0' })).toEqual({ version: '0.149.0', ok: false });
    expect(codexCli({ ok: true, version: '0.152.9' })).toEqual({ version: '0.152.9', ok: false });
    expect(codexCli({ ok: true, version: '0.153.0' })).toEqual({ version: '0.153.0', ok: true });
  });

  it('is new enough from 1.0 on', () => {
    expect(codexCli({ ok: true, version: '1.0.0' })).toEqual({ version: '1.0.0', ok: true });
  });

  it('claims nothing when no installed CLI was found, the text can not be parsed, or nothing answered yet', () => {
    expect(codexCli({ ok: false })).toBeNull();
    expect(codexCli({ ok: false, version: 'codex-cli 0.149.0' })).toBeNull();
    expect(codexCli({ ok: true })).toBeNull();
    expect(codexCli({ ok: true, version: 'codex (unknown build)' })).toBeNull();
    expect(codexCli(null)).toBeNull();
  });
});

describe('steerView', () => {
  const NEW = { version: '0.167.1', ok: true };
  const OLD = { version: '0.149.0', ok: false };

  it('rests on a plain On or Off pill and no line', () => {
    expect(steerView(false, NEW, false)).toEqual({ pill: { tone: 'muted', icon: null, key: 'prefs.agents.switch.off' }, lines: [] });
    expect(steerView(true, NEW, false)).toEqual({ pill: { tone: 'done', icon: null, key: 'prefs.agents.switch.on' }, lines: [] });
  });

  it('says nothing about versions when it can not read one', () => {
    expect(steerView(true, null, false).lines).toEqual([]);
    expect(steerView(true, null, false).pill.key).toBe('prefs.agents.switch.on');
    expect(steerView(false, null, false).lines).toEqual([]);
  });

  it('says when the change takes effect once the switch was flipped, either way', () => {
    const timing = { tone: 'timing', key: 'prefs.agents.steer.timing' };
    expect(steerView(true, NEW, true).lines).toEqual([timing]);
    expect(steerView(false, NEW, true).lines).toEqual([timing]);
    expect(steerView(true, null, true).lines).toEqual([timing]);
  });

  it('names the installed version before the switch is used when the CLI is too old', () => {
    const v = steerView(false, OLD, false);
    expect(v.pill.key).toBe('prefs.agents.switch.off');
    expect(v.lines).toEqual([{ tone: 'warn', key: 'prefs.agents.steer.req.oldOff', vars: { version: '0.149.0' } }]);
  });

  it('while a Codex account is in use it is on whatever the switch says, and says why', () => {
    const why = { tone: 'hint', key: 'prefs.agents.steer.forced' };
    for (const on of [true, false]) {
      expect(steerView(on, NEW, false, true)).toEqual({ pill: { tone: 'done', icon: null, key: 'prefs.agents.steer.pill.forced' }, lines: [why] });
      // No "applies from the next message": the switch was not what changed it.
      expect(steerView(on, NEW, true, true).lines).toEqual([why]);
      expect(steerView(on, null, false, true).pill.key).toBe('prefs.agents.steer.pill.forced');
    }
    // A CLI too old for the app server is a problem either way.
    expect(steerView(false, OLD, false, true)).toEqual({
      pill: { tone: 'wait', icon: ICON.wait, key: 'prefs.agents.steer.pill.tooOld' },
      lines: [{ tone: 'warn', key: 'prefs.agents.steer.req.oldForced', vars: { version: '0.149.0' } }, why],
    });
  });

  it('turns the pill amber, never a plain On, when it is on with a CLI that is too old', () => {
    const v = steerView(true, OLD, false);
    expect(v.pill).toEqual({ tone: 'wait', icon: ICON.wait, key: 'prefs.agents.steer.pill.tooOld' });
    expect(v.lines).toEqual([{ tone: 'warn', key: 'prefs.agents.steer.req.oldOn', vars: { version: '0.149.0' } }]);
  });

  it('keeps the version line first when the switch was just flipped', () => {
    expect(steerView(true, OLD, true).lines.map((l) => l.key)).toEqual([
      'prefs.agents.steer.req.oldOn',
      'prefs.agents.steer.timing',
    ]);
  });
});

describe('controlView', () => {
  it('invites a try while it is on and was not touched', () => {
    expect(controlView(true, false)).toEqual({
      pill: { tone: 'done', icon: null, key: 'prefs.agents.switch.on' },
      lines: [{ tone: 'hint', key: 'prefs.agents.control.try' }],
    });
  });

  it('says when open chats get it just after it was switched on', () => {
    expect(controlView(true, true).lines).toEqual([{ tone: 'timing', key: 'prefs.agents.control.changedOn' }]);
  });

  it('says what Off does to a running agent, at rest and just after the flip', () => {
    const off = { pill: { tone: 'muted', icon: null, key: 'prefs.agents.switch.off' }, lines: [{ tone: 'timing', key: 'prefs.agents.control.off' }] };
    expect(controlView(false, false)).toEqual(off);
    expect(controlView(false, true)).toEqual(off);
  });
});

describe('keyErrorKind', () => {
  it('knows the two fixed prefixes main produces', () => {
    expect(keyErrorKind(REJECTED)).toBe('rejected');
    expect(keyErrorKind(FORBIDDEN)).toBe('forbidden');
  });

  it('reads any mention of a workspace as needing one', () => {
    expect(keyErrorKind(NEEDS_WORKSPACE)).toBe('workspace');
    expect(keyErrorKind('the API key is not allowed to use Managed Agents (no Workspace was given)')).toBe('workspace');
  });

  it('treats a network error and anything unrecognised as "could not check"', () => {
    expect(keyErrorKind(NETWORK)).toBe('unchecked');
    expect(keyErrorKind('fetch failed')).toBe('unchecked');
    expect(keyErrorKind('no key given')).toBe('unchecked');
    expect(keyErrorKind('')).toBe('unchecked');
  });
});

describe('apiKeyProblem', () => {
  it('lets a real-shaped key through to its check', () => {
    expect(apiKeyProblem('sk-ant-api03-AbCdEf0123456789_-AbCdEf0123456789')).toBeNull();
  });

  it('leaves anything not plainly wrong to Anthropic', () => {
    expect(apiKeyProblem('hello')).toBeNull();
  });

  it('refuses text with a space or a line break', () => {
    expect(apiKeyProblem('sk-ant-api03-AbCd Ef01')).toBe('spaces');
    expect(apiKeyProblem('sk-ant-api03-AbCd\nEf01')).toBe('spaces');
  });

  it('refuses a link', () => {
    expect(apiKeyProblem('https://platform.claude.com/settings/keys')).toBe('link');
    expect(apiKeyProblem('HTTP://example.com/key')).toBe('link');
  });

  it('refuses a GitHub token', () => {
    expect(apiKeyProblem('ghp_AbCdEf0123456789AbCdEf0123456789AbCd')).toBe('github');
    expect(apiKeyProblem('github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz')).toBe('github');
  });
});

describe('githubTokenProblem', () => {
  it('accepts the token shapes GitHub issues', () => {
    expect(githubTokenProblem('ghp_AbCdEf0123456789AbCdEf0123456789AbCd')).toBeNull();
    expect(githubTokenProblem('gho_AbCdEf0123456789AbCdEf0123456789AbCd')).toBeNull();
    expect(githubTokenProblem('github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz')).toBeNull();
    expect(githubTokenProblem('0123456789abcdef0123456789abcdef01234567')).toBeNull();
  });

  it('refuses an Anthropic API key', () => {
    expect(githubTokenProblem('sk-ant-api03-AbCdEf0123456789')).toBe('anthropic');
  });

  it('refuses a link', () => {
    expect(githubTokenProblem('https://github.com/settings/tokens')).toBe('link');
  });

  it('refuses text with a space or a line break', () => {
    expect(githubTokenProblem('ghp_AbCdEf0123456789 AbCdEf0123456789AbCd')).toBe('spaces');
    expect(githubTokenProblem('ghp_AbCdEf0123456789\nAbCdEf0123456789AbCd')).toBe('spaces');
  });

  it('refuses anything else that does not look like a token', () => {
    expect(githubTokenProblem('hello')).toBe('format');
    expect(githubTokenProblem('ghp_short')).toBe('format');
    expect(githubTokenProblem('ghx_AbCdEf0123456789AbCdEf0123456789AbCd')).toBe('format');
  });
});

describe('cloudPill', () => {
  it('is checking until the status is known', () => {
    expect(cloudPill(null, null)).toEqual({ tone: 'muted', icon: ICON.checking, key: 'prefs.agents.cloud.pill.checking' });
  });

  it('is not set up with no key anywhere, whatever GitHub says', () => {
    const notSetUp = { tone: 'muted', icon: ICON.notSetUp, key: 'prefs.agents.cloud.pill.notSetUp' };
    expect(cloudPill(status(), null)).toEqual(notSetUp);
    expect(cloudPill(status({ githubToken: 'gh' }), null)).toEqual(notSetUp);
  });

  it('is checking while the key in use is being checked — and before its check has started', () => {
    expect(cloudPill(status({ apiKey: 'env', githubToken: 'gh' }), CHECKING).key).toBe('prefs.agents.cloud.pill.checking');
    expect(cloudPill(status({ apiKey: 'settings', githubToken: 'gh' }), null).key).toBe('prefs.agents.cloud.pill.checking');
  });

  it('is "Key not working" when the key in use was rejected, is not allowed, or needs a workspace', () => {
    for (const error of [REJECTED, FORBIDDEN, NEEDS_WORKSPACE]) {
      expect(cloudPill(status({ apiKey: 'env', githubToken: 'gh' }), failedCheck(error))).toEqual({
        tone: 'err',
        icon: ICON.err,
        key: 'prefs.agents.cloud.pill.keyBroken',
      });
    }
  });

  it('is amber "Key not checked" when the key could not be checked — never broken, never ready', () => {
    expect(cloudPill(status({ apiKey: 'settings', githubToken: 'gh' }), failedCheck(NETWORK))).toEqual({
      tone: 'wait',
      icon: ICON.wait,
      key: 'prefs.agents.cloud.pill.keyUnchecked',
    });
    // What main answers if it has no key to check: also not Ready.
    expect(cloudPill(status({ apiKey: 'env', githubToken: 'gh' }), failedCheck('no key given')).key)
      .toBe('prefs.agents.cloud.pill.keyUnchecked');
  });

  it('is "No GitHub access" when the key works and nothing can clone', () => {
    expect(cloudPill(status({ apiKey: 'env' }), OK)).toEqual({ tone: 'wait', icon: ICON.wait, key: 'prefs.agents.cloud.pill.noGithub' });
  });

  it('is ready only when the key in use passed its check, saved or from the environment', () => {
    const ready = { tone: 'done', icon: ICON.done, key: 'prefs.agents.cloud.pill.ready' };
    expect(cloudPill(status({ apiKey: 'env', githubToken: 'gh' }), OK)).toEqual(ready);
    expect(cloudPill(status({ apiKey: 'settings', githubToken: 'settings', hasSettingsKey: true }), OK)).toEqual(ready);
  });
});

describe('keyWorks', () => {
  it('needs a key and a check that passed', () => {
    expect(keyWorks(status({ apiKey: 'env' }), OK)).toBe(true);
    expect(keyWorks(status({ apiKey: 'env' }), CHECKING)).toBe(false);
    expect(keyWorks(status({ apiKey: 'env' }), null)).toBe(false);
    expect(keyWorks(status({ apiKey: 'env' }), failedCheck(NETWORK))).toBe(false);
    expect(keyWorks(status(), OK)).toBe(false);
    expect(keyWorks(null, OK)).toBe(false);
  });
});

describe('keyRow', () => {
  it('holds a spinner and nothing else until the status is known', () => {
    expect(keyRow(null, null)).toEqual({ mark: 'checking', sentence: [], detail: null, actions: [], mode: null });
  });

  it('is step 1, with one link, when there is no key', () => {
    expect(keyRow(status(), null)).toEqual({
      mark: 'next',
      sentence: ['prefs.agents.cloud.key.none'],
      detail: null,
      actions: ['getKey'],
      mode: 'first',
    });
  });

  it('shows no buttons while a key from the environment is checked on open', () => {
    expect(keyRow(status({ apiKey: 'env' }), CHECKING)).toEqual({
      mark: 'checking',
      sentence: ['prefs.agents.cloud.envKey', 'prefs.agents.cloud.key.checking'],
      detail: null,
      actions: [],
      mode: 'replace',
    });
    expect(keyRow(status({ apiKey: 'env' }), null).mark).toBe('checking');
  });

  it('keeps its buttons while a check the user asked for runs', () => {
    expect(keyRow(status({ apiKey: 'env' }), CHECKING, true).actions).toEqual(['checkAgain', 'useOther']);
    expect(keyRow(status({ apiKey: 'settings' }), CHECKING, true).actions).toEqual(['checkAgain', 'replace', 'remove']);
  });

  it('ticks a key from the environment that works', () => {
    expect(keyRow(status({ apiKey: 'env' }), OK)).toEqual({
      mark: 'ok',
      sentence: ['prefs.agents.cloud.envKey', 'prefs.agents.cloud.ok'],
      detail: null,
      actions: ['useOther'],
      mode: 'replace',
    });
  });

  it('ticks a saved key that works, with Replace and Remove', () => {
    expect(keyRow(status({ apiKey: 'settings', hasSettingsKey: true }), OK)).toEqual({
      mark: 'ok',
      sentence: ['prefs.agents.cloud.key.saved', 'prefs.agents.cloud.ok'],
      detail: null,
      actions: ['replace', 'remove'],
      mode: 'replace',
    });
  });

  it('says a rejected environment key has to be fixed outside PopBot, and shows what Anthropic said', () => {
    expect(keyRow(status({ apiKey: 'env' }), failedCheck(REJECTED))).toEqual({
      mark: 'error',
      sentence: ['prefs.agents.cloud.envKey', 'prefs.agents.cloud.key.inUse.rejected', 'prefs.agents.cloud.key.envFix'],
      detail: REJECTED,
      actions: ['checkAgain', 'useOther'],
      mode: 'replace',
    });
  });

  it('says a saved key stopped working, with Check again first', () => {
    expect(keyRow(status({ apiKey: 'settings' }), failedCheck(REJECTED))).toEqual({
      mark: 'error',
      sentence: ['prefs.agents.cloud.key.saved', 'prefs.agents.cloud.key.inUse.rejected'],
      detail: REJECTED,
      actions: ['checkAgain', 'replace', 'remove'],
      mode: 'replace',
    });
  });

  it('marks a key that could not be checked amber, not red', () => {
    const v = keyRow(status({ apiKey: 'env' }), failedCheck(NETWORK));
    expect(v.mark).toBe('warn');
    expect(v.sentence).toEqual(['prefs.agents.cloud.envKey', 'prefs.agents.cloud.key.inUse.unchecked']);
    expect(v.actions).toEqual(['checkAgain', 'useOther']);
  });

  it('words a key that is not allowed, and one that needs a workspace', () => {
    expect(keyRow(status({ apiKey: 'settings' }), failedCheck(FORBIDDEN)).sentence)
      .toEqual(['prefs.agents.cloud.key.saved', 'prefs.agents.cloud.key.inUse.forbidden']);
    expect(keyRow(status({ apiKey: 'env' }), failedCheck(NEEDS_WORKSPACE)).sentence)
      .toEqual(['prefs.agents.cloud.envKey', 'prefs.agents.cloud.key.inUse.workspace']);
  });
});

describe('githubRow', () => {
  it('holds a spinner until the status is known', () => {
    expect(githubRow(null, null)).toEqual({ mark: 'checking', sentence: null, actions: [], mode: null, howTo: false });
  });

  it('ticks a sign-in gh reports, even before the key works', () => {
    const row = { mark: 'ok', sentence: 'prefs.agents.cloud.github.gh', actions: ['useToken'], mode: 'replace', howTo: false };
    expect(githubRow(status({ apiKey: 'env', githubToken: 'gh' }), OK)).toEqual(row);
    expect(githubRow(status({ githubToken: 'gh' }), null)).toEqual(row);
  });

  it('gives a pasted token a grey mark, never the green tick', () => {
    expect(githubRow(status({ apiKey: 'env', githubToken: 'settings' }), OK)).toEqual({
      mark: 'set',
      sentence: 'prefs.agents.cloud.github.saved',
      actions: ['replace', 'remove'],
      mode: 'replace',
      howTo: false,
    });
  });

  it('is only named, with no buttons, until the key works', () => {
    const later = { mark: 'later', sentence: 'prefs.agents.cloud.github.later', actions: [], mode: null, howTo: false };
    expect(githubRow(status(), null)).toEqual(later);
    expect(githubRow(status({ apiKey: 'env' }), CHECKING)).toEqual(later);
    expect(githubRow(status({ apiKey: 'env' }), failedCheck(REJECTED))).toEqual(later);
    expect(githubRow(status({ apiKey: 'env' }), failedCheck(NETWORK))).toEqual(later);
  });

  it('becomes step 2 with Look again and Paste a token once the key works', () => {
    expect(githubRow(status({ apiKey: 'settings' }), OK)).toEqual({
      mark: 'next',
      sentence: 'prefs.agents.cloud.github.none',
      actions: ['lookAgain', 'paste'],
      mode: 'first',
      howTo: true,
    });
  });
});

describe('cloudFooter', () => {
  it('is absent until the key works', () => {
    expect(cloudFooter(null, null)).toBeNull();
    expect(cloudFooter(status(), null)).toBeNull();
    expect(cloudFooter(status({ apiKey: 'env', githubToken: 'gh' }), CHECKING)).toBeNull();
    expect(cloudFooter(status({ apiKey: 'env', githubToken: 'gh' }), failedCheck(REJECTED))).toBeNull();
    expect(cloudFooter(status({ apiKey: 'env', githubToken: 'gh' }), failedCheck(NETWORK))).toBeNull();
  });

  it('says how to start a cloud chat once the key works and GitHub access exists', () => {
    expect(cloudFooter(status({ apiKey: 'env', githubToken: 'gh' }), OK)).toBe('ready');
    expect(cloudFooter(status({ apiKey: 'settings', githubToken: 'settings' }), OK)).toBe('ready');
  });

  it('says what works already when the key works without GitHub access', () => {
    expect(cloudFooter(status({ apiKey: 'env' }), OK)).toBe('noGithub');
  });
});

describe('markView', () => {
  it('draws a step still to do as a number, filled when it is next', () => {
    expect(markView('next')).toEqual({ cls: 'num next', icon: null });
    expect(markView('later')).toEqual({ cls: 'num', icon: null });
  });

  it('tells verified from merely saved, and could-not-check from broken', () => {
    expect(markView('ok')).toEqual({ cls: 'ok', icon: ICON.done });
    expect(markView('set')).toEqual({ cls: 'set', icon: 'fa-solid fa-check' });
    expect(markView('warn')).toEqual({ cls: 'warn', icon: ICON.wait });
    expect(markView('error')).toEqual({ cls: 'error', icon: ICON.err });
    expect(markView('checking')).toEqual({ cls: '', icon: ICON.checking });
  });
});

describe('secretMode / leaveOutcome', () => {
  it('is a first secret while nothing is in use, a replacement otherwise', () => {
    expect(secretMode(null)).toBe('first');
    expect(secretMode('env')).toBe('replace');
    expect(secretMode('settings')).toBe('replace');
    expect(secretMode('gh')).toBe('replace');
  });

  it('applies a first secret when its row is left with text in it', () => {
    expect(leaveOutcome('first', 'sk-ant-api03-x', false)).toBe('apply');
  });

  it('does nothing with an empty first field', () => {
    expect(leaveOutcome('first', '', false)).toBe('nothing');
    expect(leaveOutcome('first', '   ', false)).toBe('nothing');
  });

  it('never applies a replacement by leaving: it is let go, with or without text', () => {
    expect(leaveOutcome('replace', 'sk-ant-api03-x', false)).toBe('discard');
    expect(leaveOutcome('replace', '', false)).toBe('discard');
  });

  it('does nothing while a check is running', () => {
    expect(leaveOutcome('first', 'sk-ant-api03-x', true)).toBe('nothing');
    expect(leaveOutcome('replace', 'sk-ant-api03-x', true)).toBe('nothing');
  });
});

describe('keyFieldLine', () => {
  const base = { source: null, draft: '', checking: false, verdict: null, note: null } as const;

  it('starts on the hint that fits where the key in use comes from', () => {
    expect(keyFieldLine(base).line).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.key.hint.first' });
    expect(keyFieldLine({ ...base, source: 'settings' }).line.key).toBe('prefs.agents.cloud.key.hint.replaceSaved');
    expect(keyFieldLine({ ...base, source: 'env' }).line.key).toBe('prefs.agents.cloud.key.hint.replaceEnv');
  });

  it('says how to apply once there is text', () => {
    expect(keyFieldLine({ ...base, draft: 'sk-ant-x' }).line).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.key.dirty' });
    expect(keyFieldLine({ ...base, source: 'env', draft: 'sk-ant-x' }).line.key).toBe('prefs.agents.cloud.key.dirtyReplace');
  });

  it('says it is checking, over everything else', () => {
    const v = keyFieldLine({ ...base, draft: 'sk-ant-x', checking: true, verdict: { kind: 'rejected', error: REJECTED } });
    expect(v).toEqual({ line: { tone: 'busy', key: 'prefs.agents.cloud.key.checking' }, stillInUse: false, detail: null, invalid: false });
  });

  it('gives a local refusal its own red line, with nothing from the network to show', () => {
    for (const kind of ['spaces', 'link', 'github'] as const) {
      expect(keyFieldLine({ ...base, draft: 'x', verdict: { kind } })).toEqual({
        line: { tone: 'error', key: `prefs.agents.cloud.key.draft.${kind}` },
        stillInUse: false,
        detail: null,
        invalid: true,
      });
    }
  });

  it('gives each failed check its own red line, with what Anthropic said beneath', () => {
    expect(keyFieldLine({ ...base, draft: 'x', verdict: { kind: 'rejected', error: REJECTED } })).toEqual({
      line: { tone: 'error', key: 'prefs.agents.cloud.key.draft.rejected' },
      stillInUse: false,
      detail: REJECTED,
      invalid: true,
    });
    expect(keyFieldLine({ ...base, draft: 'x', verdict: { kind: 'forbidden', error: FORBIDDEN } }).line.key)
      .toBe('prefs.agents.cloud.key.draft.forbidden');
    expect(keyFieldLine({ ...base, draft: 'x', verdict: { kind: 'workspace', error: NEEDS_WORKSPACE } }).line.key)
      .toBe('prefs.agents.cloud.key.draft.workspace');
    expect(keyFieldLine({ ...base, draft: 'x', verdict: { kind: 'unchecked', error: NETWORK } }).line.key)
      .toBe('prefs.agents.cloud.key.draft.unchecked');
  });

  it('adds that the current key is still in use to every failure when there is one', () => {
    expect(keyFieldLine({ ...base, source: 'settings', draft: 'x', verdict: { kind: 'rejected', error: REJECTED } }).stillInUse).toBe(true);
    expect(keyFieldLine({ ...base, source: 'env', draft: 'x', verdict: { kind: 'link' } }).stillInUse).toBe(true);
  });

  it('shows the verdict left from before Preferences closed, under the empty field only', () => {
    expect(keyFieldLine({ ...base, note: 'lastFailed' }).line).toEqual({ tone: 'warn', key: 'prefs.agents.cloud.key.lastFailed' });
    expect(keyFieldLine({ ...base, note: 'lastFailed', draft: 'sk-ant-x' }).line.key).toBe('prefs.agents.cloud.key.dirty');
  });
});

describe('tokenFieldLine', () => {
  it('starts on the hint that fits what is in use', () => {
    expect(tokenFieldLine({ source: null, draft: '', problem: null })).toEqual({
      line: { tone: 'hint', key: 'prefs.agents.cloud.github.hint' },
      invalid: false,
    });
    expect(tokenFieldLine({ source: 'gh', draft: '', problem: null }).line.key).toBe('prefs.agents.cloud.github.hint.overrideGh');
    expect(tokenFieldLine({ source: 'settings', draft: '', problem: null }).line.key).toBe('prefs.agents.cloud.github.hint.replace');
  });

  it('says how to apply once there is text', () => {
    expect(tokenFieldLine({ source: null, draft: 'ghp_x', problem: null }).line.key).toBe('prefs.agents.cloud.github.dirty');
    expect(tokenFieldLine({ source: 'gh', draft: 'ghp_x', problem: null }).line.key).toBe('prefs.agents.cloud.github.dirtyReplace');
    expect(tokenFieldLine({ source: 'settings', draft: 'ghp_x', problem: null }).line.key).toBe('prefs.agents.cloud.github.dirtyReplace');
  });

  it('gives each refusal its own red line', () => {
    for (const problem of ['spaces', 'link', 'anthropic', 'format'] as const) {
      expect(tokenFieldLine({ source: null, draft: 'x', problem })).toEqual({
        line: { tone: 'error', key: `prefs.agents.cloud.github.draft.${problem}` },
        invalid: true,
      });
    }
  });
});

describe('tokenCloseKey', () => {
  it('names what stays in use, and offers "Not now" when nothing is', () => {
    expect(tokenCloseKey(null)).toBe('prefs.agents.cloud.github.notNow');
    expect(tokenCloseKey('settings')).toBe('prefs.agents.cloud.github.keep');
    expect(tokenCloseKey('gh')).toBe('prefs.agents.cloud.github.keepGh');
  });
});

describe('workspaceView / lastKeyFailure', () => {
  it('shows nothing at rest', () => {
    expect(workspaceView({ savedId: undefined, editing: false, lastKind: null })).toBe('none');
    expect(workspaceView({ savedId: undefined, editing: false, lastKind: 'rejected' })).toBe('none');
    expect(workspaceView({ savedId: '  ', editing: false, lastKind: null })).toBe('none');
  });

  it('shows a saved ID as a sentence, not a field', () => {
    expect(workspaceView({ savedId: 'wrkspc_01AbCdEf', editing: false, lastKind: null })).toBe('sentence');
    expect(workspaceView({ savedId: 'wrkspc_01AbCdEf', editing: false, lastKind: 'workspace' })).toBe('sentence');
  });

  it('opens the field by itself when a check says the key needs a workspace', () => {
    expect(workspaceView({ savedId: undefined, editing: false, lastKind: 'workspace' })).toBe('field');
  });

  it('offers the link only after a "not allowed" or "not checked" failure', () => {
    expect(workspaceView({ savedId: undefined, editing: false, lastKind: 'forbidden' })).toBe('addLink');
    expect(workspaceView({ savedId: undefined, editing: false, lastKind: 'unchecked' })).toBe('addLink');
  });

  it('is a field for as long as it is being edited', () => {
    expect(workspaceView({ savedId: 'wrkspc_01AbCdEf', editing: true, lastKind: null })).toBe('field');
    expect(workspaceView({ savedId: undefined, editing: true, lastKind: null })).toBe('field');
  });

  it('answers to the typed key\'s last check first, then to the key in use', () => {
    expect(lastKeyFailure('forbidden', failedCheck(REJECTED))).toBe('forbidden');
    expect(lastKeyFailure(null, failedCheck(NEEDS_WORKSPACE))).toBe('workspace');
    expect(lastKeyFailure(null, OK)).toBeNull();
    expect(lastKeyFailure(null, CHECKING)).toBeNull();
    expect(lastKeyFailure(null, null)).toBeNull();
  });
});

describe('workspaceLine', () => {
  const open = { fieldOpen: true, draft: '', busy: false, verdict: null, note: null } as const;
  const closed = { ...open, fieldOpen: false } as const;

  it('says where to find one, then how to apply it, under the open field', () => {
    expect(workspaceLine(open)).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.ws.help' });
    expect(workspaceLine({ ...open, draft: 'wrkspc_01' })).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.ws.dirty' });
  });

  it('says it is checking, then that the ID was not saved', () => {
    expect(workspaceLine({ ...open, draft: 'wrkspc_01', busy: true })).toEqual({ tone: 'busy', key: 'prefs.agents.cloud.key.checking' });
    expect(workspaceLine({ ...open, draft: 'wrkspc_01', verdict: 'fail' })).toEqual({ tone: 'error', key: 'prefs.agents.cloud.ws.fail' });
  });

  it('confirms the ID that was just saved once the field has closed', () => {
    expect(workspaceLine({ ...closed, verdict: 'ok' })).toEqual({ tone: 'ok', key: 'prefs.agents.cloud.ws.ok' });
  });

  it('says a change was let go', () => {
    expect(workspaceLine({ ...closed, note: 'notChanged' })).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.ws.notChanged' });
  });

  it('says nothing at rest', () => {
    expect(workspaceLine(closed)).toBeNull();
  });
});

describe('keyNoteLine / githubNoteLine', () => {
  it('says a replacement key was let go, while there is a key for that to be true of', () => {
    expect(keyNoteLine('notChanged', 'settings')).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.key.notChanged' });
    expect(keyNoteLine('notChanged', 'env')).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.key.notChanged' });
    expect(keyNoteLine('notChanged', null)).toBeNull();
    expect(keyNoteLine('lastFailed', 'settings')).toBeNull();
    expect(keyNoteLine(null, 'settings')).toBeNull();
  });

  it('confirms a token that was just saved', () => {
    expect(githubNoteLine('savedNow', 'settings')).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.github.savedNow' });
    expect(githubNoteLine('savedNow', null)).toBeNull();
  });

  it('says "still not found" only while nothing is found', () => {
    expect(githubNoteLine('stillNone', null)).toEqual({ tone: 'warn', key: 'prefs.agents.cloud.github.stillNone' });
    expect(githubNoteLine('stillNone', 'gh')).toBeNull();
  });

  it('says a replacement token was let go', () => {
    expect(githubNoteLine('notChanged', 'gh')).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.github.notChanged' });
    expect(githubNoteLine('notChanged', 'settings')).toEqual({ tone: 'hint', key: 'prefs.agents.cloud.github.notChanged' });
    expect(githubNoteLine('notChanged', null)).toBeNull();
  });

  it('carries a refusal from before Preferences closed until a token is saved', () => {
    expect(githubNoteLine('lastFailed', null)).toEqual({ tone: 'warn', key: 'prefs.agents.cloud.github.lastFailed' });
    expect(githubNoteLine('lastFailed', 'settings')).toBeNull();
    expect(githubNoteLine(null, null)).toBeNull();
  });
});

describe('state lines', () => {
  it('gives every tone an icon, so none is told apart by colour alone', () => {
    expect(lineIcon('hint')).toBe(ICON.hint);
    expect(lineIcon('timing')).toBe(ICON.timing);
    expect(lineIcon('busy')).toBe(ICON.checking);
    expect(lineIcon('ok')).toBe(ICON.done);
    expect(lineIcon('warn')).toBe(ICON.wait);
    expect(lineIcon('error')).toBe(ICON.err);
  });

  it('colours only the verdicts', () => {
    expect(lineClass('hint')).toBe('');
    expect(lineClass('timing')).toBe('');
    expect(lineClass('busy')).toBe('');
    expect(lineClass('ok')).toBe('ok');
    expect(lineClass('warn')).toBe('warn');
    expect(lineClass('error')).toBe('error');
  });
});

describe('what is saved', () => {
  const saved = { apiKey: 'sk-ant-old', githubToken: 'ghp_old', workspaceId: 'wrkspc_old' };

  it('replaces the key and keeps the rest', () => {
    expect(withApiKey(saved, 'sk-ant-new')).toEqual({ ...saved, apiKey: 'sk-ant-new' });
    expect(withApiKey({}, 'sk-ant-new')).toEqual({ apiKey: 'sk-ant-new' });
  });

  it('saves the Workspace ID a key was checked with', () => {
    expect(withApiKey(saved, 'sk-ant-new', 'wrkspc_new')).toEqual({ ...saved, apiKey: 'sk-ant-new', workspaceId: 'wrkspc_new' });
    expect(withApiKey({ githubToken: 'ghp_old' }, 'sk-ant-new', 'wrkspc_new'))
      .toEqual({ githubToken: 'ghp_old', apiKey: 'sk-ant-new', workspaceId: 'wrkspc_new' });
  });

  it('replaces the token, or the Workspace ID, and keeps the rest', () => {
    expect(withGithubToken(saved, 'ghp_new')).toEqual({ ...saved, githubToken: 'ghp_new' });
    expect(withWorkspaceId(saved, 'wrkspc_new')).toEqual({ ...saved, workspaceId: 'wrkspc_new' });
  });

  it('removes one field and only that one', () => {
    expect(withoutField(saved, 'apiKey')).toEqual({ githubToken: 'ghp_old', workspaceId: 'wrkspc_old' });
    expect(withoutField(saved, 'githubToken')).toEqual({ apiKey: 'sk-ant-old', workspaceId: 'wrkspc_old' });
    expect(withoutField(saved, 'workspaceId')).toEqual({ apiKey: 'sk-ant-old', githubToken: 'ghp_old' });
    expect('apiKey' in withoutField(saved, 'apiKey')).toBe(false);
  });

  it('never changes what it was given', () => {
    const before = { ...saved };
    withApiKey(saved, 'sk-ant-new', 'wrkspc_new');
    withoutField(saved, 'apiKey');
    expect(saved).toEqual(before);
  });
});

describe('the strings', () => {
  // Every key this module hands the pane, gathered from each view, exists
  // in the English catalog (the type says so too; this also catches a key
  // built from a template).
  const keys = new Set<string>();
  const add = (...list: Array<string | null | undefined>): void => {
    for (const key of list) if (key) keys.add(key);
  };
  const accountStates = [
    st([]),
    st([], { encryptionAvailable: false }),
    st([acct('Work')]),
    st([acct('Work', { active: true, unreadable: true })]),
    st([acct('Work', { active: true, needsSignIn: true })]),
    st([acct('Work', { active: true, ...out() })]),
    st([acct('Work', { active: true, ...out() }), acct('Home', out())]),
    st([acct('Work', { active: true, addedAt: NOW - 366 * DAY })]),
    st([acct('Work', { active: true })]),
    st([acct('Work', { active: true }), acct('Home')]),
  ];
  for (const state of accountStates) {
    const v = accountsPointer(state, NOW);
    add(v?.pill, v?.line);
  }
  const checks: Array<KeyCheck | null> = [null, CHECKING, OK, failedCheck(REJECTED), failedCheck(FORBIDDEN), failedCheck(NEEDS_WORKSPACE), failedCheck(NETWORK)];
  const statuses: Array<CloudStatus | null> = [
    null,
    status(),
    status({ apiKey: 'env' }),
    status({ apiKey: 'settings' }),
    status({ apiKey: 'env', githubToken: 'gh' }),
    status({ apiKey: 'settings', githubToken: 'settings' }),
  ];
  for (const s of statuses) {
    for (const c of checks) {
      add(cloudPill(s, c).key, ...keyRow(s, c).sentence, githubRow(s, c).sentence);
    }
  }
  for (const on of [true, false]) {
    for (const changed of [true, false]) {
      for (const cli of [null, { version: '0.149.0', ok: false }, { version: '0.167.1', ok: true }]) {
        const v = steerView(on, cli, changed);
        add(v.pill.key, ...v.lines.map((l) => l.key));
      }
      const c = controlView(on, changed);
      add(c.pill.key, ...c.lines.map((l) => l.key));
    }
  }
  for (const source of [null, 'env', 'settings'] as const) {
    for (const draft of ['', 'x']) {
      add(keyFieldLine({ source, draft, checking: false, verdict: null, note: null }).line.key);
    }
    add(keyFieldLine({ source, draft: '', checking: true, verdict: null, note: null }).line.key);
    add(keyFieldLine({ source, draft: '', checking: false, verdict: null, note: 'lastFailed' }).line.key);
    for (const kind of ['spaces', 'link', 'github'] as const) {
      add(keyFieldLine({ source, draft: 'x', checking: false, verdict: { kind }, note: null }).line.key);
    }
    for (const kind of ['rejected', 'forbidden', 'workspace', 'unchecked'] as const) {
      add(keyFieldLine({ source, draft: 'x', checking: false, verdict: { kind, error: '' }, note: null }).line.key);
    }
    add(keyNoteLine('notChanged', source)?.key);
  }
  for (const source of [null, 'gh', 'settings'] as const) {
    add(tokenCloseKey(source));
    for (const draft of ['', 'x']) add(tokenFieldLine({ source, draft, problem: null }).line.key);
    for (const problem of ['spaces', 'link', 'anthropic', 'format'] as const) {
      add(tokenFieldLine({ source, draft: 'x', problem }).line.key);
    }
    for (const note of ['savedNow', 'stillNone', 'notChanged', 'lastFailed'] as const) add(githubNoteLine(note, source)?.key);
  }
  for (const fieldOpen of [true, false]) {
    for (const verdict of [null, 'ok', 'fail'] as const) {
      for (const draft of ['', 'x']) {
        add(workspaceLine({ fieldOpen, draft, busy: false, verdict, note: null })?.key);
        add(workspaceLine({ fieldOpen, draft, busy: true, verdict, note: 'notChanged' })?.key);
        add(workspaceLine({ fieldOpen, draft, busy: false, verdict, note: 'notChanged' })?.key);
      }
    }
  }
  add(effortOptionKey('ultracode'), effortOptionKey('ultra'));

  it('are all in the English catalog', () => {
    const catalog = en as Record<string, string>;
    expect([...keys].filter((key) => typeof catalog[key] !== 'string')).toEqual([]);
    expect(keys.size).toBeGreaterThan(60);
  });

  it('keep the copy rules: no jargon, no Save / OK / Cancel, and "Managed Agents" only where an admin must act', () => {
    const catalog = en as Record<string, string>;
    const pane = Object.keys(catalog).filter((key) =>
      key.startsWith('prefs.agents.') && !key.startsWith('prefs.agents.accountsLink.'));
    const said = (pattern: RegExp): string[] => pane.filter((key) => pattern.test(catalog[key]));
    expect(said(/app-server|exec SDK|\bMCP\b|sandbox|\bsessions?\b/i)).toEqual([]);
    // "turn" only as a verb (turn on, turn it off), never Codex's noun.
    expect(said(/\bturns\b|mid-turn|\b(the|a|each|its|next|this) turn\b/i)).toEqual([]);
    expect(said(/\b(macOS|Windows|Linux|Finder|Keychain)\b/)).toEqual([]);
    expect(said(/^(Save|OK|Okay|Cancel)$/)).toEqual([]);
    expect(said(/Managed Agents/).sort()).toEqual([
      'prefs.agents.cloud.key.draft.forbidden',
      'prefs.agents.cloud.key.inUse.forbidden',
    ]);
    // "Experimental" is a word in the steering description, never a pill.
    expect(said(/experimental/i)).toEqual(['prefs.agents.steer.desc']);
    // No switch says it "applies at once": the timing lines say what is true.
    expect(said(/at once|immediately|as soon as you/i)).toEqual([]);
  });

  it('label a control "Keep …" only for what is in use now', () => {
    const catalog = en as Record<string, string>;
    const keeps = Object.keys(catalog)
      .filter((key) => key.startsWith('prefs.agents.cloud.') && /^Keep\b/.test(catalog[key]))
      .sort();
    expect(keeps).toEqual([
      'prefs.agents.cloud.github.keep',
      'prefs.agents.cloud.github.keepGh',
      'prefs.agents.cloud.github.remove.cancel',
      'prefs.agents.cloud.key.keep',
      'prefs.agents.cloud.key.remove.cancel',
      'prefs.agents.cloud.ws.keep',
      'prefs.agents.cloud.ws.remove.cancel',
    ]);
    // A new secret is checked, saved, used or switched to — never "kept".
    for (const key of ['prefs.agents.cloud.key.check', 'prefs.agents.cloud.github.use', 'prefs.agents.cloud.key.dirty', 'prefs.agents.cloud.github.dirty']) {
      expect(catalog[key]).not.toMatch(/\bkeep/i);
    }
  });
});

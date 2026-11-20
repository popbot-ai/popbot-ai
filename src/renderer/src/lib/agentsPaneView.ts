/**
 * Every decision the Agents preferences pane makes (PrefsAgents and its
 * sections in PreferencesSheet.tsx), kept apart from React so it can be
 * unit-tested: the repo has no component-test harness. Pure — no
 * `window`, no clock of its own; the caller passes `now`. What comes back
 * is message keys and class names, never text: the pane runs them
 * through `t()`.
 */
import type { MessageKey } from '@shared/i18n';
import type { ClaudeAccountsState, CloudStatus } from '@shared/ipc';
import {
  CLAUDE_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
  type ClaudeReasoningEffort,
  type CloudSettings,
  type CodexReasoningEffort,
} from '@shared/persistence';
import { agentsSummary, needsAttention } from './claudeAccountsView';

// ── The one status vocabulary ────────────────────────────────────────

/** The pill classes, shared with the Claude accounts section and
 *  Integrations: done working, wait needs attention, err broken, muted
 *  off, not set up, or informational. */
export type Tone = 'done' | 'wait' | 'err' | 'muted';

export const ICON = {
  done: 'fa-solid fa-circle-check',
  wait: 'fa-solid fa-triangle-exclamation',
  err: 'fa-solid fa-circle-xmark',
  /** A muted pill for something not set up yet. */
  notSetUp: 'fa-regular fa-circle',
  checking: 'fa-solid fa-spinner fa-spin',
  hint: 'fa-solid fa-circle-info',
  timing: 'fa-regular fa-clock',
} as const;

/** A feature's state, shown directly after its name. Always words; an
 *  icon only where the vocabulary has one (On and Off are words only). */
export interface Pill {
  tone: Tone;
  icon: string | null;
  key: MessageKey;
  vars?: Record<string, string | number>;
}

/**
 * How a state line reads: a hint, when a change takes effect, a check in
 * flight, or a verdict. The tone picks its icon and its colour, so a
 * line is never told apart by colour alone.
 */
export type LineTone = 'hint' | 'timing' | 'busy' | 'ok' | 'warn' | 'error';

export interface StateLine {
  tone: LineTone;
  key: MessageKey;
  vars?: Record<string, string | number>;
}

export function lineIcon(tone: LineTone): string {
  switch (tone) {
    case 'timing': return ICON.timing;
    case 'busy': return ICON.checking;
    case 'ok': return ICON.done;
    case 'warn': return ICON.wait;
    case 'error': return ICON.err;
    default: return ICON.hint;
  }
}

/** The `.pref-state` modifier for a tone ('' for the plain grey line). */
export function lineClass(tone: LineTone): '' | 'ok' | 'warn' | 'error' {
  return tone === 'ok' || tone === 'warn' || tone === 'error' ? tone : '';
}

// ── Claude accounts pointer ──────────────────────────────────────────

/** A name short enough for a pill; the sentence under it carries it whole. */
export function clipName(label: string, max = 24): string {
  return label.length > max ? `${label.slice(0, max).trimEnd()}…` : label;
}

export interface AccountsPointerView {
  tone: Tone;
  icon: string;
  pill: MessageKey;
  /** What the pill is translated with: the name, clipped. */
  pillVars: { name?: string };
  line: MessageKey;
  /** What the sentence is translated with: the name in full. */
  vars: { name?: string; count?: number };
  /** Something is wrong with the account chats run on: the button that
   *  opens the Claude accounts section becomes the main one. */
  attention: boolean;
}

/**
 * The pointer's pill and sentence (first match wins, top to bottom).
 * Null until the accounts are known: the pointer then shows its name and
 * button only, so it never claims "no account" before it has an answer.
 */
export function accountsPointer(state: ClaudeAccountsState | null, now: number): AccountsPointerView | null {
  if (!state) return null;
  const muted = (pill: MessageKey, line: MessageKey): AccountsPointerView =>
    ({ tone: 'muted', icon: ICON.notSetUp, pill, pillVars: {}, line, vars: {}, attention: false });
  const summary = agentsSummary(state);
  if (summary.key === 'none') {
    return state.encryptionAvailable
      ? muted('prefs.agents.accounts.pill.none', 'prefs.agents.accounts.line.none')
      : muted('prefs.agents.accounts.pill.off', 'prefs.agents.accounts.line.noStore');
  }
  const active = state.accounts.find((a) => a.active);
  if (summary.key === 'off' || !active) {
    return muted('prefs.agents.accounts.pill.off', 'prefs.agents.accounts.line.off');
  }
  const name = active.label;
  const attention = (line: MessageKey, named = true): AccountsPointerView => ({
    tone: 'wait',
    icon: ICON.wait,
    pill: 'prefs.agents.accounts.pill.attention',
    pillVars: {},
    line,
    vars: named ? { name } : {},
    attention: true,
  });
  if (active.unreadable) return attention('prefs.agents.accounts.line.unreadable');
  if (needsAttention(state, now)) {
    if (active.needsSignIn) return attention('prefs.agents.accounts.line.refused');
    // The accounts a chat could run on, as needsAttention counts them: one
    // whose sign-in can't be read is not among them. Without this an
    // unreadable spare beside accounts that are all out of usage would
    // fall through to "expired", which would not be true.
    const usable = state.accounts.filter((a) => !a.unreadable);
    if (usable.every((a) => a.outOfUsageUntil != null && a.outOfUsageUntil > now)) {
      return usable.length === 1
        ? attention('prefs.agents.accounts.line.oneOut')
        : attention('prefs.agents.accounts.line.allOut', false);
    }
    // needsAttention has only three causes; the two above are ruled out.
    return attention('prefs.agents.accounts.line.expired');
  }
  return {
    tone: 'done',
    icon: ICON.done,
    pill: 'prefs.agents.accounts.pill.running',
    pillVars: { name: clipName(name) },
    line: summary.key === 'runningOne' ? 'prefs.agents.accounts.line.one' : 'prefs.agents.accounts.line.many',
    vars: summary.key === 'runningOne' ? { name } : { name, count: state.accounts.length },
    attention: false,
  };
}

// ── Default effort ───────────────────────────────────────────────────

/** The Claude levels the default-effort pickers offer. */
export const CLAUDE_EFFORT_CHOICES: readonly ClaudeReasoningEffort[] = CLAUDE_REASONING_EFFORTS;

/** The Codex levels they offer. No None: no Codex model accepts it
 *  (codexReasoningEffortsForModel starts every model at Low). */
export const CODEX_EFFORT_CHOICES: readonly CodexReasoningEffort[] =
  CODEX_REASONING_EFFORTS.filter((effort) => effort !== 'none');

/** What a Codex picker shows for a saved level: a saved None reads as
 *  Low, which is what a chat gets. Nothing is rewritten until a pick. */
export function shownCodexEffort(saved: CodexReasoningEffort): CodexReasoningEffort {
  return saved === 'none' ? 'low' : saved;
}

/**
 * The option text of the two levels that also hand work to helper
 * agents: their cost is in the list, read before the pick. Null for the
 * rest, which keep the short labels the in-chat pickers use.
 */
export function effortOptionKey(effort: ClaudeReasoningEffort | CodexReasoningEffort): MessageKey | null {
  if (effort === 'ultracode') return 'prefs.agents.effort.option.ultracode';
  if (effort === 'ultra') return 'prefs.agents.effort.option.ultra';
  return null;
}

// ── The two switches ─────────────────────────────────────────────────

/** A switch's pill and the lines under its description. */
export interface SwitchView {
  pill: Pill;
  lines: StateLine[];
}

const PILL_ON: Pill = { tone: 'done', icon: null, key: 'prefs.agents.switch.on' };
const PILL_OFF: Pill = { tone: 'muted', icon: null, key: 'prefs.agents.switch.off' };

/**
 * The Codex CLI installed on this computer, from `backendsStatus().codex`
 * (`version` is the raw `codex --version` text). Null when none is
 * installed, the text can't be parsed, or the probe has not answered:
 * PopBot then runs the Codex that ships with it, whose version the pane
 * can't read, so it makes no claim either way.
 */
export function codexCli(s: { ok: boolean; version?: string } | null | undefined): { version: string; ok: boolean } | null {
  const m = s?.ok && s.version ? /(\d+)\.(\d+)\.(\d+)/.exec(s.version) : null;
  return m ? { version: m[0], ok: Number(m[1]) > 0 || Number(m[2]) >= 153 } : null;
}

/**
 * "Steer Codex while it works". The only "cannot work here" the pane can
 * truthfully show is an installed CLI older than 0.153; a met
 * requirement is not shown. `changed` is true once the switch has been
 * flipped on this visit: the timing line then stays until the pane closes.
 * While a Codex account is in use (`forced`) none of that applies: the
 * switch decides nothing.
 */
export function steerView(
  on: boolean,
  cli: { version: string; ok: boolean } | null,
  changed: boolean,
  /** A Codex account is in use (codexAccountsView.ts): Codex chats then
   *  run through the app server whatever the switch says, so the pane
   *  shows it on, says why, and does not offer the switch. */
  forced = false,
): SwitchView {
  const tooOld = cli !== null && !cli.ok;
  if (forced) {
    const why: StateLine = { tone: 'hint', key: 'prefs.agents.steer.forced' };
    return tooOld
      ? {
        pill: { tone: 'wait', icon: ICON.wait, key: 'prefs.agents.steer.pill.tooOld' },
        lines: [{ tone: 'warn', key: 'prefs.agents.steer.req.oldForced', vars: { version: cli.version } }, why],
      }
      : { pill: { tone: 'done', icon: null, key: 'prefs.agents.steer.pill.forced' }, lines: [why] };
  }
  const lines: StateLine[] = [];
  if (tooOld) {
    lines.push({
      tone: 'warn',
      key: on ? 'prefs.agents.steer.req.oldOn' : 'prefs.agents.steer.req.oldOff',
      vars: { version: cli.version },
    });
  }
  if (changed) lines.push({ tone: 'timing', key: 'prefs.agents.steer.timing' });
  let pill = PILL_OFF;
  if (on) pill = tooOld ? { tone: 'wait', icon: ICON.wait, key: 'prefs.agents.steer.pill.tooOld' } : PILL_ON;
  return { pill, lines };
}

/**
 * "Let agents control PopBot". Off always says what Off does to an agent
 * that is already running (it keeps the tools until its chat restarts);
 * just switched on says when open chats get it; otherwise a prompt to
 * try. There is no amber state: the pane can't learn that the tools
 * failed to start.
 */
export function controlView(on: boolean, changed: boolean): SwitchView {
  if (!on) return { pill: PILL_OFF, lines: [{ tone: 'timing', key: 'prefs.agents.control.off' }] };
  return {
    pill: PILL_ON,
    lines: [changed
      ? { tone: 'timing', key: 'prefs.agents.control.changedOn' }
      : { tone: 'hint', key: 'prefs.agents.control.try' }],
  };
}

// ── Cloud chats: what was typed ──────────────────────────────────────

export type KeyErrorKind = 'rejected' | 'forbidden' | 'workspace' | 'unchecked';

/**
 * What a failed key check means, from the text main gives. The two fixed
 * prefixes come from describeApiError in main/agents/managedAgentsClient.ts.
 * Network errors and anything unrecognised are "could not check": amber,
 * never "Key not working".
 */
export function keyErrorKind(error: string): KeyErrorKind {
  if (error.startsWith('the API key was rejected')) return 'rejected';
  if (/workspace/i.test(error)) return 'workspace';
  if (error.startsWith('the API key is not allowed')) return 'forbidden';
  return 'unchecked';
}

/** Why text can't be an API key, before any network call. Only what is
 *  plainly wrong; Anthropic's answer is the real check. */
export function apiKeyProblem(text: string): null | 'spaces' | 'link' | 'github' {
  if (/\s/.test(text)) return 'spaces';
  if (/^https?:\/\//i.test(text)) return 'link';
  if (/^(gh[pousr]_|github_pat_)/.test(text)) return 'github';
  return null;
}

/** Why text can't be a GitHub token. There is no call that tests one,
 *  so what does not look like one is refused and the rest is saved. */
export function githubTokenProblem(text: string): null | 'spaces' | 'link' | 'anthropic' | 'format' {
  if (/\s/.test(text)) return 'spaces';
  if (/^https?:\/\//i.test(text)) return 'link';
  if (text.startsWith('sk-ant-')) return 'anthropic';
  if (
    /^gh[pousr]_[A-Za-z0-9]{20,}$/.test(text)
    || /^github_pat_[A-Za-z0-9_]{20,}$/.test(text)
    || /^[0-9a-f]{40}$/.test(text)
  ) return null;
  return 'format';
}

// ── Cloud chats: the key in use, the heading pill, the two rows ──────

/** The check of the key cloud chats run on now, on this visit. */
export type KeyCheck =
  | { state: 'checking' }
  | { state: 'ok' }
  | { state: 'failed'; kind: KeyErrorKind; error: string };

export function failedCheck(error: string): KeyCheck {
  return { state: 'failed', kind: keyErrorKind(error), error };
}

/** The key in use passed its check on this visit. Nothing less is "works". */
export function keyWorks(status: CloudStatus | null, check: KeyCheck | null): boolean {
  return status !== null && status.apiKey !== null && check?.state === 'ok';
}

/**
 * The Cloud chats heading pill (first match wins). Ready means the key
 * in use passed its check on this visit, saved or from the environment;
 * a key that has not been checked yet reads as Checking, never Ready.
 * It makes no claim about a pasted GitHub token: that row says so itself.
 */
export function cloudPill(status: CloudStatus | null, check: KeyCheck | null): { tone: Tone; icon: string; key: MessageKey } {
  const checking = { tone: 'muted' as const, icon: ICON.checking, key: 'prefs.agents.cloud.pill.checking' as const };
  if (!status) return checking;
  if (status.apiKey === null) return { tone: 'muted', icon: ICON.notSetUp, key: 'prefs.agents.cloud.pill.notSetUp' };
  if (!check || check.state === 'checking') return checking;
  if (check.state === 'failed') {
    return check.kind === 'unchecked'
      ? { tone: 'wait', icon: ICON.wait, key: 'prefs.agents.cloud.pill.keyUnchecked' }
      : { tone: 'err', icon: ICON.err, key: 'prefs.agents.cloud.pill.keyBroken' };
  }
  if (status.githubToken === null) return { tone: 'wait', icon: ICON.wait, key: 'prefs.agents.cloud.pill.noGithub' };
  return { tone: 'done', icon: ICON.done, key: 'prefs.agents.cloud.pill.ready' };
}

/**
 * The mark left of a requirement — a step's state, where a pill is a
 * feature's state:
 *   next / later  a number: still to do, and whether it is the next step
 *   ok            PopBot verified it on this visit
 *   set           saved, but PopBot cannot test it (a pasted GitHub token)
 *   checking      being checked or looked for
 *   warn          could not be checked
 *   error         checked and not working
 */
export type MarkKind = 'next' | 'later' | 'ok' | 'set' | 'checking' | 'warn' | 'error';

/** The mark's class after `setup-mark`, and its icon (none for a number). */
export function markView(kind: MarkKind): { cls: string; icon: string | null } {
  switch (kind) {
    case 'next': return { cls: 'num next', icon: null };
    case 'later': return { cls: 'num', icon: null };
    case 'ok': return { cls: 'ok', icon: ICON.done };
    case 'set': return { cls: 'set', icon: 'fa-solid fa-check' };
    case 'warn': return { cls: 'warn', icon: ICON.wait };
    case 'error': return { cls: 'error', icon: ICON.err };
    default: return { cls: '', icon: ICON.checking };
  }
}

/** How a secret typed into a row is applied: a first one may apply when
 *  its row is left; one that replaces something in use only on Enter or
 *  its button. */
export type SecretMode = 'first' | 'replace';

export function secretMode(source: string | null): SecretMode {
  return source === null ? 'first' : 'replace';
}

export type KeyAction = 'getKey' | 'checkAgain' | 'useOther' | 'replace' | 'remove';

export interface KeyRowView {
  mark: MarkKind;
  /** The state sentence: these keys, read one after another. */
  sentence: MessageKey[];
  /** What Anthropic itself said, shown dim under the sentence. */
  detail: string | null;
  /** The buttons at the row's right edge while no field is open. */
  actions: KeyAction[];
  /** Null until the status is known: no field can open yet. */
  mode: SecretMode | null;
}

/**
 * The Anthropic API key row at rest. `rechecking` is true while a check
 * the user asked for with "Check again" runs: its buttons stay, so focus
 * is not dropped. The first check of a visit shows none.
 */
export function keyRow(status: CloudStatus | null, check: KeyCheck | null, rechecking = false): KeyRowView {
  if (!status) return { mark: 'checking', sentence: [], detail: null, actions: [], mode: null };
  if (status.apiKey === null) {
    return { mark: 'next', sentence: ['prefs.agents.cloud.key.none'], detail: null, actions: ['getKey'], mode: 'first' };
  }
  const env = status.apiKey === 'env';
  const lead: MessageKey = env ? 'prefs.agents.cloud.envKey' : 'prefs.agents.cloud.key.saved';
  const own: KeyAction[] = env ? ['useOther'] : ['replace', 'remove'];
  if (!check || check.state === 'checking') {
    return {
      mark: 'checking',
      sentence: [lead, 'prefs.agents.cloud.key.checking'],
      detail: null,
      actions: rechecking ? ['checkAgain', ...own] : [],
      mode: 'replace',
    };
  }
  if (check.state === 'ok') {
    return { mark: 'ok', sentence: [lead, 'prefs.agents.cloud.ok'], detail: null, actions: own, mode: 'replace' };
  }
  const said: Record<KeyErrorKind, MessageKey> = {
    rejected: 'prefs.agents.cloud.key.inUse.rejected',
    forbidden: 'prefs.agents.cloud.key.inUse.forbidden',
    workspace: 'prefs.agents.cloud.key.inUse.workspace',
    unchecked: 'prefs.agents.cloud.key.inUse.unchecked',
  };
  return {
    mark: check.kind === 'unchecked' ? 'warn' : 'error',
    sentence: [
      lead,
      said[check.kind],
      // A rejected variable can only be fixed outside PopBot, or overridden here.
      ...(env && check.kind === 'rejected' ? ['prefs.agents.cloud.key.envFix' as const] : []),
    ],
    detail: check.error || null,
    actions: ['checkAgain', ...own],
    mode: 'replace',
  };
}

export type GithubAction = 'lookAgain' | 'paste' | 'useToken' | 'replace' | 'remove';

export interface GithubRowView {
  mark: MarkKind;
  sentence: MessageKey | null;
  /** The buttons at the row's right edge while no field is open. */
  actions: GithubAction[];
  /** Null while a token can't be entered here yet (the key comes first). */
  mode: SecretMode | null;
  /** Show the `gh auth login` hint: the easiest way to get access. */
  howTo: boolean;
}

/**
 * The GitHub access row at rest. A sign-in `gh` reports is verified
 * (green tick); a pasted token is only saved (grey mark), because there
 * is no call that tests one. Not found, it is step 2: offered once the
 * key works, and only named until then.
 */
export function githubRow(status: CloudStatus | null, check: KeyCheck | null): GithubRowView {
  if (!status) return { mark: 'checking', sentence: null, actions: [], mode: null, howTo: false };
  if (status.githubToken === 'gh') {
    return { mark: 'ok', sentence: 'prefs.agents.cloud.github.gh', actions: ['useToken'], mode: 'replace', howTo: false };
  }
  if (status.githubToken === 'settings') {
    return { mark: 'set', sentence: 'prefs.agents.cloud.github.saved', actions: ['replace', 'remove'], mode: 'replace', howTo: false };
  }
  if (!keyWorks(status, check)) {
    return { mark: 'later', sentence: 'prefs.agents.cloud.github.later', actions: [], mode: null, howTo: false };
  }
  return { mark: 'next', sentence: 'prefs.agents.cloud.github.none', actions: ['lookAgain', 'paste'], mode: 'first', howTo: true };
}

/** The button that closes an open token field without using its text:
 *  "keep" names what stays in use, and there is nothing to keep yet when
 *  the token is a first one. */
export function tokenCloseKey(source: CloudStatus['githubToken']): MessageKey {
  if (source === 'settings') return 'prefs.agents.cloud.github.keep';
  if (source === 'gh') return 'prefs.agents.cloud.github.keepGh';
  return 'prefs.agents.cloud.github.notNow';
}

/**
 * The card's footer: none until the key works (the row carries the next
 * step), then how to start a cloud chat — and, without GitHub access,
 * what works already.
 */
export function cloudFooter(status: CloudStatus | null, check: KeyCheck | null): null | 'ready' | 'noGithub' {
  if (!keyWorks(status, check)) return null;
  return status?.githubToken === null ? 'noGithub' : 'ready';
}

// ── Cloud chats: the fields ──────────────────────────────────────────

/**
 * What happens to a field's text when focus moves to something else in
 * PopBot outside its row, or Preferences closes over it. A first secret
 * is applied (only a key that passes its check, or a token that looks
 * like one, is saved, and an empty field changes nothing); a replacement
 * is discarded, so what is in use never changes by surprise. Nothing
 * happens while a check is already running.
 */
export function leaveOutcome(mode: SecretMode, draft: string, busy: boolean): 'apply' | 'discard' | 'nothing' {
  if (busy) return 'nothing';
  if (mode === 'replace') return 'discard';
  return draft.trim() ? 'apply' : 'nothing';
}

/** Why a typed key was not saved: refused here, or by its check. */
export type KeyDraftVerdict =
  | { kind: 'spaces' | 'link' | 'github' }
  | { kind: KeyErrorKind; error: string };

/** What a row says once its field has closed, or on the next visit. */
export type FieldNote = 'notChanged' | 'lastFailed';

export interface FieldLineView {
  /** The one line under the field (its slot never holds two). */
  line: StateLine;
  /** Read after it when a key is in use: the failure changed nothing. */
  stillInUse: boolean;
  /** What Anthropic itself said, shown dim under the line. */
  detail: string | null;
  /** The line is red: the field is marked invalid. */
  invalid: boolean;
}

/**
 * The line directly under the API key field. One slot, in this order:
 * checking, then the verdict on what was typed, then "not applied yet"
 * while there is text, then a verdict left from before Preferences
 * closed, then the hint.
 */
export function keyFieldLine(o: {
  source: CloudStatus['apiKey'];
  draft: string;
  checking: boolean;
  verdict: KeyDraftVerdict | null;
  note: FieldNote | null;
}): FieldLineView {
  const mode = secretMode(o.source);
  const plain = (line: StateLine): FieldLineView => ({ line, stillInUse: false, detail: null, invalid: false });
  if (o.checking) return plain({ tone: 'busy', key: 'prefs.agents.cloud.key.checking' });
  if (o.verdict) {
    return {
      line: { tone: 'error', key: `prefs.agents.cloud.key.draft.${o.verdict.kind}` },
      stillInUse: mode === 'replace',
      detail: 'error' in o.verdict && o.verdict.error ? o.verdict.error : null,
      invalid: true,
    };
  }
  if (o.draft.trim()) {
    return plain({
      tone: 'hint',
      key: mode === 'replace' ? 'prefs.agents.cloud.key.dirtyReplace' : 'prefs.agents.cloud.key.dirty',
    });
  }
  if (o.note === 'lastFailed') return plain({ tone: 'warn', key: 'prefs.agents.cloud.key.lastFailed' });
  if (o.source === 'settings') return plain({ tone: 'hint', key: 'prefs.agents.cloud.key.hint.replaceSaved' });
  if (o.source === 'env') return plain({ tone: 'hint', key: 'prefs.agents.cloud.key.hint.replaceEnv' });
  return plain({ tone: 'hint', key: 'prefs.agents.cloud.key.hint.first' });
}

export type TokenProblem = 'spaces' | 'link' | 'anthropic' | 'format';

/** The line directly under the GitHub token field: the refusal, then
 *  "not applied yet" while there is text, then the hint. */
export function tokenFieldLine(o: {
  source: CloudStatus['githubToken'];
  draft: string;
  problem: TokenProblem | null;
}): { line: StateLine; invalid: boolean } {
  const mode = secretMode(o.source);
  if (o.problem) {
    return { line: { tone: 'error', key: `prefs.agents.cloud.github.draft.${o.problem}` }, invalid: true };
  }
  if (o.draft.trim()) {
    return {
      line: {
        tone: 'hint',
        key: mode === 'replace' ? 'prefs.agents.cloud.github.dirtyReplace' : 'prefs.agents.cloud.github.dirty',
      },
      invalid: false,
    };
  }
  let hint: MessageKey = 'prefs.agents.cloud.github.hint';
  if (o.source === 'gh') hint = 'prefs.agents.cloud.github.hint.overrideGh';
  else if (o.source === 'settings') hint = 'prefs.agents.cloud.github.hint.replace';
  return { line: { tone: 'hint', key: hint }, invalid: false };
}

/**
 * How the Workspace ID shows under the key. Never a standing field: a
 * saved ID is a sentence (it is not a secret) with Change and Remove;
 * the field opens by itself when a check says the key needs one; and
 * after a "not allowed" or "not checked" failure a link offers it as
 * the manual route. `editing` is true once the field has been opened.
 */
export function workspaceView(o: {
  savedId: string | undefined;
  editing: boolean;
  lastKind: KeyErrorKind | null;
}): 'none' | 'sentence' | 'field' | 'addLink' {
  if (o.editing) return 'field';
  if (o.savedId?.trim()) return 'sentence';
  if (o.lastKind === 'workspace') return 'field';
  if (o.lastKind === 'forbidden' || o.lastKind === 'unchecked') return 'addLink';
  return 'none';
}

/** The failure the Workspace ID row answers to: the last check of what
 *  was typed while a key is being entered, else the check of the key in use. */
export function lastKeyFailure(draftKind: KeyErrorKind | null, check: KeyCheck | null): KeyErrorKind | null {
  if (draftKind) return draftKind;
  return check?.state === 'failed' ? check.kind : null;
}

/**
 * The line that belongs to the Workspace ID. Under its open field:
 * checking, then the verdict, then "not applied yet", then where to find
 * one. With the field closed: that the key works with the ID just
 * saved, or that a change was let go.
 */
export function workspaceLine(o: {
  fieldOpen: boolean;
  draft: string;
  busy: boolean;
  verdict: 'ok' | 'fail' | null;
  note: 'notChanged' | null;
}): StateLine | null {
  if (o.fieldOpen) {
    if (o.busy) return { tone: 'busy', key: 'prefs.agents.cloud.key.checking' };
    if (o.verdict === 'fail') return { tone: 'error', key: 'prefs.agents.cloud.ws.fail' };
    if (o.draft.trim()) return { tone: 'hint', key: 'prefs.agents.cloud.ws.dirty' };
    return { tone: 'hint', key: 'prefs.agents.cloud.ws.help' };
  }
  if (o.verdict === 'ok') return { tone: 'ok', key: 'prefs.agents.cloud.ws.ok' };
  if (o.note === 'notChanged') return { tone: 'hint', key: 'prefs.agents.cloud.ws.notChanged' };
  return null;
}

/** What the key row says under its state sentence while its field is
 *  closed: only that a replacement was let go, and only while there is
 *  still a key for that to be true of. */
export function keyNoteLine(note: FieldNote | null, source: CloudStatus['apiKey']): StateLine | null {
  return note === 'notChanged' && source !== null
    ? { tone: 'hint', key: 'prefs.agents.cloud.key.notChanged' }
    : null;
}

/** What the GitHub row has to add once its field has closed. */
export type GithubNote = FieldNote | 'savedNow' | 'stillNone';

/** The line under the GitHub row's state sentence while its field is
 *  closed. A note is dropped once the row's state has moved past it (a
 *  sign-in found after "still not found", say). */
export function githubNoteLine(note: GithubNote | null, source: CloudStatus['githubToken']): StateLine | null {
  switch (note) {
    case 'savedNow':
      return source === 'settings' ? { tone: 'hint', key: 'prefs.agents.cloud.github.savedNow' } : null;
    case 'stillNone':
      return source === null ? { tone: 'warn', key: 'prefs.agents.cloud.github.stillNone' } : null;
    case 'notChanged':
      return source !== null ? { tone: 'hint', key: 'prefs.agents.cloud.github.notChanged' } : null;
    case 'lastFailed':
      return source !== 'settings' ? { tone: 'warn', key: 'prefs.agents.cloud.github.lastFailed' } : null;
    default:
      return null;
  }
}

// ── Cloud chats: what is saved ───────────────────────────────────────
//
// Each save merges onto what is stored, so a field this pane does not
// touch (and one a later version adds) survives it.

/** The settings once a key has passed its check, with the Workspace ID
 *  it was checked with when one was typed. */
export function withApiKey(saved: CloudSettings, apiKey: string, workspaceId?: string): CloudSettings {
  return { ...saved, apiKey, ...(workspaceId ? { workspaceId } : {}) };
}

export function withGithubToken(saved: CloudSettings, githubToken: string): CloudSettings {
  return { ...saved, githubToken };
}

export function withWorkspaceId(saved: CloudSettings, workspaceId: string): CloudSettings {
  return { ...saved, workspaceId };
}

/** The settings with one field removed, and only that one. */
export function withoutField(saved: CloudSettings, field: keyof CloudSettings): CloudSettings {
  const next: CloudSettings = { ...saved };
  delete next[field];
  return next;
}

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ClaudeAccountInfo,
  ClaudeAccountsFailure,
  ClaudeAccountsResult,
  ClaudeAccountsState,
  ClaudeSignInEvent,
} from '@shared/ipc';
import type { MessageKey, TranslationParams } from '@shared/i18n';
import { useTranslation } from '../lib/i18n';
import { ConfirmDialog } from './ConfirmDialog';
import {
  SIGN_IN_IDLE,
  SIGN_IN_LIFETIME_MS,
  accountNamed,
  alertKind,
  cardView,
  checkFailure,
  SETUP_TOKEN_LENGTH,
  addedVerdict,
  cleanToken,
  codeLooks,
  inUse,
  leadKind,
  marker,
  nameProblem,
  needsAttention,
  newAccountIn,
  removeView,
  signInReducer,
  splitMarked,
  tokenCutOff,
  tokenLooks,
  tookOver,
  whenKind,
  type CardView,
  type SignInAction,
  type SignInState,
} from '../lib/claudeAccountsView';

/**
 * The accounts as main reports them, kept current while mounted: one
 * `list()` and then every push. Null until the first answer, so a caller
 * can tell "not known yet" from "no accounts".
 */
export function useClaudeAccountsState(): ClaudeAccountsState | null {
  const [state, setState] = useState<ClaudeAccountsState | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.popbot.claudeAccounts.list().then((s) => { if (!cancelled) setState(s); }).catch(() => {});
    const off = window.popbot.claudeAccounts.onChanged((s) => setState(s));
    return () => { cancelled = true; off(); };
  }, []);
  return state;
}

/** How often the pane re-reads the clock: an out-of-usage time that has
 *  passed counts as cleared, with nobody pressing anything. */
export const TICK_MS = 30_000;

/** The current time, re-read every 30 s while mounted. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Whether the Preferences nav item shows its attention mark. */
export function useClaudeAccountsAttention(): boolean {
  return needsAttention(useClaudeAccountsState(), useNow());
}

// ── The pane ─────────────────────────────────────────────────────────

export type Translate = (key: MessageKey, params?: TranslationParams) => string;

/** The command that prints a sign-in token: what `{command}` stands for. */
const SETUP_COMMAND = 'claude setup-token';
/** How long a link must stand unchanged before it is taken as whole when
 *  Claude's prompt for the code was not seen (it can first arrive cut short). */
const LINK_SETTLE_MS = 3_000;
/** After this long a check no longer "takes a few seconds". */
const SLOW_CHECK_MS = 20_000;
const COPIED_MS = 2_000;
/** Where a verdict goes that belongs to no card (the foot row). */
export const FOOT = '@foot';

/** The one thing open in the pane besides the cards, if any. */
type Flow =
  | null
  /** Browser sign-in for a new account (SignInSteps, first or another). */
  | { kind: 'add' }
  | { kind: 'add-token'; prefill?: string; note?: 'was-code' | 'no-token' }
  /** Browser sign-in to replace this account's sign-in. */
  | { kind: 'renew'; id: string }
  | { kind: 'token'; id: string; prefill?: string; note?: 'was-code' | 'no-token' };

type Busy = null | { kind: 'switch' | 'remove' | 'rename' | 'stop'; id?: string };

export interface Verdict {
  /** The account whose card carries it, or FOOT. */
  id: string;
  tone: 'ok' | 'error';
  text: string;
}

/** What an accounts request came to, without the state it also carried. */
type Outcome =
  | { ok: true; accounts: ClaudeAccountInfo[] }
  | { ok: false; reason: ClaudeAccountsFailure; error: string };

/** Counts sign-in starts across every pane there has been, so a late
 *  answer can tell whether a newer sign-in has replaced its own. */
let lastSignInStart = 0;

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A translated sentence with elements in it: the placeholders named in
 * `marks` are translated as markers and then replaced by their elements,
 * so an account name can be bold and the command can be code wherever
 * the language puts them.
 */
export function rich(t: Translate, key: MessageKey, vars: TranslationParams, marks: Record<string, ReactNode>): ReactNode {
  const params: TranslationParams = { ...vars };
  for (const name of Object.keys(marks)) params[name] = marker(name);
  // The pieces of one sentence never reorder, so their position is their key.
  return splitMarked(t(key, params)).map((piece, i) =>
    (typeof piece === 'string' ? piece : <Fragment key={i}>{marks[piece.mark]}</Fragment>));
}

const COMMAND_MARK = { command: <code>{SETUP_COMMAND}</code> };

/** Dates, times and lists in the user's language. */
export function useFormats(): {
  /** "Nov 16, 2026" */
  saved: (ts: number) => string;
  /** "Dec 2" */
  day: (ts: number) => string;
  /** "until 1:51 PM" / "until tomorrow at 9:00 AM" / "until Nov 21 at 9:00 AM"
   *  (or "at …" / "tomorrow at …" / "on … at …"). Never seconds. */
  when: (prefix: 'until' | 'when', ts: number, now: number) => string;
  /** "Work or Personal" */
  or: (names: string[]) => string;
} {
  const { t, locale } = useTranslation();
  return useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    const saved = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    const or = new Intl.ListFormat(locale, { type: 'disjunction' });
    return {
      saved: (ts) => saved.format(ts),
      day: (ts) => day.format(ts),
      when: (prefix, ts, now) =>
        t(`prefs.accounts.${prefix}.${whenKind(ts, now)}`, { time: time.format(ts), date: day.format(ts) }),
      or: (names) => or.format(names),
    };
  }, [t, locale]);
}

/** Copy text; `copied` reads true for two seconds after it worked. */
export function useCopied(): [boolean, (text: string) => Promise<boolean>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    return true;
  }, []);
  return [copied, copy];
}

/** True once a check has run for 20 s: the wording then allows for the
 *  minute and a half it can take at worst. */
function useSlow(active: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_CHECK_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
  return slow && active;
}

/**
 * The sign-in state with a dispatch that hands back the state it made.
 * Main's events and the answers to requests arrive outside React's
 * render, and each has to act on what the one before it did (a token
 * that is ready starts a check): reading a ref, not a render's copy.
 */
function useSignIn(): [SignInState, (action: SignInAction) => SignInState, { current: SignInState }] {
  const [state, setState] = useState<SignInState>(SIGN_IN_IDLE);
  const ref = useRef<SignInState>(SIGN_IN_IDLE);
  const dispatch = useCallback((action: SignInAction): SignInState => {
    const next = signInReducer(ref.current, action);
    ref.current = next;
    setState(next);
    return next;
  }, []);
  return [state, dispatch, ref];
}

/** The two lines a failed check is told in: what happened, and what is
 *  still in place. Worded by the reason, never by the CLI's text. */
function failureLines(
  t: Translate,
  reason: ClaudeAccountsFailure,
  path: 'sign-in' | 'token',
  keeps: 'nothing' | 'old',
): { headline: string; kept: string } {
  const headline = path === 'token' && reason === 'refused'
    ? t('prefs.accounts.token.refused')
    : t(`prefs.accounts.${checkFailure(reason).headline}`);
  const kept = keeps === 'nothing'
    ? t('prefs.accounts.check.nothingSaved')
    : path === 'token' ? t('prefs.accounts.token.oldKept') : t('prefs.accounts.check.oldKept');
  return { headline, kept };
}

/** One line with its icon: a problem (red), a caution (amber) or work in
 *  progress. Never colour alone. */
export function Note({ tone, id, children }: { tone: 'error' | 'wait' | 'busy'; id?: string; children: ReactNode }): JSX.Element {
  const icon = tone === 'error' ? 'fa-circle-exclamation' : tone === 'wait' ? 'fa-triangle-exclamation' : 'fa-spinner fa-spin';
  return (
    <div className={`host-card-status${tone === 'busy' ? '' : ` ${tone}`}`} id={id}>
      <i className={`fa-solid ${icon}`} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** An amber caution inside a flow. */
export function Caution({ id, children }: { id?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="acct-warn" id={id}>
      <i className="fa-solid fa-triangle-exclamation" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/**
 * Whether focus may be moved into `root`: nothing holds it, or it is
 * already in there, or it rests on what `root` sits in (a click on a
 * card's own background leaves it on the card).
 */
export function focusIsFree(root: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  return !!root && (root.contains(active) || active.contains(root));
}

export function CloseButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="acct-icon" aria-label={label} title={label} onClick={onClick}>
      <i className="fa-solid fa-xmark" aria-hidden />
    </button>
  );
}

// ── The sign-in steps ────────────────────────────────────────────────

export function Step({ n, status, title, titleId, children }: {
  n: number;
  /** '' is a step that is neither done nor the current one, but has a body. */
  status: 'todo' | 'current' | 'done' | 'failed' | '';
  title: ReactNode;
  titleId?: string;
  children?: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <li className={`acct-step${status ? ` ${status}` : ''}`} aria-current={status === 'current' ? 'step' : undefined}>
      {/* The list itself counts the steps; the badge is its picture. */}
      <span className="acct-step-num" aria-hidden>
        {status === 'done' && <i className="fa-solid fa-circle-check" />}
        {status === 'failed' && <i className="fa-solid fa-circle-exclamation" />}
        {status !== 'done' && status !== 'failed' && n}
      </span>
      <span className="acct-step-title" id={titleId}>
        {title}
        {status === 'done' && <span className="acct-sr"> {t('prefs.accounts.step.done')}</span>}
      </span>
      {children && <div className="acct-step-body">{children}</div>}
    </li>
  );
}

interface SignInStepsProps {
  signIn: SignInState;
  /** Every account there is: whom the browser may still be signed in as,
   *  and the names already taken. */
  accounts: ClaudeAccountInfo[];
  /** The account whose sign-in is being replaced (mode `renew`). */
  account?: ClaudeAccountInfo;
  onStart: () => void;
  /** A fresh sign-in within this flow: a new code, a new start. */
  onRestart: () => void;
  onClose: () => void;
  /** Leave for the token form — with the token, when one was pasted
   *  where the code goes. */
  onHaveToken: (pasted?: string) => void;
  onPageOpened: () => void;
  onLinkCopied: () => void;
  /** Save the signed-in account under this name (adding only). */
  onAdd: (name: string) => void;
  onCheckAgain: (name: string) => void;
}

/**
 * The browser sign-in, step by step: used by the add card and by a
 * card's "Sign in again" panel. It shows what the sign-in state says and
 * owns only what is typed (the code, the name).
 */
function SignInSteps(props: SignInStepsProps): JSX.Element {
  const { signIn, accounts, account } = props;
  const { t } = useTranslation();
  const fmt = useFormats();
  const { phase, mode, url } = signIn;
  const renew = mode === 'renew';
  const who = account?.label ?? '';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const [code, setCode] = useState('');
  const [codeNote, setCodeNote] = useState<{ tone: 'error' | 'busy'; text: string } | null>(null);
  const [name, setName] = useState('');
  const [nameNote, setNameNote] = useState<string | null>(null);
  const [copied, copy] = useCopied();
  const slow = useSlow(phase === 'verifying');
  const sending = useRef(false);
  const ids = useId();
  const codeTitleId = `${ids}code`;
  const codeNoteId = `${ids}code-note`;
  const nameTitleId = `${ids}name`;
  const nameNoteId = `${ids}name-note`;

  /** Take focus only when nobody else in the pane holds it: the rest of
   *  the pane stays usable during a sign-in, and a result can land while
   *  the user is busy on another card. */
  const focusIfFree = useCallback((el: HTMLElement | null): void => {
    if (el && focusIsFree(rootRef.current)) el.focus();
  }, []);

  // A new attempt starts with an empty box: the old code is spent. (The
  // name stays: it is still the name the user means to give.)
  useEffect(() => {
    setCode('');
    setCodeNote(null);
    setNameNote(null);
  }, [signIn.run]);

  // The code box takes focus once per attempt: when Claude is ready for
  // the code and the page has been opened, so the code is the next thing.
  const codeBoxOpen = phase === 'waiting' && signIn.codeReady && signIn.pageOpened;
  const focusedRun = useRef(0);
  useEffect(() => {
    if (!codeBoxOpen || focusedRun.current === signIn.run) return;
    focusedRun.current = signIn.run;
    focusIfFree(codeRef.current);
  }, [codeBoxOpen, signIn.run, focusIfFree]);

  // Back from the browser with the code: the box has focus again, unless
  // the user had put it somewhere else on purpose.
  useEffect(() => {
    if (!codeBoxOpen) return;
    const onFocus = (): void => {
      const active = document.activeElement;
      if (active === document.body || active === codeRef.current) codeRef.current?.focus();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [codeBoxOpen]);

  // Where PopBot hands over the link instead of opening it, the link is
  // the next thing to act on.
  const linkOffered = phase === 'waiting' && !signIn.autoOpen && !signIn.pageOpened;
  useEffect(() => {
    if (linkOffered) focusIfFree(copyRef.current);
  }, [linkOffered, focusIfFree]);

  useEffect(() => {
    if (phase === 'naming') focusIfFree(nameRef.current);
    if (phase === 'code-refused' || phase === 'check-failed' || phase === 'failed') focusIfFree(actionRef.current);
  }, [phase, focusIfFree]);

  const openLink = (): void => {
    if (!url) return;
    // The window's own link path, so it lands in the preferred browser.
    window.open(url, '_blank');
    props.onPageOpened();
    if (!signIn.autoOpen) codeRef.current?.focus();
  };
  const copyLink = async (): Promise<void> => {
    if (!url || !(await copy(url))) return;
    props.onLinkCopied();
    if (!signIn.autoOpen) codeRef.current?.focus();
  };

  /** A token where the code goes: it must never sit readable in a text
   *  box, so it goes straight to the token form's password field. */
  const divertToken = (text: string): void => {
    setCode('');
    setCodeNote(null);
    props.onHaveToken(text);
  };
  const submitCode = async (): Promise<void> => {
    if (sending.current) return;
    if (!signIn.codeReady) {
      setCodeNote({ tone: 'busy', text: t('prefs.accounts.step2.waiting') });
      return;
    }
    const text = code.trim();
    const looks = codeLooks(text);
    if (looks === 'token') {
      divertToken(text);
      return;
    }
    if (looks !== 'ok') {
      // A refused code ends the sign-in, so what is plainly not a code is
      // not sent.
      const key = looks === 'empty' ? 'empty' : looks === 'link' ? 'isLink' : 'notCode';
      setCodeNote({ tone: 'error', text: t(`prefs.accounts.step2.${key}`) });
      if (looks === 'empty') codeRef.current?.focus();
      return;
    }
    sending.current = true;
    let taken = false;
    try {
      taken = await window.popbot.claudeAccounts.signInCode(text);
    } catch {
      taken = false;
    }
    sending.current = false;
    // Not taken: the code stays in the box for another try.
    if (!taken) setCodeNote({ tone: 'error', text: t('prefs.accounts.step2.notReady') });
  };

  const submitName = (): void => {
    const problem = nameProblem(name, accounts);
    if (problem) {
      setNameNote(problem === 'empty'
        ? t('prefs.accounts.step3.empty')
        : t('prefs.accounts.duplicate', { name: accountNamed(name, accounts)?.label ?? name.trim() }));
      nameRef.current?.focus();
      return;
    }
    setNameNote(null);
    props.onAdd(name.trim());
  };

  const title = renew
    ? t('prefs.accounts.renew.title', { name: who })
    : mode === 'another' ? t('prefs.accounts.add.titleAnother') : t('prefs.accounts.add.title');
  const closeLabel = renew ? t('prefs.accounts.flow.close', { name: who }) : t('prefs.accounts.add.close');
  const stepOneTitle = renew
    ? t('prefs.accounts.step1.titleRenew', { name: who })
    : mode === 'another' ? t('prefs.accounts.step1.titleAnother') : t('prefs.accounts.step1.title');
  const signedIn = phase === 'naming' || phase === 'verifying' || phase === 'check-failed';
  const verifying = phase === 'verifying';

  /** Whom the browser is probably signed in as, and whether a page is
   *  already open: said only once main has reported which is true. */
  const browserWarning = (): string | null => {
    if (mode !== 'another' || signIn.cliOpensBrowser === null) return null;
    const one = accounts.length === 1 ? accounts[0].label : null;
    if (signIn.cliOpensBrowser) {
      return one ? t('prefs.accounts.step1.warnOpenedOne', { name: one }) : t('prefs.accounts.step1.warnOpenedMany');
    }
    return one ? t('prefs.accounts.step1.warnOne', { name: one }) : t('prefs.accounts.step1.warnMany');
  };
  const warning = browserWarning();
  const getting = <Note tone="busy">{t('prefs.accounts.step1.getting')}</Note>;
  const linkButtons = (
    <div className="acct-btns">
      <button ref={copyRef} type="button" className={`btn sm${signIn.pageOpened ? '' : ' primary'}`} onClick={() => void copyLink()}>
        <i className="fa-solid fa-copy" aria-hidden /> {copied ? t('prefs.accounts.step1.copied') : t('prefs.accounts.step1.copyLink')}
      </button>
      <button type="button" className="btn sm" onClick={openLink}>
        <i className="fa-solid fa-arrow-up-right-from-square" aria-hidden /> {t('prefs.accounts.step1.open')}
      </button>
    </div>
  );

  const stepOneBody = (): ReactNode => {
    if (phase === 'starting') {
      return (
        <>
          {warning && <Caution>{warning}</Caution>}
          {getting}
        </>
      );
    }
    if (phase !== 'waiting') return null;
    if (signIn.autoOpen) {
      // PopBot opens the page; until it has, there is nothing to say.
      if (!signIn.pageOpened) return getting;
      return (
        <>
          <div>
            {renew
              ? t('prefs.accounts.step1.openedRenew', { name: who })
              : signIn.attempt > 1 ? t('prefs.accounts.step1.openedAgain') : t('prefs.accounts.step1.opened')}
          </div>
          {!renew && <div>{t('prefs.accounts.step1.whichOne')}</div>}
          <div>
            {t('prefs.accounts.step1.notOpened')}{' '}
            <button type="button" className="acct-link" onClick={openLink}>{t('prefs.accounts.step1.openAgain')}</button>
            {' · '}
            <button type="button" className="acct-link" onClick={() => void copyLink()}>
              {copied ? t('prefs.accounts.step1.copied') : t('prefs.accounts.step1.copyLink')}
            </button>
          </div>
        </>
      );
    }
    if (renew) {
      return (
        <>
          <div>
            {signIn.linkCopied
              ? t('prefs.accounts.step1.copiedHintRenew', { name: who })
              : t('prefs.accounts.step1.whereRenew', { name: who })}
          </div>
          {linkButtons}
        </>
      );
    }
    // The warning stands above the buttons: a reflex click on "open"
    // would approve whichever account the browser is signed in as.
    return (
      <>
        {warning && <Caution>{warning}</Caution>}
        {linkButtons}
        <div>{signIn.linkCopied ? t('prefs.accounts.step1.copiedHint') : t('prefs.accounts.step1.where')}</div>
      </>
    );
  };

  const stepTwoBody = (): ReactNode => {
    if (phase === 'waiting') {
      return (
        <>
          <div className="sign-in-code-row">
            <input
              ref={codeRef}
              className="pref-input mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-labelledby={codeTitleId}
              aria-describedby={codeNote ? codeNoteId : undefined}
              disabled={!signIn.codeReady}
              placeholder={signIn.codeReady ? t('prefs.accounts.step2.placeholder') : t('prefs.accounts.step2.waiting')}
              value={code}
              onChange={(e) => {
                // Dropped or typed rather than pasted: a token still must
                // not stay readable here.
                if (codeLooks(e.target.value) === 'token') {
                  divertToken(e.target.value);
                  return;
                }
                setCode(e.target.value);
                setCodeNote(null);
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (codeLooks(text) !== 'token') return;
                e.preventDefault();
                divertToken(text);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                void submitCode();
              }}
            />
            {/* Pasting only fills the box; this, or Enter, sends it. */}
            <button type="button" className={`btn sm${code.trim() ? ' primary' : ''}`} onClick={() => void submitCode()}>
              {t('prefs.accounts.step2.continue')}
            </button>
          </div>
          {/* "Waiting for Claude" is over the moment the box opens. */}
          {codeNote && !(codeNote.tone === 'busy' && signIn.codeReady) && (
            <Note tone={codeNote.tone} id={codeNoteId}>{codeNote.text}</Note>
          )}
        </>
      );
    }
    if (phase === 'checking-code') return <Note tone="busy">{t('prefs.accounts.step2.checking')}</Note>;
    if (phase === 'code-refused') {
      return (
        <>
          <div>{t('prefs.accounts.step2.refused')}</div>
          <div className="acct-btns">
            <button ref={actionRef} type="button" className="btn sm primary" onClick={props.onRestart}>
              {t('prefs.accounts.step2.newCode')}
            </button>
          </div>
        </>
      );
    }
    return null;
  };

  const checking = (
    <>
      <Note tone="busy">{slow ? t('prefs.accounts.check.slow') : t('prefs.accounts.check.running', { name: renew ? who : name.trim() })}</Note>
      <div>{t('prefs.accounts.check.leave')}</div>
    </>
  );

  const steps = (): ReactNode => {
    if (phase === 'failed') {
      const failure = signIn.failure;
      return (
        <Step n={1} status="failed" title={t(failure?.where === 'start' ? 'prefs.accounts.fail.start' : 'prefs.accounts.fail.title')}>
          {failure?.detail && <div className="acct-detail">{failure.detail}</div>}
          <div className="acct-btns">
            <button ref={actionRef} type="button" className="btn sm primary" onClick={props.onRestart}>
              {t('prefs.accounts.fail.restart')}
            </button>
          </div>
        </Step>
      );
    }
    if (signedIn) {
      const failed = phase === 'check-failed' && signIn.check ? signIn.check : null;
      const ways = failed ? checkFailure(failed.reason) : null;
      const lines = failed ? failureLines(t, failed.reason, 'sign-in', renew ? 'old' : 'nothing') : null;
      return (
        <>
          {/* Steps 1 and 2 are behind: one line says so. */}
          <Step n={1} status="done" title={t('prefs.accounts.step2.done')}>
            {renew && verifying ? checking : null}
          </Step>
          {!renew && !failed && (
            <Step n={3} status="current" title={t('prefs.accounts.step3.title')} titleId={nameTitleId}>
              <div className="acct-btns">
                <input
                  ref={nameRef}
                  className="pref-input narrow"
                  style={{ width: 260 }}
                  placeholder={t('prefs.accounts.step3.placeholder')}
                  aria-labelledby={nameTitleId}
                  aria-describedby={nameNote ? nameNoteId : undefined}
                  disabled={verifying}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameNote(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    submitName();
                  }}
                />
                <button type="button" className="btn sm primary" disabled={verifying} onClick={submitName}>
                  {verifying && <i className="fa-solid fa-spinner fa-spin" aria-hidden />}
                  {t('prefs.accounts.step3.add')}
                </button>
              </div>
              {nameNote && <Note tone="error" id={nameNoteId}>{nameNote}</Note>}
              {verifying
                ? checking
                : (
                  <div>
                    {accounts.length > 0
                      ? t('prefs.accounts.step3.hintAnother', { names: fmt.or(accounts.map((a) => a.label)) })
                      : t('prefs.accounts.step3.hint')}
                  </div>
                )}
            </Step>
          )}
          {failed && ways && lines && (
            <Step n={renew ? 2 : 3} status="failed" title={lines.headline}>
              <div>{lines.kept}</div>
              {failed.error && <div className="acct-detail">{failed.error}</div>}
              {(ways.again || ways.signIn) && (
                <div className="acct-btns">
                  {ways.again && (
                    // The sign-in is still held in main: only the check repeats.
                    <button ref={actionRef} type="button" className="btn sm primary" onClick={() => props.onCheckAgain(name.trim())}>
                      {t('prefs.accounts.check.again')}
                    </button>
                  )}
                  {ways.signIn && (
                    <button
                      ref={ways.again ? undefined : actionRef}
                      type="button"
                      className={`btn sm${ways.again ? '' : ' primary'}`}
                      onClick={props.onRestart}
                    >
                      {t('prefs.accounts.check.signInAgain')}
                    </button>
                  )}
                </div>
              )}
            </Step>
          )}
        </>
      );
    }
    const oneStatus = phase === 'idle' ? 'todo'
      : phase === 'starting' || (phase === 'waiting' && !signIn.pageOpened) ? 'current' : 'done';
    const twoStatus = phase === 'idle' || phase === 'starting' ? 'todo'
      : phase === 'code-refused' ? 'failed'
        : phase === 'checking-code' || signIn.pageOpened ? 'current' : '';
    return (
      <>
        <Step n={1} status={oneStatus} title={stepOneTitle}>{stepOneBody()}</Step>
        <Step n={2} status={twoStatus} title={t('prefs.accounts.step2.title')} titleId={codeTitleId}>{stepTwoBody()}</Step>
        {!renew && <Step n={3} status="todo" title={t('prefs.accounts.step3.title')} />}
      </>
    );
  };

  // Once signed in, pasting a token is no longer the way on; while a
  // check runs, nothing here may look like a way out of it.
  const offerToken = phase === 'idle' || phase === 'starting' || phase === 'waiting'
    || phase === 'code-refused' || phase === 'check-failed' || phase === 'failed';
  return (
    <div className="acct-flow" ref={rootRef}>
      <div className="acct-flow-head">
        <span className="acct-flow-title">{title}</span>
        {/* The check can't be aborted, so nothing may claim to discard it. */}
        {phase !== 'idle' && !verifying && <CloseButton label={closeLabel} onClick={props.onClose} />}
      </div>
      {phase === 'idle' && <div className="acct-flow-sub">{t('prefs.accounts.add.sub')}</div>}
      <ol className="acct-steps">{steps()}</ol>
      {offerToken && (
        <div className="acct-flow-foot">
          {phase === 'idle' && (
            <button type="button" className="btn sm primary" data-focus="add" onClick={props.onStart}>
              <i className="fa-solid fa-right-to-bracket" aria-hidden /> {t('prefs.accounts.add.signIn')}
            </button>
          )}
          <button type="button" className="acct-link" onClick={() => props.onHaveToken()}>
            {t('prefs.accounts.add.haveToken')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Adding with a token ──────────────────────────────────────────────

/**
 * "I already have a token": a name and a token, saved by the one button
 * (or Enter) and by nothing else — this creates an account, so leaving a
 * field never does.
 */
function AddWithTokenForm({ accounts, prefill, note, onAdd, onClose, onUseBrowser }: {
  accounts: ClaudeAccountInfo[];
  prefill?: string;
  note?: 'was-code' | 'no-token';
  onAdd: (name: string, token: string) => Promise<Outcome>;
  onClose: () => void;
  onUseBrowser: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [token, setToken] = useState(prefill ?? '');
  const [problem, setProblem] = useState<{ field: 'name' | 'token'; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<{ reason: ClaudeAccountsFailure; error: string } | null>(null);
  const [copied, copy] = useCopied();
  const slow = useSlow(checking);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const alive = useRef(true);
  const ids = useId();
  const nameId = `${ids}name`;
  const tokenId = `${ids}token`;
  const nameNoteId = `${ids}name-note`;
  const tokenNoteId = `${ids}token-note`;
  const looks = tokenLooks(token);
  const cutOff = tokenCutOff(token);

  useEffect(() => {
    alive.current = true;
    nameRef.current?.focus();
    return () => { alive.current = false; };
  }, []);
  // A check that failed leaves the token ready to be replaced.
  useEffect(() => {
    if (!failure) return;
    tokenRef.current?.focus();
    tokenRef.current?.select();
  }, [failure]);

  const submit = async (): Promise<void> => {
    if (checking) return;
    setFailure(null);
    const bad = nameProblem(name, accounts);
    if (bad) {
      setProblem({
        field: 'name',
        text: bad === 'empty'
          ? t('prefs.accounts.step3.empty')
          : t('prefs.accounts.duplicate', { name: accountNamed(name, accounts)?.label ?? name.trim() }),
      });
      nameRef.current?.focus();
      return;
    }
    if (looks === 'empty') {
      setProblem({ field: 'token', text: t('prefs.accounts.token.empty') });
      tokenRef.current?.focus();
      return;
    }
    // An API key can't be what is wanted; the line under the field says so.
    if (looks === 'api-key') {
      tokenRef.current?.focus();
      return;
    }
    setProblem(null);
    setChecking(true);
    const result = await onAdd(name.trim(), cleanToken(token));
    if (!alive.current) return;
    setChecking(false);
    if (!result.ok) setFailure({ reason: result.reason, error: result.error });
  };
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void submit();
  };
  const lines = failure ? failureLines(t, failure.reason, 'token', 'nothing') : null;
  const tokenNote = problem?.field === 'token' || looks === 'api-key' || looks === 'other' || cutOff !== null;

  return (
    <div className="acct-flow">
      <div className="acct-flow-head">
        <span className="acct-flow-title">{t('prefs.accounts.token.title')}</span>
        {!checking && <CloseButton label={t('prefs.accounts.add.close')} onClick={onClose} />}
      </div>
      {note && (
        <div className="acct-flow-sub">
          {note === 'was-code'
            ? t('prefs.accounts.token.wasCode')
            : rich(t, 'prefs.accounts.fail.noToken', {}, COMMAND_MARK)}
        </div>
      )}
      <div className="acct-form">
        <label htmlFor={nameId}>{t('prefs.accounts.token.name')}</label>
        <div className="acct-field">
          <input
            id={nameId}
            ref={nameRef}
            className="pref-input narrow"
            style={{ width: 260 }}
            placeholder={t('prefs.accounts.step3.placeholder')}
            aria-describedby={problem?.field === 'name' ? nameNoteId : undefined}
            disabled={checking}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
            onKeyDown={onEnter}
          />
          {problem?.field === 'name' && <Note tone="error" id={nameNoteId}>{problem.text}</Note>}
        </div>
        <label htmlFor={tokenId}>{t('prefs.accounts.token.token')}</label>
        <div className="acct-field">
          <input
            id={tokenId}
            ref={tokenRef}
            className="pref-input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={tokenNote ? tokenNoteId : undefined}
            disabled={checking}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setProblem(null);
              setFailure(null);
            }}
            onKeyDown={onEnter}
          />
          {problem?.field === 'token' && <Note tone="error" id={tokenNoteId}>{problem.text}</Note>}
          {looks === 'api-key' && <Note tone="error" id={tokenNoteId}>{rich(t, 'prefs.accounts.token.apiKey', {}, COMMAND_MARK)}</Note>}
          {/* Another prefix is only a caution: pasting is the way out when a
              sign-in can't be read, so it is checked all the same. */}
          {looks === 'other' && <Caution id={tokenNoteId}>{rich(t, 'prefs.accounts.token.odd', {}, COMMAND_MARK)}</Caution>}
          {/* A copy cut at the terminal's edge: said before Claude refuses it. */}
          {cutOff !== null && !problem && (
            <Caution id={tokenNoteId}>{t('prefs.accounts.token.cutOff', { count: cutOff, whole: SETUP_TOKEN_LENGTH })}</Caution>
          )}
          {checking && (
            <>
              <Note tone="busy">{slow ? t('prefs.accounts.check.slow') : t('prefs.accounts.token.checking')}</Note>
              <div>{t('prefs.accounts.check.leave')}</div>
            </>
          )}
          {failure && lines && (
            <>
              <Note tone="error">{lines.headline} {lines.kept}</Note>
              {failure.error && <div className="acct-detail">{failure.error}</div>}
            </>
          )}
          <div>{rich(t, 'prefs.accounts.token.hint', {}, COMMAND_MARK)}</div>
          <div>
            <button type="button" className="acct-link" onClick={() => void copy(SETUP_COMMAND)}>
              {copied ? t('prefs.accounts.step1.copied') : t('prefs.accounts.token.copyCommand')}
            </button>
          </div>
        </div>
      </div>
      <div className="acct-flow-foot">
        <button type="button" className="btn sm primary" disabled={checking} onClick={() => void submit()}>
          {checking && <i className="fa-solid fa-spinner fa-spin" aria-hidden />}
          {t('prefs.accounts.add.button')}
        </button>
        {!checking && (
          <button type="button" className="acct-link" onClick={onUseBrowser}>
            {t('prefs.accounts.add.useBrowser')}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Replacing one account's token ────────────────────────────────────

/**
 * "Paste a token" on a card. This edits a setting on an account that
 * exists, so it has no button: it applies on Enter, or on leaving the
 * panel once the text is plainly a token — never on paste alone. The
 * close icon discards what was typed.
 */
function ReplaceTokenPanel({ account, prefill, note, onApply, onClose }: {
  account: ClaudeAccountInfo;
  prefill?: string;
  note?: 'was-code' | 'no-token';
  onApply: (token: string) => Promise<Outcome>;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState(prefill ?? '');
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<{ reason: ClaudeAccountsFailure; error: string } | null>(null);
  const [copied, copy] = useCopied();
  const slow = useSlow(checking);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  // A press inside the panel that lands on nothing focusable still blurs
  // the field, with no word of where focus went: remembered here so it
  // does not count as leaving.
  const pressedInside = useRef(false);
  const ids = useId();
  const fieldId = `${ids}token`;
  const noteId = `${ids}note`;
  const looks = tokenLooks(text);
  const cutOff = tokenCutOff(text);
  const who = account.label;

  useEffect(() => {
    alive.current = true;
    fieldRef.current?.focus();
    return () => { alive.current = false; };
  }, []);
  // After a check that failed the field is ready for another token —
  // unless the user has gone on to something else meanwhile.
  useEffect(() => {
    if (!failure || !focusIsFree(panelRef.current)) return;
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, [failure]);

  const apply = async (by: 'enter' | 'leaving'): Promise<void> => {
    if (inFlight.current || looks === 'empty' || looks === 'api-key') return;
    // Leaving applies only what is plainly a token; anything else waits
    // for Enter, as the line under the field says.
    if (by === 'leaving' && looks !== 'token') return;
    inFlight.current = true;
    setFailure(null);
    setChecking(true);
    const result = await onApply(cleanToken(text));
    inFlight.current = false;
    if (!alive.current) return;
    setChecking(false);
    if (result.ok) return;
    setFailure({ reason: result.reason, error: result.error });
    // A refused token is no use; anything else may pass on a second try.
    if (result.reason === 'refused') setText('');
  };
  const lines = failure ? failureLines(t, failure.reason, 'token', 'old') : null;
  const described = looks === 'api-key' || looks === 'other' || cutOff !== null;

  return (
    <div
      className="acct-flow"
      ref={panelRef}
      onMouseDownCapture={() => {
        pressedInside.current = true;
        window.setTimeout(() => { pressedInside.current = false; }, 0);
      }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        const inside = pressedInside.current || (to instanceof Node && !!panelRef.current?.contains(to));
        // Another window taking focus is not the user leaving the field.
        if (inside || !document.hasFocus()) return;
        void apply('leaving');
      }}
    >
      <div className="acct-flow-head">
        <label className="acct-flow-title" htmlFor={fieldId}>{t('prefs.accounts.token.replaceTitle', { name: who })}</label>
        {!checking && <CloseButton label={t('prefs.accounts.flow.close', { name: who })} onClick={onClose} />}
      </div>
      {note && (
        <div className="acct-flow-sub">
          {note === 'was-code'
            ? t('prefs.accounts.token.wasCodeRenew', { name: who })
            : rich(t, 'prefs.accounts.fail.noToken', {}, COMMAND_MARK)}
        </div>
      )}
      <div className="acct-field acct-replace">
        <input
          id={fieldId}
          ref={fieldRef}
          className="pref-input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={described ? noteId : undefined}
          disabled={checking}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFailure(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            void apply('enter');
          }}
        />
        {checking && <Note tone="busy">{slow ? t('prefs.accounts.check.slow') : t('prefs.accounts.token.checking')}</Note>}
        {failure && lines && (
          <>
            <Note tone="error">{lines.headline} {lines.kept}</Note>
            {failure.error && <div className="acct-detail">{failure.error}</div>}
          </>
        )}
        {looks === 'api-key' && <Note tone="error" id={noteId}>{rich(t, 'prefs.accounts.token.apiKey', {}, COMMAND_MARK)}</Note>}
        {looks === 'other' && <Caution id={noteId}>{rich(t, 'prefs.accounts.token.oddReplace', {}, COMMAND_MARK)}</Caution>}
        {cutOff !== null && (
          <Caution id={noteId}>{t('prefs.accounts.token.cutOff', { count: cutOff, whole: SETUP_TOKEN_LENGTH })}</Caution>
        )}
        {!checking && (
          <div className="acct-hint-row">
            <span>{rich(t, 'prefs.accounts.token.replaceHint', { name: who }, COMMAND_MARK)}</span>
            <button type="button" className="acct-link" onClick={() => void copy(SETUP_COMMAND)}>
              {copied ? t('prefs.accounts.step1.copied') : t('prefs.accounts.token.copyCommand')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── One account ──────────────────────────────────────────────────────

/** The name as a field: Enter or leaving it applies, Escape reverts. */
export function RenameField({ account, accounts, describedBy, onCommit, onCancel, onDuplicate, onEdit }: {
  account: ClaudeAccountInfo;
  accounts: ClaudeAccountInfo[];
  describedBy?: string;
  /** `byKey`: ended from the keyboard, so focus should stay on the card. */
  onCommit: (name: string, byKey: boolean) => void;
  onCancel: (byKey: boolean) => void;
  /** The name is taken, by the account spelled `taken`. */
  onDuplicate: (taken: string) => void;
  onEdit: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState(account.label);
  const ref = useRef<HTMLInputElement | null>(null);
  // Enter applies and, by closing the field, blurs it too: once is enough.
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const apply = (byKey: boolean): void => {
    if (settled.current) return;
    const name = value.trim();
    if (!name || name === account.label) {
      settled.current = true;
      onCancel(byKey);
      return;
    }
    const taken = accountNamed(name, accounts, account.id);
    if (taken) {
      onDuplicate(taken.label);
      return;
    }
    settled.current = true;
    onCommit(name, byKey);
  };
  return (
    <input
      ref={ref}
      className="pref-input narrow"
      style={{ width: 220 }}
      aria-label={t('prefs.accounts.rename.field')}
      aria-describedby={describedBy}
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        onEdit();
      }}
      onBlur={() => apply(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          apply(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          settled.current = true;
          onCancel(true);
        }
      }}
    />
  );
}

interface AccountCardProps {
  account: ClaudeAccountInfo;
  accounts: ClaudeAccountInfo[];
  view: CardView;
  now: number;
  /** A sign-in or token panel is open somewhere in the pane. */
  flowOpen: boolean;
  /** This card's own panel, when it is the one open. */
  panel: ReactNode;
  verdict: Verdict | null;
  /** A switch is in flight (`switchingHere`: to this account). */
  switching: boolean;
  switchingHere: boolean;
  onUse: () => void;
  onRename: (name: string) => void;
  onSignInAgain: () => void;
  onPasteToken: () => void;
  onRemove: () => void;
}

function AccountCard(props: AccountCardProps): JSX.Element {
  const { account, accounts, view, now, panel } = props;
  const { t } = useTranslation();
  const fmt = useFormats();
  const [editing, setEditing] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  const penRef = useRef<HTMLButtonElement | null>(null);
  const backToPen = useRef(false);
  const takenId = useId();
  const name = account.label;

  // The field gone, focus goes back to what opened it — when it was the
  // keyboard that closed it; a click elsewhere keeps its own focus.
  useEffect(() => {
    if (editing || !backToPen.current) return;
    backToPen.current = false;
    penRef.current?.focus();
  }, [editing]);
  const endEditing = (byKey: boolean): void => {
    backToPen.current = byKey;
    setTaken(null);
    setEditing(false);
  };

  const status = (): string => {
    switch (view.status) {
      case 'saved':
        return t('prefs.accounts.status.saved', { date: fmt.saved(account.addedAt) });
      case 'next':
        return t('prefs.accounts.status.next', { name: inUse(accounts)?.label ?? '' });
      case 'out':
      case 'outInUse':
        return t(`prefs.accounts.status.${view.status}`, { until: fmt.when('until', account.outOfUsageUntil ?? now, now) });
      case 'expiring':
        // A sign-in lasts a year from the day it was saved, at most.
        return t('prefs.accounts.status.expiring', { date: fmt.day(account.addedAt + SIGN_IN_LIFETIME_MS) });
      default:
        return t(`prefs.accounts.status.${view.status}`);
    }
  };
  const statusIcon = view.tone === 'error' ? 'fa-circle-exclamation'
    : view.tone === 'wait' ? (view.kind === 'expiring' ? 'fa-triangle-exclamation' : 'fa-hourglass-half')
      : null;
  // While any panel is open nothing that would start another is offered,
  // so a stray click can't cancel a sign-in half done in the browser.
  const offerSignIn = view.canSignIn && !props.flowOpen;

  return (
    <div className="host-card acct-card" data-focus={`card:${account.id}`} tabIndex={-1}>
      <div className="host-card-head">
        <i className="fa-solid fa-circle-user" aria-hidden />
        {editing ? (
          <RenameField
            account={account}
            accounts={accounts}
            describedBy={taken ? takenId : undefined}
            onCommit={(next, byKey) => {
              endEditing(byKey);
              props.onRename(next);
            }}
            onCancel={endEditing}
            onDuplicate={setTaken}
            onEdit={() => setTaken(null)}
          />
        ) : (
          <>
            <span className="host-card-title" title={name} onClick={() => setEditing(true)}>{name}</span>
            <button
              ref={penRef}
              type="button"
              className="acct-icon"
              aria-label={t('prefs.accounts.rename.label', { name })}
              title={t('prefs.accounts.rename.label', { name })}
              onClick={() => setEditing(true)}
            >
              <i className="fa-solid fa-pen" aria-hidden />
            </button>
          </>
        )}
        {view.inUse && <span className="pill done">{t('prefs.accounts.pill.inUse')}</span>}
        {view.nextUp && <span className="pill muted">{t('prefs.accounts.pill.next')}</span>}
        {view.statePill && (
          <span className={`pill ${view.statePill === 'out' ? 'wait' : 'err'}`}>{t(`prefs.accounts.pill.${view.statePill}`)}</span>
        )}
        {view.canUse && (
          <button
            type="button"
            className="btn sm acct-use"
            aria-label={t('prefs.accounts.use.label', { name })}
            title={t('prefs.accounts.use.title')}
            disabled={props.switching}
            onClick={props.onUse}
          >
            {props.switchingHere && <i className="fa-solid fa-spinner fa-spin" aria-hidden />}
            {t('prefs.accounts.use')}
          </button>
        )}
        {/* Out of usage: the way to switch stays in its place, greyed, and
            says when it can be pressed (the status line says it too). */}
        {view.useWaits && (
          <button
            type="button"
            className="btn sm acct-use"
            aria-label={t('prefs.accounts.use.label', { name })}
            title={t('prefs.accounts.use.waits', { until: fmt.when('until', account.outOfUsageUntil ?? now, now) })}
            disabled
          >
            {t('prefs.accounts.use')}
          </button>
        )}
      </div>
      {editing && taken && (
        <Note tone="error" id={takenId}>{t('prefs.accounts.duplicate', { name: taken })}</Note>
      )}
      <div className="host-card-foot">
        <span className={`host-card-status${view.tone ? ` ${view.tone}` : ''}`}>
          {statusIcon && <i className={`fa-solid ${statusIcon}`} aria-hidden />}
          <span>{status()}</span>
        </span>
        {!panel && (
          <span className="acct-actions">
            {offerSignIn && (
              <>
                <button
                  type="button"
                  className={`btn sm ${view.signInPrimary ? 'primary' : 'ghost'}`}
                  data-focus={`renew:${account.id}`}
                  aria-label={t('prefs.accounts.signInAgain.label', { name })}
                  onClick={props.onSignInAgain}
                >
                  {t('prefs.accounts.signInAgain')}
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  data-focus={`token:${account.id}`}
                  aria-label={t('prefs.accounts.pasteToken.label', { name })}
                  onClick={props.onPasteToken}
                >
                  {t('prefs.accounts.pasteToken')}
                </button>
              </>
            )}
            <button
              type="button"
              className="btn sm ghost"
              data-focus={`remove:${account.id}`}
              aria-label={t('prefs.accounts.remove.label', { name })}
              onClick={props.onRemove}
            >
              {t('prefs.accounts.remove')}
            </button>
          </span>
        )}
      </div>
      {props.verdict && <VerdictLine verdict={props.verdict} />}
      {panel && <div className="host-repos">{panel}</div>}
    </div>
  );
}

export function VerdictLine({ verdict }: { verdict: Verdict }): JSX.Element {
  return (
    <div className={`acct-verdict ${verdict.tone}`}>
      <i className={`fa-solid ${verdict.tone === 'ok' ? 'fa-circle-check' : 'fa-circle-exclamation'}`} aria-hidden />
      <span>{verdict.text}</span>
    </div>
  );
}

// ── The pane itself ──────────────────────────────────────────────────

/**
 * Preferences > Claude accounts: the accounts PopBot runs Claude chats
 * on, which one is in use, and the ways to add, replace, switch and
 * remove them. What each state shows is decided in
 * lib/claudeAccountsView.ts; this file wires those decisions to main.
 */
export function PrefsClaudeAccounts(): JSX.Element {
  const { t } = useTranslation();
  const fmt = useFormats();
  const api = window.popbot.claudeAccounts;
  const [state, setState] = useState<ClaudeAccountsState | null>(null);
  const stateRef = useRef<ClaudeAccountsState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [flow, setFlowState] = useState<Flow>(null);
  const flowRef = useRef<Flow>(null);
  const [signIn, dispatch, signInRef] = useSignIn();
  const [busy, setBusy] = useState<Busy>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [removing, setRemoving] = useState<ClaudeAccountInfo | null>(null);
  const removingRef = useRef<ClaudeAccountInfo | null>(null);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [live, setLive] = useState('');
  const [focusAsk, setFocusAsk] = useState<{ key: string; force: boolean; n: number } | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  // True while a switch the user asked for is in flight: the state main
  // pushes then is that switch, not PopBot moving chats by itself.
  const switching = useRef(false);

  const apply = useCallback((next: ClaudeAccountsState): void => {
    // A result carries more than the state (ok, error): keep only the state.
    const clean: ClaudeAccountsState = {
      accounts: next.accounts,
      encryptionAvailable: next.encryptionAvailable,
      ...(next.outdatedHosts ? { outdatedHosts: next.outdatedHosts } : {}),
    };
    stateRef.current = clean;
    setState(clean);
    setNow(Date.now());
  }, []);
  const setFlow = (next: Flow): void => {
    flowRef.current = next;
    setFlowState(next);
  };
  /** Say it in the live region. A status region speaks only when its
   *  text changes, and the same result twice in a row must be heard twice. */
  const announce = useCallback((text: string): void => {
    setLive((prev) => (prev === text ? `${text} ` : text));
  }, []);
  /** Put a verdict on its card. It stays until the next action in the
   *  pane — never a timer. */
  const say = (next: Verdict): void => {
    setVerdict(next);
    announce(next.text);
  };
  /**
   * Move focus to the element marked `data-focus={key}` once it is on the
   * page. Unless forced, only when nothing else holds focus: the control
   * that had it has just gone (a closed panel, a dialog), whereas a
   * result that lands while the user works elsewhere must not pull them away.
   */
  const focusLater = useCallback((key: string, force = false): void => {
    setFocusAsk((prev) => ({ key, force, n: (prev?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (!focusAsk) return;
    const active = document.activeElement;
    if (!focusAsk.force && active && active !== document.body) return;
    const el = paneRef.current?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusAsk.key)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.focus();
  }, [focusAsk]);

  // What main pushes and what a running sign-in reports arrive outside
  // any render; each is handled by the newest copy of its handler.
  const onPush = useRef<(next: ClaudeAccountsState) => void>(() => {});
  const onSignInEvent = useRef<(event: ClaudeSignInEvent) => void>(() => {});

  // The accounts: read on mount and whenever the window is back in front,
  // pushed by main in between. No polling.
  useEffect(() => {
    const main = window.popbot.claudeAccounts;
    alive.current = true;
    const refresh = (): void => {
      void main.list().then((s) => { if (alive.current) apply(s); }).catch(() => {});
    };
    refresh();
    const offChanged = main.onChanged((s) => { if (alive.current) onPush.current(s); });
    // Subscribed once, before any sign-in is started.
    const offSignIn = main.onSignInEvent((event) => { if (alive.current) onSignInEvent.current(event); });
    window.addEventListener('focus', refresh);
    return () => {
      alive.current = false;
      offChanged();
      offSignIn();
      window.removeEventListener('focus', refresh);
      // Leaving with a sign-in open drops it; nothing was saved. A check
      // already in flight is left to finish in main: the account appears
      // next time.
      const open = flowRef.current;
      const phase = signInRef.current.phase;
      if (open && (open.kind === 'add' || open.kind === 'renew') && phase !== 'idle' && phase !== 'verifying') {
        void main.signInCancel();
      }
    };
  }, [apply, signInRef]);

  // The clock: an out-of-usage time that has passed turns its card back
  // into a normal one with nobody pressing anything.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  /** Run one accounts request. Whatever it answers also carries the new state. */
  const act = async (call: () => Promise<ClaudeAccountsResult>): Promise<Outcome> => {
    try {
      const r = await call();
      if (alive.current) apply(r);
      return r.ok ? { ok: true, accounts: r.accounts } : { ok: false, reason: r.reason ?? 'other', error: r.error };
    } catch (err) {
      return { ok: false, reason: 'other', error: errorText(err) };
    }
  };

  // ── Flows ──────────────────────────────────────────────────────────

  /** Ask main for a browser sign-in: a new flow, or a new try within one. */
  const requestSignIn = (action: Extract<SignInAction, { type: 'start' | 'restart' }>): void => {
    setVerdict(null);
    const started = dispatch(action);
    if (started.phase !== 'starting') return;
    const { run } = started;
    lastSignInStart += 1;
    const mine = lastSignInStart;
    const answered = (answer: { ok: true; cliOpensBrowser: boolean } | { ok: false; error: string }): void => {
      const current = signInRef.current;
      if (!alive.current || current.run !== run || current.phase === 'idle') {
        // Closed before main had got as far as starting it: the cancel
        // sent then found nothing to stop, so stop it now — unless a
        // newer sign-in has taken its place.
        if (mine === lastSignInStart) void api.signInCancel();
        return;
      }
      const after = dispatch({ type: 'start-answer', run, answer });
      if (!answer.ok && after.phase === 'failed' && current.phase !== 'failed') {
        announce(`${t('prefs.accounts.fail.start')} ${answer.error}`);
      }
    };
    api.signInStart({ openBrowser: false }).then(answered, (err: unknown) => answered({ ok: false, error: errorText(err) }));
  };

  const openAdd = (): void => {
    const count = stateRef.current?.accounts.length ?? 0;
    setFlow({ kind: 'add' });
    // PopBot opens the page itself only when there is no other account
    // the browser could be signed in as instead.
    requestSignIn({ type: 'start', mode: count === 0 ? 'first' : 'another', autoOpen: count === 0 });
  };
  const openRenew = (id: string): void => {
    setFlow({ kind: 'renew', id });
    requestSignIn({ type: 'start', mode: 'renew', autoOpen: (stateRef.current?.accounts.length ?? 0) === 1 });
  };
  /** Open a token form: for the account `id`, or for a new one. A browser
   *  sign-in still running would only hold a token nobody will name. */
  const openTokenForm = (id: string | null, note?: 'was-code' | 'no-token', prefill?: string): void => {
    setVerdict(null);
    void api.signInCancel();
    dispatch({ type: 'close' });
    setFlow(id ? { kind: 'token', id, note, prefill } : { kind: 'add-token', note, prefill });
  };
  const closeFlow = (): void => {
    const open = flowRef.current;
    if (!open) return;
    if (open.kind === 'add' || open.kind === 'renew') {
      if (signInRef.current.phase !== 'verifying') void api.signInCancel();
      dispatch({ type: 'close' });
    }
    setFlow(null);
    focusLater(open.kind === 'renew' ? `renew:${open.id}` : open.kind === 'token' ? `token:${open.id}` : 'add');
  };

  /** An add worked: the card that is new carries the verdict, worded by
   *  what main made of it (in use, or standing by). */
  const finishAdd = (before: ClaudeAccountInfo[], after: ClaudeAccountInfo[]): void => {
    dispatch({ type: 'close' });
    setFlow(null);
    const added = newAccountIn(before, after);
    if (!added) return;
    say({
      id: added.id,
      tone: 'ok',
      text: t(`prefs.accounts.verdict.${addedVerdict(added, Date.now())}`),
    });
    focusLater(`card:${added.id}`);
  };
  const failedCheck = (reason: ClaudeAccountsFailure, path: 'sign-in' | 'token', keeps: 'nothing' | 'old'): void => {
    const lines = failureLines(t, reason, path, keeps);
    announce(`${lines.headline} ${lines.kept}`);
  };

  const addSignedIn = async (name: string): Promise<void> => {
    setVerdict(null);
    const was = signInRef.current;
    if (dispatch({ type: 'verify' }) === was) return;
    const before = stateRef.current?.accounts ?? [];
    const r = await act(() => api.addSignedIn(name));
    if (!alive.current) return;
    if (r.ok) {
      finishAdd(before, r.accounts);
      return;
    }
    dispatch({ type: 'verify-failed', reason: r.reason, error: r.error });
    failedCheck(r.reason, 'sign-in', 'nothing');
  };
  /** Check the sign-in main holds and make it this account's. */
  const renewSignedIn = async (id: string): Promise<void> => {
    const r = await act(() => api.setTokenSignedIn(id));
    if (!alive.current) return;
    if (!r.ok) {
      dispatch({ type: 'verify-failed', reason: r.reason, error: r.error });
      failedCheck(r.reason, 'sign-in', 'old');
      return;
    }
    dispatch({ type: 'close' });
    setFlow(null);
    const inUseNow = r.accounts.some((a) => a.id === id && a.active);
    say({ id, tone: 'ok', text: t(inUseNow ? 'prefs.accounts.verdict.renewedInUse' : 'prefs.accounts.verdict.renewed') });
    focusLater(`renew:${id}`);
  };
  const checkAgain = (name: string): void => {
    const open = flowRef.current;
    if (open?.kind === 'add') {
      void addSignedIn(name);
      return;
    }
    if (open?.kind !== 'renew') return;
    setVerdict(null);
    const was = signInRef.current;
    if (dispatch({ type: 'verify' }) !== was) void renewSignedIn(open.id);
  };
  const addWithToken = async (name: string, token: string): Promise<Outcome> => {
    setVerdict(null);
    const before = stateRef.current?.accounts ?? [];
    const r = await act(() => api.add(name, token));
    if (!alive.current) return r;
    if (r.ok) finishAdd(before, r.accounts);
    else failedCheck(r.reason, 'token', 'nothing');
    return r;
  };
  const replaceToken = async (id: string, token: string): Promise<Outcome> => {
    setVerdict(null);
    const r = await act(() => api.setToken(id, token));
    if (!alive.current) return r;
    if (!r.ok) {
      failedCheck(r.reason, 'token', 'old');
      return r;
    }
    setFlow(null);
    const inUseNow = r.accounts.some((a) => a.id === id && a.active);
    say({ id, tone: 'ok', text: t(inUseNow ? 'prefs.accounts.verdict.tokenInUse' : 'prefs.accounts.verdict.token') });
    focusLater(`token:${id}`);
    return r;
  };

  onSignInEvent.current = (event) => {
    const open = flowRef.current;
    if (!open || (open.kind !== 'add' && open.kind !== 'renew')) return;
    const before = signInRef.current;
    const after = dispatch({ type: 'event', event });
    if (after === before) return;
    if (after.phase === 'failed') {
      if (after.failure?.noToken) {
        // Claude signed the user in but PopBot could not read the token:
        // pasting it by hand still works, so go straight there.
        openTokenForm(open.kind === 'renew' ? open.id : null, 'no-token');
        announce(t('prefs.accounts.fail.noToken', { command: SETUP_COMMAND }));
        return;
      }
      announce(`${t('prefs.accounts.fail.title')} ${after.failure?.detail ?? ''}`.trim());
    } else if (after.phase === 'code-refused') {
      announce(t('prefs.accounts.step2.refused'));
    } else if (after.phase === 'naming') {
      announce(t('prefs.accounts.step2.done'));
    } else if (after.phase === 'verifying' && open.kind === 'renew') {
      // Replacing needs no name: the check starts as soon as the sign-in is in.
      announce(t('prefs.accounts.step2.done'));
      void renewSignedIn(open.id);
    }
  };

  onPush.current = (next) => {
    const before = stateRef.current;
    apply(next);
    if (!before || switching.current) return;
    const took = tookOver(before.accounts, next.accounts, Date.now());
    if (took) say({ id: took.to.id, tone: 'ok', text: t('prefs.accounts.verdict.tookOver', { name: took.from.label }) });
  };

  // A link that has stood for three seconds is taken as whole, even
  // though Claude's prompt for the code was not seen.
  useEffect(() => {
    if (signIn.phase !== 'starting' || !signIn.url) return;
    const url = signIn.url;
    const timer = window.setTimeout(() => dispatch({ type: 'link-timeout', url }), LINK_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [signIn.phase, signIn.url, dispatch]);

  // PopBot opens the sign-in page itself — once per attempt, through the
  // window's own link path, so "Open it again" lands in the same browser.
  // Where the CLI has already opened one, a second would only confuse.
  const openedRun = useRef(0);
  useEffect(() => {
    if (signIn.phase !== 'waiting' || !signIn.autoOpen || signIn.pageOpened) return;
    if (signIn.cliOpensBrowser === null || !signIn.url || openedRun.current === signIn.run) return;
    openedRun.current = signIn.run;
    if (!signIn.cliOpensBrowser) window.open(signIn.url, '_blank');
    dispatch({ type: 'page-opened' });
  }, [signIn.phase, signIn.autoOpen, signIn.pageOpened, signIn.cliOpensBrowser, signIn.url, signIn.run, dispatch]);

  // ── Actions on a card ──────────────────────────────────────────────

  const switchTo = async (a: ClaudeAccountInfo): Promise<void> => {
    if (busy) return;
    setVerdict(null);
    setBusy({ kind: 'switch', id: a.id });
    switching.current = true;
    const r = await act(() => api.setActive(a.id));
    switching.current = false;
    if (!alive.current) return;
    setBusy(null);
    say(r.ok
      ? { id: a.id, tone: 'ok', text: t('prefs.accounts.verdict.switched') }
      : { id: a.id, tone: 'error', text: t('prefs.accounts.error.switch', { error: r.error }) });
    // Its button is gone with the switch; the card is where the result is.
    focusLater(`card:${a.id}`);
  };
  const rename = async (a: ClaudeAccountInfo, name: string): Promise<void> => {
    setVerdict(null);
    setBusy({ kind: 'rename', id: a.id });
    const r = await act(() => api.rename(a.id, name));
    if (!alive.current) return;
    setBusy(null);
    // The new name on the card is the confirmation; only a failure needs words.
    if (!r.ok) say({ id: a.id, tone: 'error', text: t('prefs.accounts.error.rename', { error: r.error }) });
  };
  const askRemove = (a: ClaudeAccountInfo): void => {
    removingRef.current = a;
    setRemoving(a);
  };
  const cancelRemove = (): void => {
    const a = removingRef.current;
    removingRef.current = null;
    setRemoving(null);
    if (a) focusLater(`remove:${a.id}`);
  };
  const confirmRemove = async (): Promise<void> => {
    // Read once: Enter on the dialog's focused button confirms twice over.
    const a = removingRef.current;
    if (!a) return;
    removingRef.current = null;
    setRemoving(null);
    setVerdict(null);
    setBusy({ kind: 'remove', id: a.id });
    const wasInUse = stateRef.current?.accounts.some((x) => x.id === a.id && x.active) ?? a.active;
    const r = await act(() => api.remove(a.id));
    if (!alive.current) return;
    setBusy(null);
    if (!r.ok) {
      say({ id: a.id, tone: 'error', text: t('prefs.accounts.error.remove', { error: r.error }) });
      return;
    }
    const heir = wasInUse ? inUse(r.accounts) : null;
    if (heir) {
      say({ id: heir.id, tone: 'ok', text: t('prefs.accounts.verdict.afterRemove', { name: a.label }) });
      focusLater(`card:${heir.id}`);
    } else {
      announce(t('prefs.accounts.verdict.removed', { name: a.label }));
      focusLater('add');
    }
  };
  const askStop = (): void => {
    stoppingRef.current = true;
    setStopping(true);
  };
  const cancelStop = (): void => {
    stoppingRef.current = false;
    setStopping(false);
    focusLater('stop');
  };
  const confirmStop = async (): Promise<void> => {
    if (!stoppingRef.current) return;
    stoppingRef.current = false;
    setStopping(false);
    setVerdict(null);
    setBusy({ kind: 'stop' });
    switching.current = true;
    const r = await act(() => api.setActive(null));
    switching.current = false;
    if (!alive.current) return;
    setBusy(null);
    if (r.ok) announce(t('prefs.accounts.lead.off'));
    else say({ id: FOOT, tone: 'error', text: t('prefs.accounts.error.stop', { error: r.error }) });
  };

  // ── What to show ───────────────────────────────────────────────────

  const accounts = state?.accounts ?? [];
  const active = inUse(accounts);
  const alert = state ? alertKind(state, now) : null;
  const alertText = !alert ? ''
    : alert.kind === 'noStore' ? t('prefs.accounts.alert.noStore')
      : t(`prefs.accounts.alert.${alert.kind}`, { name: alert.account.label, when: fmt.when('when', alert.until, now) });
  // An alert is read out when it first appears, not at every tick.
  const alertKey = !alert ? '' : alert.kind === 'noStore' ? alert.kind : `${alert.kind}:${alert.account.id}`;
  const alertTextRef = useRef(alertText);
  alertTextRef.current = alertText;
  useEffect(() => {
    if (alertKey) announce(alertTextRef.current);
  }, [alertKey, announce]);

  // With no accounts the pane is the first-run card, its button focused.
  const firstRun = !!state && accounts.length === 0 && state.encryptionAvailable && flow === null;
  useEffect(() => {
    if (firstRun) focusLater('add', true);
  }, [firstRun, focusLater]);

  // An account that is gone takes its open panel with it.
  const flowAccountId = flow && (flow.kind === 'renew' || flow.kind === 'token') ? flow.id : null;
  const flowAccountGone = !!state && flowAccountId !== null && !accounts.some((a) => a.id === flowAccountId);
  const closeFlowRef = useRef(closeFlow);
  closeFlowRef.current = closeFlow;
  useEffect(() => {
    if (flowAccountGone) closeFlowRef.current();
  }, [flowAccountGone]);

  const signInSteps = (account?: ClaudeAccountInfo): JSX.Element => (
    <SignInSteps
      signIn={signIn}
      accounts={accounts}
      account={account}
      onStart={openAdd}
      onRestart={() => requestSignIn({ type: 'restart' })}
      onClose={closeFlow}
      onHaveToken={(pasted) => openTokenForm(account?.id ?? null, pasted ? 'was-code' : undefined, pasted)}
      onPageOpened={() => dispatch({ type: 'page-opened' })}
      onLinkCopied={() => dispatch({ type: 'link-copied' })}
      onAdd={(name) => void addSignedIn(name)}
      onCheckAgain={checkAgain}
    />
  );
  const panelFor = (a: ClaudeAccountInfo): ReactNode => {
    if (flow?.kind === 'renew' && flow.id === a.id) return signInSteps(a);
    if (flow?.kind === 'token' && flow.id === a.id) {
      return (
        <ReplaceTokenPanel
          account={a}
          prefill={flow.prefill}
          note={flow.note}
          onApply={(token) => replaceToken(a.id, token)}
          onClose={closeFlow}
        />
      );
    }
    return null;
  };
  /** Below the cards: the open add flow, the first-run card, or the button. */
  const addArea = (): ReactNode => {
    if (!state) return null;
    if (flow?.kind === 'add' || firstRun) {
      return (
        <div className={`host-card acct-card${accounts.length === 0 ? ' acct-first' : ''}`}>{signInSteps()}</div>
      );
    }
    if (flow?.kind === 'add-token') {
      return (
        <div className={`host-card acct-card${accounts.length === 0 ? ' acct-first' : ''}`}>
          <AddWithTokenForm
            accounts={accounts}
            prefill={flow.prefill}
            note={flow.note}
            onAdd={addWithToken}
            onClose={closeFlow}
            onUseBrowser={() => {
              // With no accounts yet, back to the first-run card; its
              // button starts the sign-in.
              if (accounts.length === 0) setFlow(null);
              else openAdd();
            }}
          />
        </div>
      );
    }
    // Without an encrypted store a new sign-in has nowhere to be kept, so
    // there is no way to start one; while a panel is open, no second one.
    if (flow !== null || !state.encryptionAvailable) return null;
    return (
      <div className="acct-add">
        <button type="button" className="btn sm" data-focus="add" onClick={openAdd}>
          <i className="fa-solid fa-plus" aria-hidden /> {t('prefs.accounts.add.button')}
        </button>
      </div>
    );
  };
  const removeMessage = (a: ClaudeAccountInfo): string => {
    const view = removeView(accounts, a.id, now);
    switch (view.kind) {
      case 'inUse': return t('prefs.accounts.remove.inUse', { name: a.label, next: view.next.label });
      case 'only': return t('prefs.accounts.remove.only', { name: a.label });
      case 'other': return t('prefs.accounts.remove.other', { name: a.label, active: view.active.label });
      default: return t('prefs.accounts.remove.off', { name: a.label });
    }
  };

  return (
    <div className="pref-section acct-pane" ref={paneRef}>
      <h3>{t('prefs.accounts.title')}</h3>
      {/* Nothing but the title until main has answered: the first-run
          card must never flash for someone who has accounts. */}
      {state && (
        <>
          <p className="pref-section-desc acct-lead">
            {rich(t, `prefs.accounts.lead.${leadKind(state, now)}`, {}, { name: <strong>{active?.label ?? ''}</strong> })}
          </p>
          {alert && (
            <div className={`${alert.kind === 'noStore' ? 'pref-error' : 'pref-warn'} acct-alert`}>
              <i className={`fa-solid ${alert.kind === 'noStore' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'}`} aria-hidden />
              <span>{alertText}</span>
            </div>
          )}
          {accounts.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              accounts={accounts}
              view={cardView(a, accounts, now, state.encryptionAvailable)}
              now={now}
              flowOpen={flow !== null}
              panel={panelFor(a)}
              verdict={verdict?.id === a.id ? verdict : null}
              switching={busy?.kind === 'switch'}
              switchingHere={busy?.kind === 'switch' && busy.id === a.id}
              onUse={() => void switchTo(a)}
              onRename={(name) => void rename(a, name)}
              onSignInAgain={() => openRenew(a.id)}
              onPasteToken={() => openTokenForm(a.id)}
              onRemove={() => askRemove(a)}
            />
          ))}
          {addArea()}
          <div className="acct-foot">
            {/* Only a host that answered but can't take accounts is named;
                one that is merely off gets them when it is back. */}
            {(state.outdatedHosts ?? []).map((host) => (
              <Note key={host} tone="wait">{t('prefs.accounts.hosts.outdated', { host })}</Note>
            ))}
            {accounts.length === 0 && state.encryptionAvailable && <div>{t('prefs.accounts.add.before')}</div>}
            <div>
              {accounts.length >= 2 && active ? `${t('prefs.accounts.foot.switch')} ` : ''}
              {t('prefs.accounts.foot.scope')}
            </div>
            {active && (
              <div className="acct-foot-row">
                <span>{t('prefs.accounts.off.prompt')}</span>
                <button type="button" className="btn sm ghost" data-focus="stop" onClick={askStop}>
                  {t('prefs.accounts.off.action')}
                </button>
              </div>
            )}
            {verdict?.id === FOOT && <VerdictLine verdict={verdict} />}
          </div>
        </>
      )}
      <div className="acct-sr" role="status" aria-live="polite">{live}</div>
      {removing && (
        <ConfirmDialog
          title={t('prefs.accounts.remove.title')}
          message={removeMessage(removing)}
          confirmLabel={t('prefs.accounts.remove')}
          destructive
          onConfirm={() => void confirmRemove()}
          onCancel={cancelRemove}
        />
      )}
      {stopping && (
        <ConfirmDialog
          title={t('prefs.accounts.off.title')}
          message={t('prefs.accounts.off.body')}
          confirmLabel={t('prefs.accounts.off.action')}
          onConfirm={() => void confirmStop()}
          onCancel={cancelStop}
        />
      )}
    </div>
  );
}

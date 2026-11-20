import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  CodexAccountInfo,
  CodexAccountsFailure,
  CodexAccountsResult,
  CodexAccountsState,
  CodexSignInEvent,
} from '@shared/ipc';
import { useTranslation } from '../lib/i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { accountNamed, addedVerdict, nameProblem, newAccountIn, tookOver } from '../lib/claudeAccountsView';
import {
  CODEX_SIGN_IN_IDLE,
  accountWithEmail,
  alertKind,
  cardView,
  inUse,
  leadKind,
  needsAttention,
  removeView,
  saveFailure,
  signInReducer,
  signInRunning,
  signedInLine,
  suggestedName,
  type CodexCardView,
  type CodexSignInAction,
  type CodexSignInMode,
  type CodexSignInState,
  type CodexSignInVia,
} from '../lib/codexAccountsView';
import {
  Caution,
  CloseButton,
  FOOT,
  Note,
  RenameField,
  Step,
  TICK_MS,
  VerdictLine,
  errorText,
  focusIsFree,
  rich,
  useCopied,
  useFormats,
  useNow,
  type Translate,
  type Verdict,
} from './PrefsClaudeAccounts';

/**
 * The Codex accounts as main reports them, kept current while mounted:
 * one `list()` and then every push. Null until the first answer, so a
 * caller can tell "not known yet" from "no accounts".
 */
export function useCodexAccountsState(): CodexAccountsState | null {
  const [state, setState] = useState<CodexAccountsState | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.popbot.codexAccounts.list().then((s) => { if (!cancelled) setState(s); }).catch(() => {});
    const off = window.popbot.codexAccounts.onChanged((s) => setState(s));
    return () => { cancelled = true; off(); };
  }, []);
  return state;
}

/** Whether the Preferences nav item shows its attention mark. */
export function useCodexAccountsAttention(): boolean {
  return needsAttention(useCodexAccountsState(), useNow());
}

// ── The pane ─────────────────────────────────────────────────────────

/** The one thing open in the pane besides the cards, if any: a ChatGPT
 *  sign-in for a new account, or to replace this account's sign-in. */
type Flow = null | { kind: 'add' } | { kind: 'renew'; id: string };

type Busy = null | { kind: 'switch' | 'remove' | 'rename' | 'stop'; id?: string };

/** What an accounts request came to, without the state it also carried. */
type Outcome =
  | { ok: true; accounts: CodexAccountInfo[] }
  | { ok: false; reason: CodexAccountsFailure; error: string };

/** Counts sign-in starts across every pane there has been, so a late
 *  answer can tell whether a newer sign-in has replaced its own. */
let lastSignInStart = 0;

/**
 * The sign-in state with a dispatch that hands back the state it made:
 * main's events and the answers to requests arrive outside React's
 * render, and each has to act on what the one before it did.
 */
function useSignIn(): [CodexSignInState, (action: CodexSignInAction) => CodexSignInState, { current: CodexSignInState }] {
  const [state, setState] = useState<CodexSignInState>(CODEX_SIGN_IN_IDLE);
  const ref = useRef<CodexSignInState>(CODEX_SIGN_IN_IDLE);
  const dispatch = useCallback((action: CodexSignInAction): CodexSignInState => {
    const next = signInReducer(ref.current, action);
    ref.current = next;
    setState(next);
    return next;
  }, []);
  return [state, dispatch, ref];
}

/** "Signed in as first@example.com · Pro", however much of it is known. */
function whoLine(t: Translate, who: { email: string | null; plan: string | null }): string {
  const line = signedInLine(who);
  return t(`prefs.codexAccounts.signedIn.${line.key}`, line.vars);
}

// ── The sign-in panel ────────────────────────────────────────────────

interface SignInPanelProps {
  signIn: CodexSignInState;
  /** How this panel words itself: the first account, another one, or a
   *  new sign-in for `account`. */
  mode: CodexSignInMode;
  accounts: CodexAccountInfo[];
  /** The account whose sign-in is being replaced (mode `renew`). */
  account?: CodexAccountInfo;
  /** Whether the panel can be closed (the first-run card can't: it is the pane). */
  closable: boolean;
  /** Begin, or begin again: PopBot opens the page, or hands over the link. */
  onStart: (via: CodexSignInVia) => void;
  /** Stop the attempt under way and go back to the two ways to begin. */
  onCancel: () => void;
  onClose: () => void;
  onLinkCopied: () => void;
  /** Add the signed-in account under this name. */
  onAdd: (name: string) => void;
  /** Save the sign-in main still holds once more (after a failure that was not about the sign-in). */
  onSaveAgain: (name: string) => void;
}

/**
 * A ChatGPT sign-in, step by step: used by the add card and by a card's
 * "Sign in again" panel. There is nothing to paste — the browser signs in
 * and hands Codex the result — so the panel's whole job is to get the
 * right ChatGPT account into the browser, wait, and then name it. It
 * shows what the sign-in state says and owns only the name being typed.
 */
function SignInPanel(props: SignInPanelProps): JSX.Element {
  const { signIn, mode, accounts, account } = props;
  const { t } = useTranslation();
  const fmt = useFormats();
  const { phase, url, who } = signIn;
  const renew = mode === 'renew';
  const whoName = account?.label ?? '';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const [name, setName] = useState('');
  const [nameNote, setNameNote] = useState<string | null>(null);
  const [copied, copy] = useCopied();
  const ids = useId();
  const nameTitleId = `${ids}name`;
  const nameNoteId = `${ids}name-note`;
  const now = Date.now();

  /** Take focus only when nobody else in the pane holds it. */
  const focusIfFree = useCallback((el: HTMLElement | null): void => {
    if (el && focusIsFree(rootRef.current)) el.focus();
  }, []);

  // Signed in: the name starts as the email, which is how the user knows
  // the account — once per attempt, so what they then type is kept.
  const namedRun = useRef(0);
  useEffect(() => {
    if (phase !== 'signed-in' || namedRun.current === signIn.run) return;
    namedRun.current = signIn.run;
    setName(suggestedName(who?.email ?? null, accounts));
    setNameNote(null);
  }, [phase, signIn.run, who, accounts]);

  useEffect(() => {
    if (phase === 'signed-in') {
      focusIfFree(nameRef.current);
      nameRef.current?.select();
    }
    if (phase === 'duplicate' || phase === 'save-failed' || phase === 'failed') focusIfFree(actionRef.current);
  }, [phase, focusIfFree]);

  // The link handed over but not yet on the clipboard: copying it is the
  // next thing to do.
  const linkToCopy = phase === 'waiting' && signIn.via === 'copy' && !signIn.linkCopied;
  useEffect(() => {
    if (linkToCopy) focusIfFree(copyRef.current);
  }, [linkToCopy, focusIfFree]);

  const copyLink = async (): Promise<void> => {
    if (url && (await copy(url))) props.onLinkCopied();
  };
  const openLink = (): void => {
    // The window's own link path, so it lands in the preferred browser.
    if (url) window.open(url, '_blank');
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
    ? t('prefs.accounts.renew.title', { name: whoName })
    : mode === 'another' ? t('prefs.codexAccounts.add.titleAnother') : t('prefs.codexAccounts.add.title');
  const closeLabel = renew ? t('prefs.accounts.flow.close', { name: whoName }) : t('prefs.accounts.add.close');
  const stepOneTitle = renew
    ? t('prefs.accounts.step1.titleRenew', { name: whoName })
    : mode === 'another' ? t('prefs.accounts.step1.titleAnother') : t('prefs.accounts.step1.title');

  /** The trap, said before anything is opened: the page signs in as
   *  whichever ChatGPT account the browser is already on. */
  const trap = (): ReactNode => {
    if (renew) return <Caution>{t('prefs.codexAccounts.start.trapRenew', { name: whoName })}</Caution>;
    if (mode === 'another') {
      return (
        <Caution>
          {accounts.length === 1
            ? t('prefs.codexAccounts.start.trapNamed', { name: accounts[0].label })
            : t('prefs.codexAccounts.start.trap')}
        </Caution>
      );
    }
    return <div>{t('prefs.codexAccounts.start.hint')}</div>;
  };
  /** The two ways to begin. `prefer` is the one offered first. */
  const startButtons = (prefer: CodexSignInVia, again: boolean): ReactNode => {
    const open = (
      <button
        key="open"
        ref={prefer === 'open' ? actionRef : undefined}
        type="button"
        className={`btn sm${prefer === 'open' ? ' primary' : ''}`}
        data-focus={prefer === 'open' && !again ? 'add' : undefined}
        onClick={() => props.onStart('open')}
      >
        <i className="fa-solid fa-arrow-up-right-from-square" aria-hidden />{' '}
        {again ? t('prefs.codexAccounts.again.open') : t('prefs.codexAccounts.start.open')}
      </button>
    );
    const link = (
      <button
        key="copy"
        ref={prefer === 'copy' ? actionRef : undefined}
        type="button"
        className={`btn sm${prefer === 'copy' ? ' primary' : ''}`}
        onClick={() => props.onStart('copy')}
      >
        <i className="fa-solid fa-copy" aria-hidden />{' '}
        {again ? t('prefs.codexAccounts.again.copy') : t('prefs.codexAccounts.start.copy')}
      </button>
    );
    return <div className="acct-btns">{prefer === 'open' ? [open, link] : [link, open]}</div>;
  };
  const waiting = (
    <>
      <Note tone="busy">{t('prefs.codexAccounts.wait.waiting')}</Note>
      <div>{t('prefs.codexAccounts.wait.auto')}</div>
      <div className="acct-btns">
        <button type="button" className="btn sm" onClick={props.onCancel}>{t('prefs.codexAccounts.wait.cancel')}</button>
      </div>
    </>
  );

  const stepOneBody = (): ReactNode => {
    if (phase === 'idle') {
      return (
        <>
          {trap()}
          {startButtons('open', false)}
        </>
      );
    }
    if (phase === 'starting') {
      return (
        <>
          <Note tone="busy">
            {signIn.via === 'copy' ? t('prefs.codexAccounts.wait.getLink') : t('prefs.accounts.step1.getting')}
          </Note>
          <div className="acct-btns">
            <button type="button" className="btn sm" onClick={props.onCancel}>{t('prefs.codexAccounts.wait.cancel')}</button>
          </div>
        </>
      );
    }
    if (phase !== 'waiting') return null;
    if (signIn.via === 'copy') {
      const said = signIn.linkCopied
        ? (renew ? t('prefs.codexAccounts.wait.copiedRenew', { name: whoName }) : t('prefs.codexAccounts.wait.copied'))
        : (renew ? t('prefs.codexAccounts.wait.linkReadyRenew', { name: whoName }) : t('prefs.codexAccounts.wait.linkReady'));
      return (
        <>
          <div>{said}</div>
          <div className="acct-btns">
            <button ref={copyRef} type="button" className={`btn sm${signIn.linkCopied ? '' : ' primary'}`} onClick={() => void copyLink()}>
              <i className="fa-solid fa-copy" aria-hidden /> {copied ? t('prefs.accounts.step1.copied') : t('prefs.accounts.step1.copyLink')}
            </button>
            <button type="button" className="btn sm" onClick={openLink}>
              <i className="fa-solid fa-arrow-up-right-from-square" aria-hidden /> {t('prefs.accounts.step1.open')}
            </button>
          </div>
          {waiting}
        </>
      );
    }
    return (
      <>
        <div>
          {renew ? t('prefs.codexAccounts.wait.openedRenew', { name: whoName }) : t('prefs.codexAccounts.wait.opened')}
        </div>
        <div>
          {t('prefs.accounts.step1.notOpened')}{' '}
          <button type="button" className="acct-link" onClick={openLink}>{t('prefs.accounts.step1.openAgain')}</button>
          {' · '}
          <button type="button" className="acct-link" onClick={() => void copyLink()}>
            {copied ? t('prefs.accounts.step1.copied') : t('prefs.accounts.step1.copyLink')}
          </button>
        </div>
        {waiting}
      </>
    );
  };

  const steps = (): ReactNode => {
    if (phase === 'failed') {
      const failure = signIn.failure;
      const via = signIn.via ?? 'open';
      return (
        <Step n={1} status="failed" title={t(failure?.where === 'start' ? 'prefs.accounts.fail.start' : 'prefs.accounts.fail.title')}>
          {failure?.detail && <div className="acct-detail">{failure.detail}</div>}
          <div className="acct-btns">
            <button ref={actionRef} type="button" className="btn sm primary" onClick={() => props.onStart(via)}>
              {t('prefs.codexAccounts.again.plain')}
            </button>
            <button type="button" className="btn sm" onClick={() => props.onStart(via === 'open' ? 'copy' : 'open')}>
              {via === 'open' ? t('prefs.codexAccounts.start.copy') : t('prefs.codexAccounts.start.open')}
            </button>
          </div>
        </Step>
      );
    }
    if (phase === 'duplicate') {
      const twin = accounts.find((a) => a.id === who?.duplicateOf) ?? accountWithEmail(who?.email ?? null, accounts);
      // An account still named by its email would be said twice over.
      const sameName = !!twin && !!who?.email && twin.label.trim().toLowerCase() === who.email.trim().toLowerCase();
      const body = !twin
        ? t('prefs.codexAccounts.duplicate.bodyUnnamed')
        : !who?.email
          ? t('prefs.codexAccounts.duplicate.bodyNoEmail', { name: twin.label })
          : sameName
            ? t('prefs.codexAccounts.duplicate.bodySame', { email: who.email })
            : t('prefs.codexAccounts.duplicate.body', { email: who.email, name: twin.label });
      return (
        <Step n={1} status="failed" title={t('prefs.codexAccounts.duplicate.title')}>
          <div>{body}</div>
          <div>{t('prefs.codexAccounts.duplicate.how')}</div>
          {/* The page just signed in as the wrong account, so the link —
              to be opened somewhere else — is the way offered first. */}
          {startButtons('copy', true)}
        </Step>
      );
    }
    if (phase === 'signed-in' || phase === 'saving' || phase === 'save-failed') {
      const saving = phase === 'saving';
      const failed = phase === 'save-failed' && signIn.save ? signIn.save : null;
      const ways = failed ? saveFailure(failed.reason) : null;
      const signedInTitle = who ? whoLine(t, who) : t('prefs.codexAccounts.signedIn.bare');
      const mismatchDetail = (): string => {
        const want = account?.email ?? account?.label ?? '';
        return who?.email && want
          ? t('prefs.codexAccounts.save.mismatchDetail', { got: who.email, want })
          : t('prefs.codexAccounts.save.mismatchBare', { name: whoName });
      };
      return (
        <>
          <Step n={1} status="done" title={signedInTitle}>
            {renew && saving ? <Note tone="busy">{t('prefs.codexAccounts.saving.renew', { name: whoName })}</Note> : null}
          </Step>
          {!renew && !failed && (
            <Step n={2} status="current" title={t('prefs.accounts.step3.title')} titleId={nameTitleId}>
              <div className="acct-btns">
                <input
                  ref={nameRef}
                  className="pref-input narrow"
                  style={{ width: 300 }}
                  placeholder={t('prefs.accounts.step3.placeholder')}
                  aria-labelledby={nameTitleId}
                  aria-describedby={nameNote ? nameNoteId : undefined}
                  disabled={saving}
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
                <button type="button" className="btn sm primary" disabled={saving} onClick={submitName}>
                  {saving && <i className="fa-solid fa-spinner fa-spin" aria-hidden />}
                  {t('prefs.accounts.step3.add')}
                </button>
              </div>
              {nameNote && <Note tone="error" id={nameNoteId}>{nameNote}</Note>}
              {saving
                ? <Note tone="busy">{t('prefs.codexAccounts.saving.add', { name: name.trim() })}</Note>
                : <div>{who?.email ? t('prefs.codexAccounts.name.hint') : t('prefs.codexAccounts.name.hintNoEmail')}</div>}
              {/* Signed in, but with nothing left to run on for now: it is
                  added all the same, and the card will say until when. */}
              {!saving && who?.outOfUsageUntil != null && who.outOfUsageUntil > now && (
                <Note tone="wait">
                  {t('prefs.codexAccounts.signedIn.out', { until: fmt.when('until', who.outOfUsageUntil, now) })}
                </Note>
              )}
            </Step>
          )}
          {failed && ways && (
            <Step n={2} status="failed" title={t(`prefs.codexAccounts.save.${ways.headline}`)}>
              {failed.reason === 'mismatch' && <div>{mismatchDetail()}</div>}
              <div>{renew ? t('prefs.accounts.check.oldKept') : t('prefs.accounts.check.nothingSaved')}</div>
              {failed.reason !== 'mismatch' && failed.error && <div className="acct-detail">{failed.error}</div>}
              {ways.again && (
                <div className="acct-btns">
                  {/* The sign-in is still held in main: only the save repeats. */}
                  <button ref={actionRef} type="button" className="btn sm primary" onClick={() => props.onSaveAgain(name.trim())}>
                    {t('prefs.codexAccounts.save.again')}
                  </button>
                </div>
              )}
              {ways.signIn && !ways.again && startButtons(failed.reason === 'mismatch' ? 'copy' : 'open', true)}
            </Step>
          )}
        </>
      );
    }
    // Step 1 holds the buttons from the start, so it is the current step
    // even before anything has been pressed.
    return (
      <>
        <Step n={1} status="current" title={stepOneTitle}>{stepOneBody()}</Step>
        {!renew && <Step n={2} status="todo" title={t('prefs.accounts.step3.title')} />}
      </>
    );
  };

  return (
    <div className="acct-flow" ref={rootRef}>
      <div className="acct-flow-head">
        <span className="acct-flow-title">{title}</span>
        {/* A save can't be aborted, so nothing may claim to discard it. */}
        {props.closable && phase !== 'saving' && <CloseButton label={closeLabel} onClick={props.onClose} />}
      </div>
      {phase === 'idle' && <div className="acct-flow-sub">{t('prefs.codexAccounts.add.sub')}</div>}
      <ol className="acct-steps">{steps()}</ol>
    </div>
  );
}

// ── One card ─────────────────────────────────────────────────────────

interface AccountCardProps {
  account: CodexAccountInfo;
  accounts: CodexAccountInfo[];
  view: CodexCardView;
  now: number;
  /** A sign-in panel is open somewhere in the pane. */
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

  const until = (): string => fmt.when('until', account.outOfUsageUntil ?? now, now);
  const status = (): string => {
    switch (view.status) {
      case 'saved': return t('prefs.codexAccounts.status.saved', { date: fmt.saved(account.addedAt) });
      case 'next': return t('prefs.accounts.status.next', { name: inUse(accounts)?.label ?? '' });
      case 'out': return t('prefs.accounts.status.out', { until: until() });
      case 'outInUse': return t('prefs.accounts.status.outInUse', { until: until() });
      case 'signIn': return t('prefs.codexAccounts.status.signIn');
      case 'signInInUse': return t('prefs.codexAccounts.status.signInInUse');
      case 'unreadableNoStore': return t('prefs.accounts.status.unreadableNoStore');
      default: return t('prefs.accounts.status.unreadable');
    }
  };
  const statusIcon = view.tone === 'error' ? 'fa-circle-exclamation' : view.tone === 'wait' ? 'fa-hourglass-half' : null;
  const statePill = view.statePill === 'signIn' ? t('prefs.codexAccounts.pill.signIn')
    : view.statePill === 'out' ? t('prefs.accounts.pill.out')
      : view.statePill === 'unreadable' ? t('prefs.accounts.pill.unreadable') : null;
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
        {/* Renamed: the email still says which ChatGPT account it is. */}
        {!editing && view.email && <span className="acct-email" title={view.email}>{view.email}</span>}
        {view.plan && <span className="pill muted acct-plan">{view.plan}</span>}
        {view.inUse && <span className="pill done">{t('prefs.accounts.pill.inUse')}</span>}
        {view.nextUp && <span className="pill muted">{t('prefs.accounts.pill.next')}</span>}
        {statePill && <span className={`pill ${view.statePill === 'out' ? 'wait' : 'err'}`}>{statePill}</span>}
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
            title={t('prefs.accounts.use.waits', { until: until() })}
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
              <button
                type="button"
                className={`btn sm ${view.signInPrimary ? 'primary' : 'ghost'}`}
                data-focus={`renew:${account.id}`}
                aria-label={t('prefs.accounts.signInAgain.label', { name })}
                onClick={props.onSignInAgain}
              >
                {t('prefs.accounts.signInAgain')}
              </button>
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

// ── The pane itself ──────────────────────────────────────────────────

/**
 * Preferences > Codex accounts: the ChatGPT sign-ins PopBot runs Codex
 * chats on, which one is in use, and the ways to add, renew, switch and
 * remove them. What each state shows is decided in
 * lib/codexAccountsView.ts; this file wires those decisions to main.
 * Built from the same pieces as the Claude accounts pane
 * (PrefsClaudeAccounts.tsx), which it sits beside.
 */
export function PrefsCodexAccounts(): JSX.Element {
  const { t } = useTranslation();
  const fmt = useFormats();
  const api = window.popbot.codexAccounts;
  const [state, setState] = useState<CodexAccountsState | null>(null);
  const stateRef = useRef<CodexAccountsState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [flow, setFlowState] = useState<Flow>(null);
  const flowRef = useRef<Flow>(null);
  const [signIn, dispatch, signInRef] = useSignIn();
  const [busy, setBusy] = useState<Busy>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [removing, setRemoving] = useState<CodexAccountInfo | null>(null);
  const removingRef = useRef<CodexAccountInfo | null>(null);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [live, setLive] = useState('');
  const [focusAsk, setFocusAsk] = useState<{ key: string; force: boolean; n: number } | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  // True while a switch the user asked for is in flight: the state main
  // pushes then is that switch, not PopBot moving chats by itself.
  const switching = useRef(false);

  const apply = useCallback((next: CodexAccountsState): void => {
    // A result carries more than the state (ok, error): keep only the state.
    const clean: CodexAccountsState = {
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
    setLive((prev) => (prev === text ? `${text} ` : text));
  }, []);
  /** Put a verdict on its card. It stays until the next action in the
   *  pane — never a timer. */
  const say = (next: Verdict): void => {
    setVerdict(next);
    announce(next.text);
  };
  /** Move focus to the element marked `data-focus={key}` once it is on the
   *  page. Unless forced, only when nothing else holds focus. */
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
  const onPush = useRef<(next: CodexAccountsState) => void>(() => {});
  const onSignInEvent = useRef<(event: CodexSignInEvent) => void>(() => {});

  // The accounts: read on mount and whenever the window is back in front
  // (which is also the moment the user returns from signing in), pushed
  // by main in between. No polling.
  useEffect(() => {
    const main = window.popbot.codexAccounts;
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
      // Leaving with a sign-in open drops it; nothing was saved. A save
      // already in flight is left to finish in main.
      if (flowRef.current && signInRunning(signInRef.current)) void main.signInCancel();
    };
  }, [apply, signInRef]);

  // The clock: an out-of-usage time that has passed turns its card back
  // into a normal one with nobody pressing anything.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  /** Run one accounts request. Whatever it answers also carries the new state. */
  const act = async (call: () => Promise<CodexAccountsResult>): Promise<Outcome> => {
    try {
      const r = await call();
      if (alive.current) apply(r);
      return r.ok ? { ok: true, accounts: r.accounts } : { ok: false, reason: r.reason ?? 'other', error: r.error };
    } catch (err) {
      return { ok: false, reason: 'other', error: errorText(err) };
    }
  };

  // ── The sign-in ────────────────────────────────────────────────────

  /** Put the link on the clipboard without a click of its own. It can be
   *  refused (the click that asked for it is by then a moment old); the
   *  panel's Copy button is there for that. */
  const copyQuietly = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return;
    }
    if (!alive.current || signInRef.current.url !== url) return;
    dispatch({ type: 'link-copied' });
    announce(t('prefs.accounts.step1.copied'));
  };

  /** Ask main for a ChatGPT sign-in: the first try of a flow, or another. */
  const startSignIn = (via: CodexSignInVia): void => {
    setVerdict(null);
    const before = signInRef.current;
    const started = dispatch({ type: 'start', via });
    if (started === before) return;
    const { run } = started;
    lastSignInStart += 1;
    const mine = lastSignInStart;
    const answered = (answer: { ok: true } | { ok: false; error: string }): void => {
      const current = signInRef.current;
      if (!alive.current || current.run !== run || current.phase === 'idle') {
        // Closed or cancelled before main had got as far as starting it:
        // the cancel sent then found nothing to stop, so stop it now —
        // unless a newer sign-in has taken its place.
        if (answer.ok && mine === lastSignInStart) void api.signInCancel();
        return;
      }
      const after = dispatch({ type: 'start-answer', run, answer });
      if (!answer.ok && after.phase === 'failed') announce(`${t('prefs.accounts.fail.start')} ${answer.error}`);
    };
    api.signInStart({ openBrowser: via === 'open' }).then(answered, (err: unknown) => answered({ ok: false, error: errorText(err) }));
  };
  /** Begin from the first-run card or an open panel. */
  const begin = (via: CodexSignInVia): void => {
    if (!flowRef.current) {
      setFlow({ kind: 'add' });
      dispatch({ type: 'open', mode: (stateRef.current?.accounts.length ?? 0) === 0 ? 'first' : 'another' });
    }
    startSignIn(via);
  };
  const openAdd = (): void => {
    setVerdict(null);
    setFlow({ kind: 'add' });
    dispatch({ type: 'open', mode: (stateRef.current?.accounts.length ?? 0) === 0 ? 'first' : 'another' });
  };
  const openRenew = (id: string): void => {
    setVerdict(null);
    setFlow({ kind: 'renew', id });
    dispatch({ type: 'open', mode: 'renew' });
  };
  /** Stop the attempt under way; the panel goes back to its start. */
  const cancelAttempt = (): void => {
    if (signInRunning(signInRef.current)) void api.signInCancel();
    dispatch({ type: 'open', mode: signInRef.current.mode });
  };
  const closeFlow = (): void => {
    const open = flowRef.current;
    if (!open) return;
    if (signInRunning(signInRef.current)) void api.signInCancel();
    dispatch({ type: 'close' });
    setFlow(null);
    focusLater(open.kind === 'renew' ? `renew:${open.id}` : 'add');
  };

  const finishAdd = (before: CodexAccountInfo[], after: CodexAccountInfo[]): void => {
    dispatch({ type: 'close' });
    setFlow(null);
    const added = newAccountIn(before, after) as CodexAccountInfo | null;
    if (!added) return;
    const kind = addedVerdict(added, Date.now());
    say({
      id: added.id,
      tone: 'ok',
      text: kind === 'addedInUse' ? t('prefs.codexAccounts.verdict.addedInUse') : t(`prefs.accounts.verdict.${kind}`),
    });
    focusLater(`card:${added.id}`);
  };
  const saveFailed = (reason: CodexAccountsFailure, error: string, keeps: 'nothing' | 'old'): void => {
    const after = dispatch({ type: 'save-failed', reason, error });
    if (after.phase === 'duplicate') {
      announce(t('prefs.codexAccounts.duplicate.title'));
      return;
    }
    const kept = keeps === 'old' ? t('prefs.accounts.check.oldKept') : t('prefs.accounts.check.nothingSaved');
    announce(`${t(`prefs.codexAccounts.save.${saveFailure(reason).headline}`)} ${kept}`);
  };
  /** Save the sign-in main holds as a new account. The reducer is already
   *  in `saving` when this runs. */
  const addSignedIn = async (name: string): Promise<void> => {
    const before = stateRef.current?.accounts ?? [];
    const r = await act(() => api.addSignedIn(name));
    if (!alive.current) return;
    if (r.ok) finishAdd(before, r.accounts);
    else saveFailed(r.reason, r.error, 'nothing');
  };
  /** Save the sign-in main holds as this account's. */
  const renewSignedIn = async (id: string): Promise<void> => {
    const r = await act(() => api.renewSignedIn(id));
    if (!alive.current) return;
    if (!r.ok) {
      saveFailed(r.reason, r.error, 'old');
      return;
    }
    dispatch({ type: 'close' });
    setFlow(null);
    const inUseNow = r.accounts.some((a) => a.id === id && a.active);
    say({ id, tone: 'ok', text: t(inUseNow ? 'prefs.codexAccounts.verdict.renewedInUse' : 'prefs.codexAccounts.verdict.renewed') });
    focusLater(`renew:${id}`);
  };
  /** The name is in (or the save is being repeated): save what main holds. */
  const save = (name: string): void => {
    const open = flowRef.current;
    if (!open) return;
    setVerdict(null);
    const was = signInRef.current;
    if (dispatch({ type: 'save' }) === was) return;
    if (open.kind === 'renew') void renewSignedIn(open.id);
    else void addSignedIn(name);
  };

  onSignInEvent.current = (event) => {
    const open = flowRef.current;
    if (!open) return;
    const before = signInRef.current;
    const after = dispatch({ type: 'event', event });
    if (after === before) return;
    if (event.type === 'url') {
      // Asked for the link rather than the page: it goes on the clipboard.
      if (after.via === 'copy') void copyQuietly(event.url);
      return;
    }
    if (after.phase === 'failed') {
      announce(`${t('prefs.accounts.fail.title')} ${after.failure?.detail ?? ''}`.trim());
    } else if (after.phase === 'duplicate') {
      announce(t('prefs.codexAccounts.duplicate.title'));
    } else if (after.phase === 'signed-in') {
      announce(after.who ? whoLine(t, after.who) : t('prefs.codexAccounts.signedIn.bare'));
    } else if (after.phase === 'saving' && open.kind === 'renew') {
      // Replacing needs no name: the save starts as soon as the sign-in is in.
      announce(after.who ? whoLine(t, after.who) : t('prefs.codexAccounts.signedIn.bare'));
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

  // ── Actions on a card ──────────────────────────────────────────────

  const switchTo = async (a: CodexAccountInfo): Promise<void> => {
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
  const rename = async (a: CodexAccountInfo, name: string): Promise<void> => {
    setVerdict(null);
    setBusy({ kind: 'rename', id: a.id });
    const r = await act(() => api.rename(a.id, name));
    if (!alive.current) return;
    setBusy(null);
    // The new name on the card is the confirmation; only a failure needs words.
    if (!r.ok) say({ id: a.id, tone: 'error', text: t('prefs.accounts.error.rename', { error: r.error }) });
  };
  const askRemove = (a: CodexAccountInfo): void => {
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
    if (r.ok) announce(t('prefs.codexAccounts.lead.off'));
    else say({ id: FOOT, tone: 'error', text: t('prefs.accounts.error.stop', { error: r.error }) });
  };

  // ── What to show ───────────────────────────────────────────────────

  const accounts = state?.accounts ?? [];
  const active = inUse(accounts);
  const alert = state ? alertKind(state, now) : null;
  const alertText = !alert ? ''
    : alert.kind === 'noStore' ? t('prefs.codexAccounts.alert.noStore')
      : alert.kind === 'signIn'
        ? t(alert.other ? 'prefs.codexAccounts.alert.signInOther' : 'prefs.codexAccounts.alert.signIn', { name: alert.account.label })
        : t(`prefs.codexAccounts.alert.${alert.kind}`, { name: alert.account.label, when: fmt.when('when', alert.until, now) });
  // An alert is read out when it first appears, not at every tick.
  const alertKey = !alert ? '' : alert.kind === 'noStore' ? alert.kind : `${alert.kind}:${alert.account.id}`;
  const alertTextRef = useRef(alertText);
  alertTextRef.current = alertText;
  useEffect(() => {
    if (alertKey) announce(alertTextRef.current);
  }, [alertKey, announce]);

  // With no accounts the pane is the first-run card, its button focused.
  const firstRun = !!state && accounts.length === 0 && state.encryptionAvailable;
  const firstRunIdle = firstRun && flow === null;
  useEffect(() => {
    if (firstRunIdle) focusLater('add', true);
  }, [firstRunIdle, focusLater]);

  // An account that is gone takes its open panel with it.
  const flowAccountId = flow?.kind === 'renew' ? flow.id : null;
  const flowAccountGone = !!state && flowAccountId !== null && !accounts.some((a) => a.id === flowAccountId);
  const closeFlowRef = useRef(closeFlow);
  closeFlowRef.current = closeFlow;
  useEffect(() => {
    if (flowAccountGone) closeFlowRef.current();
  }, [flowAccountGone]);

  const panel = (mode: CodexSignInMode, account?: CodexAccountInfo): JSX.Element => (
    <SignInPanel
      // Before the first-run card is used, the reducer may still hold what
      // a closed panel left: show the card as the fresh start it is.
      signIn={flow === null ? CODEX_SIGN_IN_IDLE : signIn}
      mode={mode}
      accounts={accounts}
      account={account}
      closable={!firstRun}
      onStart={begin}
      onCancel={cancelAttempt}
      onClose={closeFlow}
      onLinkCopied={() => dispatch({ type: 'link-copied' })}
      onAdd={save}
      onSaveAgain={save}
    />
  );
  const panelFor = (a: CodexAccountInfo): ReactNode =>
    (flow?.kind === 'renew' && flow.id === a.id ? panel('renew', a) : null);
  /** Below the cards: the open add flow, the first-run card, or the button. */
  const addArea = (): ReactNode => {
    if (!state) return null;
    if (flow?.kind === 'add' || firstRunIdle) {
      return (
        <div className={`host-card acct-card${accounts.length === 0 ? ' acct-first' : ''}`}>
          {panel(accounts.length === 0 ? 'first' : 'another')}
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
  const removeMessage = (a: CodexAccountInfo): string => {
    const view = removeView(accounts, a.id, now);
    switch (view.kind) {
      case 'inUse': return t('prefs.codexAccounts.remove.inUse', { name: a.label, next: view.next.label });
      case 'only': return t('prefs.codexAccounts.remove.only', { name: a.label });
      case 'other': return t('prefs.accounts.remove.other', { name: a.label, active: view.active.label });
      default: return t('prefs.accounts.remove.off', { name: a.label });
    }
  };

  return (
    <div className="pref-section acct-pane" ref={paneRef}>
      <h3>{t('prefs.codexAccounts.title')}</h3>
      {/* Nothing but the title until main has answered: the first-run
          card must never flash for someone who has accounts. */}
      {state && (
        <>
          <p className="pref-section-desc acct-lead">
            {rich(t, `prefs.codexAccounts.lead.${leadKind(state, now)}`, {}, { name: <strong>{active?.label ?? ''}</strong> })}
          </p>
          {alert && (
            <div className={`${alert.kind === 'allOut' || alert.kind === 'oneOut' ? 'pref-warn' : 'pref-error'} acct-alert`}>
              <i
                className={`fa-solid ${alert.kind === 'allOut' || alert.kind === 'oneOut' ? 'fa-triangle-exclamation' : 'fa-circle-exclamation'}`}
                aria-hidden
              />
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
              onRemove={() => askRemove(a)}
            />
          ))}
          {addArea()}
          <div className="acct-foot">
            {/* Only a host that answered but can't take accounts is named;
                one that is merely off gets them when it is back. */}
            {(state.outdatedHosts ?? []).map((host) => (
              <Note key={host} tone="wait">{t('prefs.codexAccounts.hosts.outdated', { host })}</Note>
            ))}
            {accounts.length === 0 && state.encryptionAvailable && <div>{t('prefs.codexAccounts.add.before')}</div>}
            <div>
              {accounts.length >= 2 && active ? `${t('prefs.accounts.foot.switch')} ` : ''}
              {t('prefs.codexAccounts.foot.scope')}
            </div>
            {/* The two things that are not as they are for Claude accounts,
                said once and plainly: nothing else here would tell. */}
            {state.encryptionAvailable && (
              <div className="acct-differs">
                <div>{t('prefs.codexAccounts.differs.title')}</div>
                <ul>
                  <li>{t('prefs.codexAccounts.differs.engine')}</li>
                  <li>{t('prefs.codexAccounts.differs.hosts')}</li>
                </ul>
              </div>
            )}
            {active && (
              <div className="acct-foot-row">
                <span>{t('prefs.codexAccounts.off.prompt')}</span>
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
          message={t('prefs.codexAccounts.off.body')}
          confirmLabel={t('prefs.accounts.off.action')}
          onConfirm={() => void confirmStop()}
          onCancel={cancelStop}
        />
      )}
    </div>
  );
}

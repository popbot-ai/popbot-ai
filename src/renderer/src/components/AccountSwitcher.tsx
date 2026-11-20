import { useEffect, useRef, useState } from 'react';
import type { MessageKey } from '@shared/i18n';
import { useTranslation } from '../lib/i18n';
import { accountSwitcher as claudeSwitcher, shortAccountName, type SwitchRow, type SwitcherView } from '../lib/claudeAccountsView';
import { accountSwitcher as codexSwitcher } from '../lib/codexAccountsView';
import { useClaudeAccountsState, useFormats, useNow } from './PrefsClaudeAccounts';
import { useCodexAccountsState } from './PrefsCodexAccounts';
import { AgentLogo } from './AgentLogo';

type Agent = 'claude' | 'codex';

/** What differs between the two chips: their words, and where "Manage" leads. */
const SPEC: Record<Agent, {
  /** The Preferences section that manages these accounts. */
  section: string;
  title: MessageKey;
  titleOff: MessageKey;
  titleAttention: MessageKey;
  head: MessageKey;
  switchTo: MessageKey;
  manage: MessageKey;
}> = {
  claude: {
    section: 'accounts',
    title: 'titlebar.account.title',
    titleOff: 'titlebar.account.titleOff',
    titleAttention: 'titlebar.account.titleAttention',
    head: 'titlebar.account.head',
    switchTo: 'titlebar.account.switchTo',
    manage: 'titlebar.account.manage',
  },
  codex: {
    section: 'codexAccounts',
    title: 'titlebar.account.codex.title',
    titleOff: 'titlebar.account.codex.titleOff',
    titleAttention: 'titlebar.account.codex.titleAttention',
    head: 'titlebar.account.codex.head',
    switchTo: 'titlebar.account.codex.switchTo',
    manage: 'titlebar.account.codex.manage',
  },
};

type SwitchAnswer = { ok: true } | { ok: false; error: string };

/** Sent on `window` by a chip as its menu opens, naming its agent: the
 *  other chip closes its own. A click on the other chip would close this
 *  one anyway (it lands outside); opening it from the keyboard would not. */
const MENU_OPENED = 'popbot:account-menu-opened';

/**
 * One account chip in the title bar: the agent's logo and the short name
 * of the account every chat of that agent is running on — always in
 * sight — and a menu that moves them to another. So neither "which
 * account am I on?" nor "how do I switch?" needs a trip into
 * Preferences. The logo is what tells the Claude chip from the Codex
 * one: two bare names side by side would say nothing about which is
 * which. The name is cut at its "@" (the chip has room for little); the
 * whole of it is in the tooltip and in the menu. When the bar is narrow
 * the name gives way and the logo stays (prototype.css). An account that
 * needs attention turns the chip amber and keeps its logo.
 */
function AccountChip({ agent, view, onUse }: {
  agent: Agent;
  /** Null: this agent has no accounts, so it has no chip. */
  view: SwitcherView | null;
  onUse: (id: string) => Promise<SwitchAnswer>;
}): JSX.Element | null {
  const { t } = useTranslation();
  const fmt = useFormats();
  const now = useNow();
  const spec = SPEC[agent];
  const [open, setOpen] = useState(false);
  /** The account being switched to, while main is asked. */
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // One menu at a time.
  useEffect(() => {
    const onOther = (e: Event): void => {
      if ((e as CustomEvent<Agent>).detail !== agent) setOpen(false);
    };
    window.addEventListener(MENU_OPENED, onOther);
    return () => window.removeEventListener(MENU_OPENED, onOther);
  }, [agent]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!view) return null;

  const use = async (row: SwitchRow): Promise<void> => {
    if (!row.canUse || switching) return;
    setError(null);
    setSwitching(row.id);
    let failed: string | null = null;
    try {
      const result = await onUse(row.id);
      if (!result.ok) failed = result.error;
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    if (!alive.current) return;
    setSwitching(null);
    // The chip now reads the new name: that is the confirmation.
    if (failed) setError(failed);
    else setOpen(false);
  };
  const manage = (): void => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent('popbot:open-prefs', { detail: { section: spec.section } }));
  };
  const note = (row: SwitchRow): string | null => {
    if (!row.note) return null;
    return row.note === 'out' || row.note === 'outInUse'
      ? t(`titlebar.account.row.${row.note}`, { until: fmt.when('until', row.until ?? now, now) })
      : t(`titlebar.account.row.${row.note}`);
  };
  const title = view.name === null
    ? t(spec.titleOff)
    : t(view.attention ? spec.titleAttention : spec.title, { name: view.name });

  return (
    <div className="acct-switch" ref={wrapRef}>
      <button
        type="button"
        className={`acct-switch-btn ${agent}${view.attention ? ' attention' : ''}${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={open ? undefined : title}
        onClick={() => {
          setError(null);
          if (!open) window.dispatchEvent(new CustomEvent<Agent>(MENU_OPENED, { detail: agent }));
          setOpen(!open);
        }}
      >
        <AgentLogo agent={agent} />
        <span className="acct-switch-name">{view.name === null ? t('titlebar.account.none') : shortAccountName(view.name)}</span>
        <i className="fa-solid fa-chevron-down acct-switch-caret" aria-hidden />
      </button>
      {open && (
        <div className="acct-switch-pop" role="menu" aria-label={t(spec.head)}>
          <div className="acct-switch-head">
            <AgentLogo agent={agent} size={12} />
            {t(spec.head)}
          </div>
          {view.rows.map((row) => {
            const said = note(row);
            return (
              <button
                key={row.id}
                type="button"
                role="menuitemradio"
                aria-checked={row.inUse}
                aria-label={row.canUse ? t(spec.switchTo, { name: row.label }) : undefined}
                className={`acct-switch-row${row.inUse ? ' in-use' : ''}${row.canUse ? '' : ' no-press'}`}
                // The account in use is not pressable, but it is not greyed either.
                disabled={!row.canUse && !row.inUse}
                aria-disabled={!row.canUse}
                onClick={() => void use(row)}
              >
                <i className={`fa-solid ${switching === row.id ? 'fa-spinner fa-spin' : row.inUse ? 'fa-check' : 'fa-circle-user'}`} aria-hidden />
                <span className="acct-switch-row-name" title={row.label}>{row.label}</span>
                {said && <span className={`acct-switch-row-note ${row.note}`}>{said}</span>}
              </button>
            );
          })}
          {error && <div className="acct-switch-error" role="alert">{t('titlebar.account.failed', { error })}</div>}
          <div className="acct-switch-note">
            {t(view.rows.some((r) => r.canUse) ? 'titlebar.account.note' : 'titlebar.account.noteNone')}
          </div>
          <button type="button" role="menuitem" className="acct-switch-manage" onClick={manage}>
            <i className="fa-solid fa-gear" aria-hidden />
            {t(spec.manage)}
          </button>
        </div>
      )}
    </div>
  );
}

/** The Claude chip. What each line offers is decided in
 *  lib/claudeAccountsView.ts, from the same rules as the cards in
 *  Preferences ▸ Claude accounts. */
function ClaudeChip(): JSX.Element | null {
  const view = claudeSwitcher(useClaudeAccountsState(), useNow());
  return <AccountChip agent="claude" view={view} onUse={(id) => window.popbot.claudeAccounts.setActive(id)} />;
}

/** The Codex chip: the same, from lib/codexAccountsView.ts and the cards
 *  in Preferences ▸ Codex accounts. */
function CodexChip(): JSX.Element | null {
  const view = codexSwitcher(useCodexAccountsState(), useNow());
  return <AccountChip agent="codex" view={view} onUse={(id) => window.popbot.codexAccounts.setActive(id)} />;
}

/**
 * The title bar's account chips: one for Claude, one for Codex, each
 * shown only once that agent has an account.
 */
export function AccountSwitchers(): JSX.Element {
  return (
    <>
      <ClaudeChip />
      <CodexChip />
    </>
  );
}

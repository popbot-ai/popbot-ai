import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { hotkey } from '../lib/hotkeys';
import { useTranslation } from '../lib/i18n';
import { IconSelect, type SelectChoice } from './IconSelect';
import { LOCALES, type Locale, type MessageKey } from '@shared/i18n';
import linearIcon from '../assets/notif/linear.png';
import jiraIcon from '../assets/notif/jira.png';
import githubIcon from '../assets/notif/github.png';
import unityEngineIcon from '../assets/engines/unity-white.png';
import unrealEngineIcon from '../assets/engines/unreal-white.png';
import type { LinearProjectDto } from '@shared/linear';
import type { GithubTestResult, JiraSettings } from '@shared/ticketProvider';
import {
  GAME_ENGINES,
  engineEnabled,
  mcpDefaultBasePort,
  type GameEngineId,
  type GameEngineConfig,
  type GameEnginesSettings,
} from '@shared/gameEngine';
import {
  ATTACHMENT_TTL_DAYS_DEFAULT,
  ATTACHMENT_TTL_DAYS_MAX,
  ATTACHMENT_TTL_DAYS_MIN,
  CLOUD_SETTINGS_KEY,
  CODEX_SETTINGS_KEY,
  POPBOT_MCP_SETTINGS_KEY,
  popbotMcpEnabled,
  type CloudSettings,
  type PopbotMcpSettings,
  codexUsesAppServer,
  type CodexSettings,
  clampAttachmentTtlDays,
  clampToolResultTtlDays,
  DEFAULT_TOOL_RESULT_TTL_DAYS,
  type ToolRetentionSettings,
  clampMaxChangedFiles,
  MAX_CHANGED_FILES_DEFAULT,
  MAX_CHANGED_FILES_MAX,
  MAX_CHANGED_FILES_MIN,
  type AttachmentsSettings,
  type SourceControlSettings,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type PerforceSettings,
  type RepoRecord,
  type RepoWorktreeMode,
} from '@shared/persistence';
import type { SourceControlProviderId } from '@shared/sourceControl';
import {
  DEFAULT_MAX_PER_AUTHOR,
  MAX_MAX_PER_AUTHOR,
  DEFAULT_REVIEW_SCOPE,
  providerIdForReviewSystem,
  reviewInScope,
  reviewIsIgnored,
  type PinnedReview,
  type ReviewItem,
  type ReviewScope,
} from '@shared/reviews';
import { ConfirmDialog } from './ConfirmDialog';
import { PrefsClaudeAccounts, useClaudeAccountsAttention, useClaudeAccountsState } from './PrefsClaudeAccounts';
import { PrefsCodexAccounts, useCodexAccountsAttention, useCodexAccountsState } from './PrefsCodexAccounts';
import { AgentLogo, type LogoAgent } from './AgentLogo';
import { accountInUse as codexAccountInUse, accountsPointer as codexAccountsPointer } from '../lib/codexAccountsView';
import type { BasePreflightInfo, CloudStatus, CodexAccountsState } from '@shared/ipc';
import type { HostInfo, HostRepo } from '@shared/hostProtocol';
import type { HostRecord } from '@shared/persistence';
import { isMcpTool, mcpServerOfTool, permissionRuleMatches } from '@shared/agent';
import { useSettings } from '../lib/useSettings';
import { ConfigureSlotsPanel } from './ConfigureSlotsPanel';
import { P4Glyph } from './P4Glyph';
import { P4LoginModal } from './P4LoginModal';
import {
  AGENT_EFFORT_DEFAULTS_SETTING,
  normalizeAgentEffortDefaults,
  reasoningEffortLabel,
  type AgentEffortDefaultsSettings,
} from './AgentCreateControls';
import { DEFAULT_REPO_COLOR, POPBOT_PALETTE } from '../lib/repoColor';
import {
  ICON,
  CLAUDE_EFFORT_CHOICES,
  CODEX_EFFORT_CHOICES,
  accountsPointer,
  apiKeyProblem,
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
  type FieldNote,
  type GithubNote,
  type KeyCheck,
  type KeyDraftVerdict,
  type KeyErrorKind,
  type MarkKind,
  type Pill,
  type SecretMode,
  type StateLine,
  type SwitchView,
  type TokenProblem,
} from '../lib/agentsPaneView';
import {
  CODE_REVIEW_TEMPLATE_VARS,
  DEFAULT_ADDRESS_CR_TEMPLATE,
  DEFAULT_COMMIT_AI_TEMPLATE,
  DEFAULT_MAKE_PR_READY_TEMPLATE,
  DEFAULT_PUSH_DRAFT_PR_TEMPLATE,
  DEFAULT_PUSH_PR_TEMPLATE,
  DEFAULT_REBASE_BASE_TEMPLATE,
  DEFAULT_RAPID_RE_REVIEW_TEMPLATE,
  DEFAULT_RE_REVIEW_TEMPLATE,
  DEFAULT_START_CODE_REVIEW_TEMPLATE,
  DEFAULT_START_TICKET_TEMPLATE,
  DEFAULT_P4_NEW_CR_TEMPLATE,
  DEFAULT_P4_ADDRESS_CR_TEMPLATE,
  DEFAULT_RUN_TESTS_TEMPLATE,
  DEFAULT_P4_REVIEW_COMMIT_TEMPLATE,
  GIT_ACTION_TEMPLATE_VARS,
  GIT_REBASE_TEMPLATE_VARS,
  P4_ACTION_TEMPLATE_VARS,
  TICKET_TEMPLATE_VARS,
} from '@shared/templates';

interface PreferencesSheetProps {
  onClose: () => void;
  /** Called after the user saves or disconnects Linear settings, so the
   *  Linear-backed views (PanelA tickets) can re-fetch. */
  onLinearChanged?: () => void;
  /** Called after a repo is created / updated / deleted — used by
   *  the chat list so denormalized `repoColor`/`repoMode` updates
   *  show up live instead of needing a reload. */
  onReposChanged?: () => void;
  /** Open with this section selected. Used to deep-link from elsewhere
   *  in the app — e.g. the slot-not-configured prompt opens 'runtime'.
   *  A part after `#` names a place inside the section: 'agents#cloud'
   *  opens Agents at Cloud chats. */
  initialSection?: string;
  /** Close Preferences and open New chat set up for a cloud chat — the
   *  Cloud chats card offers it once a key works. */
  onNewCloudChat?: () => void;
}

interface NavSection {
  id: string;
  /** i18n key for the nav label (translated at render time). */
  labelKey: MessageKey;
  /** The agent whose mark stands in for the icon: the two accounts
   *  entries would otherwise carry the same one. */
  logo?: LogoAgent;
  icon: string;
}

// Only sections with a real component below are listed here. The
// "Coming soon" entries (general, appearance, agents, automation,
// windows, shortcuts, privacy, advanced) were removed because they
// confused first-time users into thinking the prefs were broken; we
// can put them back here as each one ships.
const SECTIONS: NavSection[] = [
  { id: 'integ', labelKey: 'prefs.section.integ', icon: 'fa-plug' },
  { id: 'accounts', labelKey: 'prefs.section.accounts', icon: 'fa-circle-user', logo: 'claude' },
  { id: 'codexAccounts', labelKey: 'prefs.section.codexAccounts', icon: 'fa-circle-user', logo: 'codex' },
  { id: 'agents', labelKey: 'prefs.section.agents', icon: 'fa-robot' },
  { id: 'hosts', labelKey: 'prefs.section.hosts', icon: 'fa-server' },
  { id: 'runtime', labelKey: 'prefs.section.runtime', icon: 'fa-microchip' },
  { id: 'repos', labelKey: 'prefs.section.repos', icon: 'fa-code-fork' },
  { id: 'git', labelKey: 'prefs.section.git', icon: 'fa-code-branch' },
  { id: 'apps', labelKey: 'prefs.section.apps', icon: 'fa-arrow-up-right-from-square' },
  { id: 'templates', labelKey: 'prefs.section.templates', icon: 'fa-file-lines' },
  { id: 'reviews', labelKey: 'prefs.section.reviews', icon: 'fa-code-pull-request' },
  { id: 'notify', labelKey: 'prefs.section.notify', icon: 'fa-bell' },
  { id: 'permissions', labelKey: 'prefs.section.permissions', icon: 'fa-shield-halved' },
  { id: 'language', labelKey: 'prefs.section.language', icon: 'fa-language' },
];

/** Language preference pane. Changing the selection applies immediately
 *  (the provider persists it to settings + tells main to re-localize the
 *  native menu) — no Save button needed. */
function PrefsLanguage(): JSX.Element {
  const { t, locale, setLocale } = useTranslation();
  return (
    <div className="pref-section">
      <h3>{t('language.title')}</h3>
      <p className="pref-section-desc">{t('language.description')}</p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('language.label')}</div>
            <div className="pref-label-desc">{t('language.systemNote')}</div>
          </div>
          <div className="pref-control">
            <select
              className="pref-input"
              aria-label={t('language.label')}
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              style={{ width: 220 }}
            >
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>{l.nativeName}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PreferencesSheet({
  onClose,
  onLinearChanged,
  onReposChanged,
  initialSection,
  onNewCloudChat,
}: PreferencesSheetProps): JSX.Element {
  // Fall back to the first section if we're handed (or deep-linked to) an
  // id that no longer has a render branch — otherwise the content pane
  // renders empty with nothing highlighted in the nav.
  const known = (id: string | undefined): string =>
    SECTIONS.some((s) => s.id === id) ? (id as string) : SECTIONS[0].id;
  // 'section#anchor': the anchor is read once, when the sheet opens, and
  // dropped as soon as the user picks a section themselves.
  const [initialId, initialAnchor] = (initialSection ?? '').split('#');
  const [section, setSection] = useState(() => known(initialId));
  const [anchor, setAnchor] = useState<string | undefined>(initialAnchor || undefined);
  const { t } = useTranslation();
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.popbot.app.getVersion().then(setVersion).catch(() => {});
  }, []);
  // The Claude accounts nav item carries a mark while the account chats
  // run on can't run them (refused or expired sign-in, or every account
  // out of usage), so the problem shows from any section.
  const accountsAlert = useClaudeAccountsAttention();
  // The Codex accounts item carries the same mark, for the same reason.
  const codexAccountsAlert = useCodexAccountsAttention();

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="prefs" data-screen-label="Preferences">
        <div className="prefs-head">
          <h2><i className="fa-solid fa-gear" /> {t('prefs.title')}</h2>
          <input className="prefs-search" placeholder={t('prefs.search')} />
          <button className="iconbtn" onClick={onClose} style={{ width: 28, height: 28 }} title={`${t('common.close')} ${hotkey('W')}`}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="prefs-body">
          <nav className="prefs-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`prefs-nav-item ${section === s.id ? 'active' : ''}`}
                onClick={() => { setSection(s.id); setAnchor(undefined); }}
              >
                {s.logo
                  ? <AgentLogo agent={s.logo} size={13} className="prefs-nav-logo" />
                  : <i className={`fa-solid ${s.icon}`} />}
                <span>{t(s.labelKey)}</span>
                {((s.id === 'accounts' && accountsAlert) || (s.id === 'codexAccounts' && codexAccountsAlert)) && (
                  <i className="fa-solid fa-circle-exclamation prefs-nav-alert" role="img" aria-label={t('prefs.accounts.navAlert')} />
                )}
              </button>
            ))}
          </nav>
          <div className="prefs-content">
            {section === 'integ' && <PrefsIntegrations onLinearChanged={onLinearChanged} />}
            {section === 'accounts' && <PrefsClaudeAccounts />}
            {section === 'codexAccounts' && <PrefsCodexAccounts />}
            {section === 'agents' && <PrefsAgents onGoTo={setSection} anchor={anchor} onNewCloudChat={onNewCloudChat} />}
            {section === 'hosts' && <PrefsHosts onGoTo={setSection} />}
            {section === 'runtime' && <PrefsAttachments />}
            {section === 'repos' && <PrefsRepos onReposChanged={onReposChanged} />}
            {section === 'git' && <PrefsGit />}
            {section === 'apps' && <PrefsApps />}
            {section === 'templates' && <PrefsTemplates />}
            {section === 'reviews' && <PrefsReviews />}
            {section === 'notify' && <PrefsNotifications />}
            {section === 'permissions' && <PrefsPermissions />}
            {section === 'language' && <PrefsLanguage />}
          </div>
        </div>
        <div className="prefs-foot">
          <span className="prefs-foot-meta">
            {t('prefs.footMeta')}{version ? ` · v${version}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={onClose}>{t('common.done')}</button>
        </div>
      </div>
    </>
  );
}

interface LinearSettings {
  apiKey?: string;
  teamKey?: string;
  projectId?: string;
}

/**
 * A settings panel with no Save button. `commit` writes the panel's
 * draft when it differs from what is saved; the panel calls it when a
 * field is left (blur, Enter) or a switch changes (with the new value
 * as an override, since the state update has not rendered yet), and
 * the hook calls it once more when the panel unmounts, so closing the
 * sheet saves what is still pending. The draft and its saved twin are
 * read through a ref, so a commit from a blur or an unmount sees the
 * latest values. A write in flight is not repeated for the same draft;
 * a draft that changed meanwhile is written after it.
 */
function useAutoCommit<T extends object>(fns: {
  draft: () => T;
  saved: () => T;
  write: (next: T) => Promise<void>;
}): (override?: Partial<T>) => Promise<void> {
  const ref = useRef(fns);
  ref.current = fns;
  const running = useRef(false);
  const queued = useRef<T | null>(null);
  const lastWritten = useRef<string | null>(null);
  const commit = useCallback(async (override?: Partial<T>): Promise<void> => {
    const next = { ...ref.current.draft(), ...(override ?? {}) } as T;
    const sig = JSON.stringify(next);
    if (sig === JSON.stringify(ref.current.saved()) || sig === lastWritten.current) return;
    if (running.current) {
      queued.current = next;
      return;
    }
    running.current = true;
    try {
      let cur: T | null = next;
      while (cur) {
        lastWritten.current = JSON.stringify(cur);
        try {
          await ref.current.write(cur);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('settings write failed', err);
        }
        cur = queued.current;
        queued.current = null;
        if (cur && JSON.stringify(cur) === lastWritten.current) cur = null;
      }
    } finally {
      running.current = false;
    }
  }, []);
  useEffect(() => () => { void commit(); }, [commit]);
  return commit;
}

/** Enter in a single-line field leaves it, which saves it. */
function blurOnEnter(e: React.KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

/** The pane's six features, in the order they are shown. Each is a
 *  section with the id `agents-{id}`, which is what a deep link
 *  (`agents#cloud`) names. */
const AGENT_FEATURES = [
  { id: 'accounts', title: 'prefs.agents.accounts.title' },
  { id: 'codexAccounts', title: 'prefs.agents.codexAccounts.title' },
  { id: 'effort', title: 'prefs.agents.effort.title' },
  { id: 'steer', title: 'prefs.agents.codexSteering.title' },
  { id: 'control', title: 'prefs.agents.control.title' },
  { id: 'cloud', title: 'prefs.agents.cloud.title' },
] as const satisfies ReadonlyArray<{ id: string; title: MessageKey }>;

type AgentFeatureId = (typeof AGENT_FEATURES)[number]['id'];

/** How long a section a deep link landed on keeps its accent edge. */
const ARRIVED_MS = 2_000;
/** How often the accounts pointer re-reads the clock: an out-of-usage
 *  time that has passed counts as cleared, with nobody pressing anything. */
const POINTER_TICK_MS = 30_000;
/** Where an Anthropic API key is made. */
const API_KEYS_URL = 'https://platform.claude.com/settings/keys';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One of the pane's features: a section named by its heading. */
function FeatureSection({ id, arrived, children }: {
  id: AgentFeatureId;
  /** A deep link just landed here: the accent edge that fades. */
  arrived?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`pref-section${arrived ? ' arrived' : ''}`} id={`agents-${id}`} aria-labelledby={`agents-${id}-h`}>
      {children}
    </section>
  );
}

/**
 * The head every feature shares: its name, the pill that says its state
 * directly after the name (never at the far right, which is the control
 * column), then its one control. The heading can take focus so a deep
 * link has somewhere to land.
 */
function FeatureHead({ id, title, pill, children }: {
  id: AgentFeatureId;
  title: string;
  pill?: Pill | null;
  /** The one control at the right edge, if the feature has one. */
  children?: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="pref-head">
      <h3 id={`agents-${id}-h`} tabIndex={-1}>{title}</h3>
      {pill && (
        <span className={`pill ${pill.tone}`}>
          {pill.icon && <i className={pill.icon} aria-hidden />}
          {t(pill.key, pill.vars)}
        </span>
      )}
      {children && <span className="pref-head-control">{children}</span>}
    </div>
  );
}

/** A hint, a timing line or a verdict: the icon is decoration, the
 *  words carry it. `children` is read on after the sentence. */
function StateLineView({ line, children }: { line: StateLine; children?: ReactNode }): JSX.Element {
  const { t } = useTranslation();
  return (
    <p className={`pref-state ${lineClass(line.tone)}`}>
      <i className={lineIcon(line.tone)} aria-hidden />
      <span>{t(line.key, line.vars)}{children}</span>
    </p>
  );
}

/** The current time, re-read every `ms` while mounted. */
function useNowEvery(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * Preferences ▸ Agents: five headed features, each built the same way —
 * its name, a pill that says its state in words, then its one control at
 * the right edge; under that one sentence of benefit with any cost or
 * risk in it; then a state line only where it adds something the pill
 * does not say. Switches and pickers apply at once; nothing else
 * commits by surprise. Which pill, which line and which wording is
 * decided in lib/agentsPaneView.ts, where it is tested.
 */
function PrefsAgents({ onGoTo, anchor, onNewCloudChat }: {
  onGoTo: (section: string) => void;
  /** The feature a deep link asked for (`agents#cloud`): scrolled into
   *  view, marked for a moment, and given focus. */
  anchor?: string;
  /** Close Preferences and open New chat set up for a cloud chat. */
  onNewCloudChat?: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const saved = normalizeAgentEffortDefaults(
    get<AgentEffortDefaultsSettings>(AGENT_EFFORT_DEFAULTS_SETTING),
  );
  const [values, setValues] = useState(saved);

  useEffect(() => {
    setValues(saved);
  }, [
    saved.claudeReasoningEffort,
    saved.codexReasoningEffort,
    saved.codeReviewClaudeReasoningEffort,
    saved.codeReviewCodexReasoningEffort,
  ]);
  // A picked effort is written at once; there is nothing to hold back for.
  const commit = useAutoCommit<AgentEffortDefaultsSettings>({
    draft: () => values,
    saved: () => saved,
    write: (next) => set(AGENT_EFFORT_DEFAULTS_SETTING, next),
  });
  const pick = (patch: Partial<AgentEffortDefaultsSettings>): void => {
    setValues((prev) => ({ ...prev, ...patch }));
    void commit(patch);
  };

  const codexAccounts = useCodexAccountsState();
  // The Codex CLI installed on this computer, asked once when the pane
  // opens. Until it answers (and when none is installed) the steering
  // feature says nothing about versions.
  const [codex, setCodex] = useState<{ ok: boolean; version?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.popbot.agent.backendsStatus()
      .then((status) => { if (!cancelled) setCodex(status.codex); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // A deep link: bring its feature into view, mark it, and put focus on
  // its heading (the Cloud chats card moves it on to the key field when
  // that is open). Waits for the settings, since the sections under a
  // loading pane have no height yet.
  const [arrived, setArrived] = useState<AgentFeatureId | null>(null);
  useEffect(() => {
    if (loading) return;
    const id = AGENT_FEATURES.find((f) => f.id === anchor)?.id;
    const section = id ? document.getElementById(`agents-${id}`) : null;
    if (!id || !section) {
      setArrived(null);
      return;
    }
    section.scrollIntoView({ block: 'start' });
    document.getElementById(`agents-${id}-h`)?.focus({ preventScroll: true });
    setArrived(id);
    const timer = window.setTimeout(() => setArrived(null), ARRIVED_MS);
    return () => window.clearTimeout(timer);
  }, [loading, anchor]);

  // While the settings load: the five heads, with no pills and no
  // controls, so the pane already reads as what it is.
  if (loading) {
    return (
      <div className="agents-pane">
        {AGENT_FEATURES.map((f) => (
          <FeatureSection key={f.id} id={f.id}>
            <FeatureHead id={f.id} title={t(f.title)} />
          </FeatureSection>
        ))}
      </div>
    );
  }

  const steerOn = codexUsesAppServer(get<CodexSettings>(CODEX_SETTINGS_KEY));
  // While a Codex account is in use, Codex chats run through the app
  // server whatever the switch says: it is shown on, and not offered.
  const steerForced = codexAccountInUse(codexAccounts);
  const controlOn = popbotMcpEnabled(get<PopbotMcpSettings>(POPBOT_MCP_SETTINGS_KEY));
  const cli = codexCli(codex);
  const newChats = t('prefs.agents.newChats.title');
  const codeReviews = t('prefs.agents.codeReviews.title');

  return (
    <div className="agents-pane">
      <AccountsPointer onGoTo={onGoTo} arrived={arrived === 'accounts'} />
      <CodexAccountsPointer state={codexAccounts} onGoTo={onGoTo} arrived={arrived === 'codexAccounts'} />

      <FeatureSection id="effort" arrived={arrived === 'effort'}>
        <FeatureHead id="effort" title={t('prefs.agents.effort.title')} />
        <p className="pref-section-desc">{t('prefs.agents.effort.desc')}</p>
        {/* The column heads are for the eye; each picker carries its own
            name ("Claude effort for New chats") for a screen reader. */}
        <div className="effort-head" aria-hidden>
          <span />
          <span>Claude</span>
          <span>Codex</span>
        </div>
        <div className="pref-rows effort-grid">
          <div className="pref-row">
            <div className="pref-label-title">{newChats}</div>
            <AgentEffortField
              agent="Claude"
              row={newChats}
              value={values.claudeReasoningEffort}
              options={CLAUDE_EFFORT_CHOICES}
              onChange={(claudeReasoningEffort) => pick({ claudeReasoningEffort })}
            />
            <AgentEffortField
              agent="Codex"
              row={newChats}
              value={shownCodexEffort(values.codexReasoningEffort)}
              options={CODEX_EFFORT_CHOICES}
              onChange={(codexReasoningEffort) => pick({ codexReasoningEffort })}
            />
          </div>
          <div className="pref-row">
            <div className="pref-label-title">{codeReviews}</div>
            <AgentEffortField
              agent="Claude"
              row={codeReviews}
              value={values.codeReviewClaudeReasoningEffort}
              options={CLAUDE_EFFORT_CHOICES}
              onChange={(codeReviewClaudeReasoningEffort) => pick({ codeReviewClaudeReasoningEffort })}
            />
            <AgentEffortField
              agent="Codex"
              row={codeReviews}
              value={shownCodexEffort(values.codeReviewCodexReasoningEffort)}
              options={CODEX_EFFORT_CHOICES}
              onChange={(codeReviewCodexReasoningEffort) => pick({ codeReviewCodexReasoningEffort })}
            />
          </div>
        </div>
        <p className="pref-section-desc">{t('prefs.agents.effort.scope')}</p>
      </FeatureSection>

      <SwitchSection
        id="steer"
        title={t('prefs.agents.codexSteering.title')}
        // Locked on, the advice to turn it off (and "this computer only")
        // would be wrong: only what steering does is said.
        desc={t(steerForced ? 'prefs.agents.steer.descForced' : 'prefs.agents.steer.desc')}
        on={steerOn || steerForced}
        locked={steerForced ? t('prefs.agents.steer.forcedSwitch') : undefined}
        arrived={arrived === 'steer'}
        view={(changed) => steerView(steerOn, cli, changed, steerForced)}
        onToggle={() => void set(CODEX_SETTINGS_KEY, {
          ...(get<CodexSettings>(CODEX_SETTINGS_KEY) ?? {}),
          appServer: !steerOn,
        } satisfies CodexSettings)}
      />

      {/* The popbot tools every chat's agent gets. The setting is read
          when a chat's agent starts, so the lines under it say what
          happens to an agent that is already running. */}
      <SwitchSection
        id="control"
        title={t('prefs.agents.control.title')}
        desc={t('prefs.agents.control.desc')}
        on={controlOn}
        arrived={arrived === 'control'}
        view={(changed) => controlView(controlOn, changed)}
        onToggle={() => void set(POPBOT_MCP_SETTINGS_KEY, {
          ...(get<PopbotMcpSettings>(POPBOT_MCP_SETTINGS_KEY) ?? {}),
          enabled: !controlOn,
        } satisfies PopbotMcpSettings)}
      />

      <CloudChatsSection
        saved={get<CloudSettings>(CLOUD_SETTINGS_KEY) ?? {}}
        onSave={(next) => set(CLOUD_SETTINGS_KEY, next)}
        arrived={arrived === 'cloud'}
        focusKey={anchor === 'cloud'}
        onNewCloudChat={onNewCloudChat}
      />
    </div>
  );
}

/**
 * The pointer to the Claude accounts section, first in the pane: which
 * account chats run on, in one line, and the way to the section that
 * manages them. The accounts themselves live there.
 */
function AccountsPointer({ onGoTo, arrived }: {
  onGoTo: (section: string) => void;
  arrived: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const state = useClaudeAccountsState();
  const view = accountsPointer(state, useNowEvery(POINTER_TICK_MS));
  const lineId = 'agents-accounts-line';
  return (
    <FeatureSection id="accounts" arrived={arrived}>
      <FeatureHead
        id="accounts"
        title={t('prefs.agents.accounts.title')}
        pill={view && { tone: view.tone, icon: view.icon, key: view.pill, vars: view.pillVars }}
      >
        <button
          type="button"
          className={`btn sm${view?.attention ? ' primary' : ''}`}
          aria-describedby={lineId}
          onClick={() => onGoTo('accounts')}
        >
          {t('prefs.agents.accounts.open')}
        </button>
      </FeatureHead>
      {/* Until the accounts are known the line is held empty, so the
          features below do not jump when the answer arrives. */}
      <p className="pref-section-desc" id={lineId}>{view ? t(view.line, view.vars) : ' '}</p>
    </FeatureSection>
  );
}

/**
 * The pointer to the Codex accounts section, directly under the Claude
 * one and built the same way. The state is the pane's own copy (it also
 * decides what the steering switch shows), so both read the same answer.
 */
function CodexAccountsPointer({ state, onGoTo, arrived }: {
  state: CodexAccountsState | null;
  onGoTo: (section: string) => void;
  arrived: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const view = codexAccountsPointer(state, useNowEvery(POINTER_TICK_MS));
  const lineId = 'agents-codexAccounts-line';
  return (
    <FeatureSection id="codexAccounts" arrived={arrived}>
      <FeatureHead
        id="codexAccounts"
        title={t('prefs.agents.codexAccounts.title')}
        pill={view && { tone: view.tone, icon: ICON[view.icon], key: view.pill, vars: view.pillVars }}
      >
        <button
          type="button"
          className={`btn sm${view?.attention ? ' primary' : ''}`}
          aria-describedby={lineId}
          onClick={() => onGoTo('codexAccounts')}
        >
          {t('prefs.agents.codexAccounts.open')}
        </button>
      </FeatureHead>
      <p className="pref-section-desc" id={lineId}>{view ? t(view.line, view.vars) : ' '}</p>
    </FeatureSection>
  );
}

/** One default-effort picker. Its value is its own feedback: a pick is
 *  written at once and nothing else on the pane changes. */
function AgentEffortField<T extends ClaudeReasoningEffort | CodexReasoningEffort>({
  agent,
  row,
  value,
  options,
  onChange,
}: {
  /** The product name ("Claude", "Codex") — with `row`, the picker's
   *  accessible name. */
  agent: string;
  row: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <select
      className="pref-select"
      aria-label={t('prefs.agents.effort.aria', { agent, row })}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value as T)}
    >
      {options.map((item) => {
        // The two levels that hand work to helper agents say so in the
        // list, where it is read before the pick.
        const costly = effortOptionKey(item);
        return <option key={item} value={item}>{costly ? t(costly) : reasoningEffortLabel(item, t)}</option>;
      })}
    </select>
  );
}

/**
 * A feature that is one switch. The switch is named by the heading and
 * described by the sentence and the lines under it, which sit in a live
 * region that is there before any line arrives, so a line that appears
 * when the switch is flipped is announced. Never disabled.
 */
function SwitchSection({ id, title, desc, on, locked, arrived, view, onToggle }: {
  id: AgentFeatureId;
  title: string;
  desc: string;
  on: boolean;
  /** Something else decides this for now: the switch shows `on` and can't
   *  be flipped. The text says so to whoever hovers or tabs to it; the
   *  lines under the description say why. */
  locked?: string;
  arrived: boolean;
  /** The pill and the lines, given whether the switch has been flipped
   *  on this visit. */
  view: (changed: boolean) => SwitchView;
  onToggle: () => void;
}): JSX.Element {
  // Set by the first flip and kept until the pane closes: it picks the
  // line that says when the change takes effect.
  const [changed, setChanged] = useState(false);
  const { pill, lines } = view(changed);
  const hId = `agents-${id}-h`;
  const descId = `agents-${id}-desc`;
  const stateId = `agents-${id}-state`;
  return (
    <FeatureSection id={id} arrived={arrived}>
      <FeatureHead id={id} title={title} pill={pill}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={hId}
          aria-describedby={`${descId} ${stateId}`}
          className={`pref-switch${locked ? ' locked' : ''}`}
          title={locked}
          aria-disabled={locked ? true : undefined}
          onClick={() => {
            if (locked) return;
            setChanged(true);
            onToggle();
          }}
        >
          <span className={`pref-toggle${on ? ' on' : ''}`}><span className="pref-toggle-thumb" /></span>
        </button>
      </FeatureHead>
      <p className="pref-section-desc" id={descId}>{desc}</p>
      <div id={stateId} role="status">
        {lines.map((line) => <StateLineView key={line.key} line={line} />)}
      </div>
    </FeatureSection>
  );
}

/** The mark left of a requirement: its number while it is still to do,
 *  then what became of it. The number is real text; an icon is
 *  decoration, and the row's sentence says the same in words. */
function SetupMark({ kind, step }: { kind: MarkKind; step: number }): JSX.Element {
  const { cls, icon } = markView(kind);
  return (
    <span className={`setup-mark ${cls}`}>
      {icon ? <i className={icon} aria-hidden /> : step}
    </span>
  );
}

/** How an apply was started. Only Enter and the button move focus
 *  afterwards: after a blur or a close, focus is already elsewhere. */
type ApplyVia = 'enter' | 'button' | 'leave' | 'close';

/** Where focus goes once the card has re-rendered. */
type CloudFocus = 'keyAction' | 'keyField' | 'workspaceField' | 'githubAction' | 'githubField';

/**
 * What a row has to say on the next visit about text that was in a
 * field when Preferences closed: a first secret is applied on the way
 * out and may fail after the pane is gone; a replacement is let go.
 */
const cloudCarried: { key: FieldNote | null; token: FieldNote | null } = { key: null, token: null };

/**
 * Cloud chats: one card with the two things a cloud chat needs — an
 * Anthropic API key and GitHub access — and, once the key works, how to
 * start one.
 *
 * - The heading pill is the verdict. "Ready" needs the key in use to
 *   have passed its check on this visit, wherever it comes from; the
 *   card asks main to check it without ever seeing a saved or
 *   environment key (`testKey('')`).
 * - A field is on screen only when filling it is the next step. A saved
 *   secret is a sentence with Replace and Remove; it is never put back
 *   into a field, not as dots either.
 * - Nothing commits by surprise. A first secret applies on Enter, its
 *   button, or when focus leaves its row (only a key that passes its
 *   check, or text that looks like a GitHub token, is saved). One that
 *   replaces something in use applies only on Enter or its button;
 *   leaving, Esc or closing Preferences lets it go, and the row says so.
 * - Each field owns the line directly under it. No verdict is shared.
 */
function CloudChatsSection({ saved, onSave, arrived, focusKey, onNewCloudChat }: {
  /** What is stored. Used to merge on save and to show the saved
   *  Workspace ID; a saved key or token never reaches an input or main. */
  saved: CloudSettings;
  onSave: (next: CloudSettings) => Promise<void>;
  arrived: boolean;
  /** A deep link asked for this card: focus goes to the key field when
   *  there is no key yet. */
  focusKey: boolean;
  onNewCloudChat?: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  // What cloud chats would run with right now, and whether the key in
  // use passed its check on this visit.
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [check, setCheck] = useState<KeyCheck | null>(null);
  const [rechecking, setRechecking] = useState(false);

  // The API key row. `keyOpen` is the replacement field; a first key's
  // field is open for as long as there is no key.
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyVerdict, setKeyVerdict] = useState<KeyDraftVerdict | null>(null);
  // How the last check of a typed key failed. Outlives the red line (which
  // clears on the first edit) so the way to a Workspace ID stays put.
  const [draftKind, setDraftKind] = useState<KeyErrorKind | null>(null);
  const [keyNote, setKeyNote] = useState<FieldNote | null>(() => cloudCarried.key);

  // The Workspace ID, under the key.
  const [wsEditing, setWsEditing] = useState(false);
  const [wsDraft, setWsDraft] = useState('');
  const [wsBusy, setWsBusy] = useState(false);
  const [wsVerdict, setWsVerdict] = useState<'ok' | 'fail' | null>(null);
  const [wsDetail, setWsDetail] = useState<string | null>(null);
  const [wsNote, setWsNote] = useState<'notChanged' | null>(null);

  // The GitHub access row.
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenProblem, setTokenProblem] = useState<TokenProblem | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [githubNote, setGithubNote] = useState<GithubNote | null>(() => cloudCarried.token);
  const [looking, setLooking] = useState(false);

  const [removing, setRemoving] = useState<'key' | 'token' | 'workspace' | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ target: CloudFocus } | null>(null);

  const keyRowRef = useRef<HTMLDivElement>(null);
  const githubRowRef = useRef<HTMLDivElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const wsInputRef = useRef<HTMLInputElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  // The button a Remove dialog was opened from, to give focus back to.
  const removeOpener = useRef<HTMLElement | null>(null);
  const removeAsked = useRef<'key' | 'token' | 'workspace' | null>(null);

  const mounted = useRef(true);
  // Answers that arrive out of order are dropped: only the last request
  // of each kind may set what is shown.
  const statusSeq = useRef(0);
  const checkSeq = useRef(0);
  // One apply at a time per field: a second trigger (a blur right after
  // Enter, a close right after a blur) is ignored.
  const keyInFlight = useRef(false);
  const wsInFlight = useRef(false);
  const tokenInFlight = useRef(false);

  const keyView = keyRow(status, check, rechecking);
  const githubView = githubRow(status, check);
  const keySource = status?.apiKey ?? null;
  const githubSource = status?.githubToken ?? null;
  const keyFieldOpen = keyView.mode === 'first' || (keyView.mode === 'replace' && keyOpen);
  const tokenFieldOpen = githubView.mode !== null && tokenOpen;
  const savedWorkspace = saved.workspaceId?.trim() || undefined;
  const workspace = workspaceView({
    savedId: savedWorkspace,
    editing: wsEditing,
    lastKind: lastKeyFailure(keyFieldOpen ? draftKind : null, check),
  });
  const wsFieldOpen = workspace === 'field';
  const wsMode: SecretMode = savedWorkspace ? 'replace' : 'first';
  // A Workspace ID typed beside a typed key is checked with that key.
  const keyTyped = keyFieldOpen && keyDraft.trim() !== '';

  // What a blur, Enter or the sheet closing under a field must see: the
  // values of the last render, not of the render the handler was made in.
  const latest = useRef({ status, saved, keyDraft, wsDraft, tokenDraft, keyFieldOpen, wsFieldOpen, tokenFieldOpen, wsMode });
  latest.current = { status, saved, keyDraft, wsDraft, tokenDraft, keyFieldOpen, wsFieldOpen, tokenFieldOpen, wsMode };

  const loadStatus = useCallback(async (): Promise<CloudStatus | null> => {
    const seq = ++statusSeq.current;
    try {
      const next = await window.popbot.cloud.status();
      if (!mounted.current || seq !== statusSeq.current) return null;
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  /** Ask main whether the key cloud chats run on now works. The key
   *  itself stays in main: an empty key means "the one in use". */
  const checkKeyInUse = useCallback(async (): Promise<void> => {
    const seq = ++checkSeq.current;
    setCheck({ state: 'checking' });
    let result: { ok: true } | { ok: false; error: string };
    try {
      result = await window.popbot.cloud.testKey('');
    } catch (err) {
      result = { ok: false, error: errorMessage(err) };
    }
    window.popbot.diag.log('prefs.cloud.inUse.checked', { ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
    if (!mounted.current || seq !== checkSeq.current) return;
    setCheck(result.ok ? { state: 'ok' } : failedCheck(result.error));
  }, []);

  /** Re-read where the key and GitHub access come from, then check the
   *  key if there is one. */
  const refresh = useCallback(async (): Promise<void> => {
    const next = await loadStatus();
    if (!next) return;
    if (next.apiKey === null) {
      checkSeq.current += 1;
      setCheck(null);
      return;
    }
    await checkKeyInUse();
  }, [loadStatus, checkKeyInUse]);

  // Only a key that passes its check is saved. A draft that fails stays
  // in the field with the reason under it; the key in use is untouched.
  const applyKey = async (via: ApplyVia): Promise<void> => {
    const draft = latest.current.keyDraft.trim();
    if (!draft || keyInFlight.current) return;
    const fromUser = via === 'enter' || via === 'button';
    // Plainly not a key: refused here, before any network call.
    const problem = apiKeyProblem(draft);
    if (problem) {
      window.popbot.diag.log('prefs.cloud.key.refused', { keyLen: draft.length, problem, via });
      if (!mounted.current) {
        cloudCarried.key = 'lastFailed';
        return;
      }
      setKeyVerdict({ kind: problem });
      if (fromUser) setFocusRequest({ target: 'keyField' });
      return;
    }
    const typedWorkspace = latest.current.wsFieldOpen ? latest.current.wsDraft.trim() : '';
    const workspaceId = typedWorkspace || latest.current.saved.workspaceId?.trim() || undefined;
    keyInFlight.current = true;
    if (mounted.current) {
      setKeyBusy(true);
      setKeyVerdict(null);
      setKeyNote(null);
    }
    window.popbot.diag.log('prefs.cloud.save', { keyLen: draft.length, workspace: !!workspaceId, via });
    let result: { ok: true } | { ok: false; error: string };
    try {
      result = await window.popbot.cloud.testKey(draft, workspaceId);
    } catch (err) {
      result = { ok: false, error: errorMessage(err) };
    }
    window.popbot.diag.log('prefs.cloud.checked', { ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
    if (result.ok) {
      try {
        await onSave(withApiKey(latest.current.saved, draft, typedWorkspace || undefined));
        window.popbot.diag.log('prefs.cloud.saved', { keyLen: draft.length });
      } catch (err) {
        result = { ok: false, error: errorMessage(err) };
        window.popbot.diag.log('prefs.cloud.save.failed', { error: result.error });
      }
    }
    keyInFlight.current = false;
    if (!mounted.current) {
      // Preferences closed while the check ran: its verdict waits for
      // the next visit.
      if (!result.ok) cloudCarried.key = 'lastFailed';
      return;
    }
    setKeyBusy(false);
    if (!result.ok) {
      const kind = keyErrorKind(result.error);
      setKeyVerdict({ kind, error: result.error });
      setDraftKind(kind);
      if (kind === 'workspace') {
        // The check asks for a Workspace ID: its field opens by itself.
        setWsEditing(true);
        setWsDraft((prev) => prev || latest.current.saved.workspaceId?.trim() || '');
        if (fromUser) setFocusRequest({ target: 'workspaceField' });
      } else if (fromUser) {
        setFocusRequest({ target: 'keyField' });
      }
      return;
    }
    // The draft has just passed: that is the check of the key now in
    // use, so no second call. Shown at once; the status re-read confirms it.
    checkSeq.current += 1;
    setCheck({ state: 'ok' });
    setStatus((prev) => (prev ? { ...prev, apiKey: 'settings', hasSettingsKey: true } : prev));
    setKeyOpen(false);
    setKeyDraft('');
    setKeyVerdict(null);
    setDraftKind(null);
    setWsEditing(false);
    setWsDraft('');
    setWsVerdict(null);
    setWsNote(null);
    if (fromUser) setFocusRequest({ target: 'keyAction' });
    void loadStatus();
  };

  // A Workspace ID for the key in use: saved only if the key passes its
  // check with it. Typed beside a key draft it is not applied on its
  // own — the key's check carries it.
  const applyWorkspace = async (via: ApplyVia): Promise<void> => {
    if (latest.current.keyFieldOpen && latest.current.keyDraft.trim()) {
      await applyKey(via);
      return;
    }
    const workspaceId = latest.current.wsDraft.trim();
    if (!workspaceId || !latest.current.status?.apiKey || wsInFlight.current) return;
    const fromUser = via === 'enter' || via === 'button';
    wsInFlight.current = true;
    if (mounted.current) {
      setWsBusy(true);
      setWsVerdict(null);
      setWsDetail(null);
      setWsNote(null);
    }
    let result: { ok: true } | { ok: false; error: string };
    try {
      result = await window.popbot.cloud.testKey('', workspaceId);
    } catch (err) {
      result = { ok: false, error: errorMessage(err) };
    }
    window.popbot.diag.log('prefs.cloud.workspace.checked', { ok: result.ok, via, ...(result.ok ? {} : { error: result.error }) });
    if (result.ok) {
      try {
        await onSave(withWorkspaceId(latest.current.saved, workspaceId));
      } catch (err) {
        result = { ok: false, error: errorMessage(err) };
      }
    }
    wsInFlight.current = false;
    if (!mounted.current) return;
    setWsBusy(false);
    if (!result.ok) {
      // The key in use and its ID are as they were: only this ID failed.
      setWsVerdict('fail');
      setWsDetail(result.error);
      if (fromUser) setFocusRequest({ target: 'workspaceField' });
      return;
    }
    checkSeq.current += 1;
    setCheck({ state: 'ok' });
    setWsVerdict('ok');
    setWsEditing(false);
    setWsDraft('');
    setDraftKind(null);
    if (fromUser) setFocusRequest({ target: 'keyAction' });
  };

  // There is no call that tests a GitHub token, so the only check is
  // what it looks like: plainly something else is refused, the rest is
  // saved and the row says "not checked".
  const applyToken = async (via: ApplyVia): Promise<void> => {
    const draft = latest.current.tokenDraft.trim();
    if (!draft || tokenInFlight.current) return;
    const fromUser = via === 'enter' || via === 'button';
    const problem = githubTokenProblem(draft);
    window.popbot.diag.log('prefs.cloud.token', { tokenLen: draft.length, problem: problem ?? 'none', via });
    if (problem) {
      if (!mounted.current) {
        cloudCarried.token = 'lastFailed';
        return;
      }
      setTokenProblem(problem);
      if (fromUser) setFocusRequest({ target: 'githubField' });
      return;
    }
    tokenInFlight.current = true;
    let error: string | null = null;
    try {
      await onSave(withGithubToken(latest.current.saved, draft));
    } catch (err) {
      error = errorMessage(err);
      window.popbot.diag.log('prefs.cloud.token.failed', { error });
    }
    tokenInFlight.current = false;
    if (!mounted.current) return;
    if (error) {
      setTokenError(error);
      if (fromUser) setFocusRequest({ target: 'githubField' });
      return;
    }
    setStatus((prev) => (prev ? { ...prev, githubToken: 'settings' } : prev));
    setTokenOpen(false);
    setTokenDraft('');
    setTokenProblem(null);
    setTokenError(null);
    setGithubNote('savedNow');
    if (fromUser) setFocusRequest({ target: 'githubAction' });
    void loadStatus();
  };

  const openKeyField = (): void => {
    setKeyOpen(true);
    setKeyDraft('');
    setKeyVerdict(null);
    setDraftKind(null);
    setKeyNote(null);
    setFocusRequest({ target: 'keyField' });
  };

  /** Let a replacement key go: the field closes and the row says that
   *  nothing changed. `byUser` is false when focus simply left the row. */
  const closeKeyField = (byUser: boolean): void => {
    setKeyOpen(false);
    setKeyDraft('');
    setKeyVerdict(null);
    setDraftKind(null);
    setKeyNote('notChanged');
    setWsEditing(false);
    setWsDraft('');
    setWsVerdict(null);
    if (byUser) setFocusRequest({ target: 'keyAction' });
  };

  const openWorkspaceField = (): void => {
    setWsEditing(true);
    setWsDraft(latest.current.saved.workspaceId?.trim() ?? '');
    setWsVerdict(null);
    setWsDetail(null);
    setWsNote(null);
    setFocusRequest({ target: 'workspaceField' });
  };

  const closeWorkspaceField = (byUser: boolean): void => {
    setWsEditing(false);
    setWsDraft('');
    setWsVerdict(null);
    setWsDetail(null);
    // "Not changed" only where there is an ID for that to be true of.
    setWsNote(latest.current.wsMode === 'replace' ? 'notChanged' : null);
    if (byUser) setFocusRequest({ target: latest.current.keyFieldOpen ? 'keyField' : 'keyAction' });
  };

  const openTokenField = (): void => {
    setTokenOpen(true);
    setTokenDraft('');
    setTokenProblem(null);
    setTokenError(null);
    setGithubNote(null);
    setFocusRequest({ target: 'githubField' });
  };

  const closeTokenField = (byUser: boolean): void => {
    const replacing = secretMode(latest.current.status?.githubToken ?? null) === 'replace';
    setTokenOpen(false);
    setTokenDraft('');
    setTokenProblem(null);
    setTokenError(null);
    setGithubNote(replacing ? 'notChanged' : null);
    if (byUser) setFocusRequest({ target: 'githubAction' });
  };

  // What happens to a field's text when focus has moved to something
  // else in PopBot outside its row (see leaveOutcome).
  const keyRowLeft = (): void => {
    const now = latest.current;
    if (now.keyFieldOpen) {
      const outcome = leaveOutcome(secretMode(now.status?.apiKey ?? null), now.keyDraft, keyInFlight.current);
      if (outcome === 'apply') {
        void applyKey('leave');
        return;
      }
      if (outcome === 'discard') {
        closeKeyField(false);
        return;
      }
      if (now.keyDraft.trim()) return;
    }
    if (!now.wsFieldOpen) return;
    const outcome = leaveOutcome(now.wsMode, now.wsDraft, wsInFlight.current);
    if (outcome === 'apply') void applyWorkspace('leave');
    else if (outcome === 'discard') closeWorkspaceField(false);
  };

  const githubRowLeft = (): void => {
    const now = latest.current;
    if (!now.tokenFieldOpen) return;
    const outcome = leaveOutcome(secretMode(now.status?.githubToken ?? null), now.tokenDraft, tokenInFlight.current);
    if (outcome === 'apply') void applyToken('leave');
    else if (outcome === 'discard') closeTokenField(false);
  };

  // "Leaving the row" is read after the blur, when it is known where
  // focus went: still inside the row is not leaving, and neither is
  // switching to another application (the document has no focus then).
  const onRowBlur = (row: { current: HTMLElement | null }, left: () => void) => (): void => {
    window.setTimeout(() => {
      const el = row.current;
      if (!mounted.current || !el) return;
      if (!document.hasFocus() || el.contains(document.activeElement)) return;
      left();
    }, 0);
  };

  // Preferences closing over a field never blurs it. A first secret is
  // applied on the way out, as if its row had been left; a replacement
  // is let go, and the row says so on the next visit.
  const closing = (): void => {
    const now = latest.current;
    if (now.keyFieldOpen) {
      const outcome = leaveOutcome(secretMode(now.status?.apiKey ?? null), now.keyDraft, keyInFlight.current);
      if (outcome === 'apply') void applyKey('close');
      else if (outcome === 'discard' && now.keyDraft.trim()) cloudCarried.key = 'notChanged';
    }
    if (now.wsFieldOpen && !(now.keyFieldOpen && now.keyDraft.trim())
      && leaveOutcome(now.wsMode, now.wsDraft, wsInFlight.current) === 'apply') {
      void applyWorkspace('close');
    }
    if (now.tokenFieldOpen) {
      const outcome = leaveOutcome(secretMode(now.status?.githubToken ?? null), now.tokenDraft, tokenInFlight.current);
      if (outcome === 'apply') void applyToken('close');
      else if (outcome === 'discard' && now.tokenDraft.trim()) cloudCarried.token = 'notChanged';
    }
  };
  const closingRef = useRef(closing);
  closingRef.current = closing;

  useEffect(() => {
    mounted.current = true;
    window.popbot.diag.log('prefs.cloud.mount', {});
    void refresh();
    // What the last visit left to say is on screen now.
    cloudCarried.key = null;
    cloudCarried.token = null;
    return () => {
      mounted.current = false;
      window.popbot.diag.log('prefs.cloud.unmount', {});
      closingRef.current();
    };
  }, [refresh]);

  // While GitHub access is not found, look again whenever the PopBot
  // window gets focus back: signing in with gh in a terminal then ticks
  // the row without a click.
  const githubMissing = status !== null && status.githubToken === null;
  useEffect(() => {
    if (!githubMissing) return;
    const onFocus = (): void => { void loadStatus(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [githubMissing, loadStatus]);

  // A deep link from New chat's missing-key note. The pane scrolled here
  // while the card was still empty; now that it has its real height it
  // is brought into view again, and once it is known that there is no
  // key, focus goes on from the heading to the key field.
  const landing = useRef(focusKey);
  useEffect(() => {
    if (!landing.current || !status) return;
    landing.current = false;
    document.getElementById('agents-cloud')?.scrollIntoView({ block: 'start' });
    if (status.apiKey === null) keyInputRef.current?.focus({ preventScroll: true });
  }, [status]);

  // Focus is never dropped: when a field closes or a button goes away,
  // focus moves to what took its place — unless the user has already
  // put it somewhere else.
  useEffect(() => {
    if (!focusRequest) return;
    const { target } = focusRequest;
    const row = target === 'githubAction' || target === 'githubField' ? githubRowRef.current : keyRowRef.current;
    if (!row) return;
    const active = document.activeElement;
    if (active && active !== document.body && !row.contains(active)) return;
    if (target === 'keyField' || target === 'workspaceField' || target === 'githubField') {
      const input = (target === 'keyField' ? keyInputRef : target === 'workspaceField' ? wsInputRef : tokenInputRef).current;
      // Selected, so the next paste replaces what is there.
      input?.focus();
      input?.select();
      return;
    }
    const first = row.querySelector<HTMLElement>('.setup-actions button, .setup-actions a')
      ?? row.querySelector<HTMLElement>('input');
    (first ?? row).focus();
  }, [focusRequest]);

  const checkAgain = async (): Promise<void> => {
    if (rechecking) return;
    setRechecking(true);
    await checkKeyInUse();
    if (!mounted.current) return;
    setRechecking(false);
    setFocusRequest({ target: 'keyAction' });
  };

  const lookAgain = async (): Promise<void> => {
    if (looking) return;
    setLooking(true);
    setGithubNote(null);
    const next = await loadStatus();
    if (!mounted.current) return;
    setLooking(false);
    if (!next) return;
    if (next.githubToken === null) setGithubNote('stillNone');
    else setFocusRequest({ target: 'githubAction' });
  };

  const askRemove = (what: 'key' | 'token' | 'workspace'): void => {
    removeOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    removeAsked.current = what;
    setRemoving(what);
  };

  const keepIt = (): void => {
    if (!removeAsked.current) return;
    removeAsked.current = null;
    setRemoving(null);
    removeOpener.current?.focus();
  };

  const removeIt = async (): Promise<void> => {
    // ConfirmDialog confirms on Enter wherever focus is. Enter on its
    // keep button must keep.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest('.confirm-foot') && !focused.classList.contains('danger')) {
      keepIt();
      return;
    }
    // Enter reaches the dialog twice (its key handler, then the button's
    // click): the first call takes the request.
    const what = removeAsked.current;
    if (!what) return;
    removeAsked.current = null;
    setRemoving(null);
    window.popbot.diag.log('prefs.cloud.remove', { what });
    const field = what === 'key' ? 'apiKey' : what === 'token' ? 'githubToken' : 'workspaceId';
    try {
      await onSave(withoutField(latest.current.saved, field));
    } catch (err) {
      window.popbot.diag.log('prefs.cloud.remove.failed', { what, error: errorMessage(err) });
    }
    if (!mounted.current) return;
    if (what === 'token') {
      setGithubNote(null);
      await loadStatus();
      if (mounted.current) setFocusRequest({ target: 'githubAction' });
      return;
    }
    if (what === 'key') {
      // Only the saved key goes. If the environment has one, cloud
      // chats run on that now, so it is checked.
      setKeyNote(null);
      await refresh();
    } else {
      setWsVerdict(null);
      setWsNote(null);
      if (latest.current.status?.apiKey) await checkKeyInUse();
    }
    if (mounted.current) setFocusRequest({ target: 'keyAction' });
  };

  const footer = cloudFooter(status, check);
  const keyLine = keyFieldLine({ source: keySource, draft: keyDraft, checking: keyBusy, verdict: keyVerdict, note: keyNote });
  const keyNoteShown = keyFieldOpen ? null : keyNoteLine(keyNote, keySource);
  const wsLine = workspaceLine({ fieldOpen: wsFieldOpen, draft: wsDraft, busy: wsBusy, verdict: wsVerdict, note: wsNote });
  const tokenLine = tokenFieldLine({ source: githubSource, draft: tokenDraft, problem: tokenProblem });
  const githubNoteShown = tokenFieldOpen ? null : githubNoteLine(githubNote, githubSource);
  const removal = removing && {
    key: {
      title: t('prefs.agents.cloud.key.remove.title'),
      message: t('prefs.agents.cloud.key.remove.body'),
      confirm: t('prefs.agents.cloud.key.remove.confirm'),
      cancel: t('prefs.agents.cloud.key.remove.cancel'),
    },
    token: {
      title: t('prefs.agents.cloud.github.remove.title'),
      message: t('prefs.agents.cloud.github.remove.body'),
      confirm: t('prefs.agents.cloud.github.remove.confirm'),
      cancel: t('prefs.agents.cloud.github.remove.cancel'),
    },
    workspace: {
      title: t('prefs.agents.cloud.ws.remove.title'),
      message: t('prefs.agents.cloud.ws.remove.body'),
      confirm: t('prefs.agents.cloud.ws.remove.confirm'),
      cancel: t('prefs.agents.cloud.ws.remove.cancel'),
    },
  }[removing];

  const keyTitleId = 'agents-cloud-key-title';
  const keyLineId = 'agents-cloud-key-line';
  const wsInputId = 'agents-cloud-ws-input';
  const wsSavedId = 'agents-cloud-ws-saved';
  const wsLineId = 'agents-cloud-ws-line';
  const githubTitleId = 'agents-cloud-github-title';
  const githubLineId = 'agents-cloud-github-line';

  return (
    <FeatureSection id="cloud" arrived={arrived}>
      <FeatureHead
        id="cloud"
        title={t('prefs.agents.cloud.title')}
        pill={cloudPill(status, check)}
      />
      <p className="pref-section-desc">{t('prefs.agents.cloud.about')}</p>

      <div className="host-card setup-card">
        {/* The row takes focus itself (it is no tab stop) so that a click
            on its own text — selecting the message Anthropic sent, say —
            is not read as leaving it. */}
        <div className="setup-row" ref={keyRowRef} tabIndex={-1} onBlur={onRowBlur(keyRowRef, keyRowLeft)}>
          <SetupMark kind={keyView.mark} step={1} />
          <div>
            <div className="pref-label-title" id={keyTitleId}>{t('prefs.agents.cloud.apiKey.title')}</div>
            <div className="pref-label-desc" role="status">
              {keyView.sentence.map((key) => t(key)).join(' ')}
            </div>
            {keyView.detail && <div className="pref-state-detail">{keyView.detail}</div>}
          </div>
          <div className="setup-actions">
            {keyView.mode === 'replace' && keyOpen ? (
              <button type="button" className="btn sm" onClick={() => closeKeyField(true)}>
                {t('prefs.agents.cloud.key.keep')}
              </button>
            ) : keyView.actions.map((action) => {
              switch (action) {
                case 'getKey':
                  // Leaves the app: the arrow says so.
                  return (
                    <a
                      key={action}
                      className="btn-link"
                      href={API_KEYS_URL}
                      onClick={(e) => { e.preventDefault(); window.open(API_KEYS_URL, '_blank'); }}
                    >
                      {t('prefs.agents.cloud.key.get')} <i className="fa-solid fa-arrow-up-right-from-square" aria-hidden />
                    </a>
                  );
                case 'checkAgain':
                  // aria-disabled, not disabled: focus stays on it while the check runs.
                  return (
                    <button key={action} type="button" className="btn sm" aria-disabled={rechecking || undefined} onClick={() => void checkAgain()}>
                      {t('prefs.agents.cloud.action.checkAgain')}
                    </button>
                  );
                case 'useOther':
                  return (
                    <button key={action} type="button" className="btn sm" onClick={openKeyField}>
                      {t('prefs.agents.cloud.key.useOther')}
                    </button>
                  );
                case 'replace':
                  return (
                    <button key={action} type="button" className="btn sm" aria-describedby={keyTitleId} onClick={openKeyField}>
                      {t('prefs.agents.cloud.action.replace')}
                    </button>
                  );
                default:
                  return (
                    <button key={action} type="button" className="btn sm ghost" aria-describedby={keyTitleId} onClick={() => askRemove('key')}>
                      {t('prefs.agents.cloud.action.remove')}
                    </button>
                  );
              }
            })}
          </div>
          <div className="setup-more">
            {keyFieldOpen && (
              <div className="setup-field">
                <input
                  ref={keyInputRef}
                  className="pref-input mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-ant-…"
                  value={keyDraft}
                  readOnly={keyBusy}
                  aria-labelledby={keyTitleId}
                  aria-describedby={keyLineId}
                  aria-invalid={keyLine.invalid || undefined}
                  onChange={(e) => {
                    // The red line is about what was there: it clears on the first edit.
                    setKeyDraft(e.target.value);
                    setKeyVerdict(null);
                    setKeyNote(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void applyKey('enter');
                    } else if (e.key === 'Escape' && !keyBusy) {
                      // Esc keeps the current key; with none yet, it empties the field.
                      e.preventDefault();
                      e.stopPropagation();
                      if (keyView.mode === 'replace') closeKeyField(true);
                      else {
                        setKeyDraft('');
                        setKeyVerdict(null);
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  className={`btn sm${keyDraft.trim() && !keyBusy ? ' primary' : ''}`}
                  disabled={!keyDraft.trim()}
                  aria-disabled={keyBusy || undefined}
                  onClick={() => void applyKey('button')}
                >
                  {keyBusy
                    ? <><i className="fa-solid fa-spinner fa-spin" aria-hidden /> {t('prefs.agents.cloud.key.checkingBtn')}</>
                    : t('prefs.agents.cloud.key.check')}
                </button>
              </div>
            )}
            <div id={keyLineId} role="status">
              {keyFieldOpen && (
                <>
                  <StateLineView line={keyLine.line}>
                    {keyLine.stillInUse && <>{' '}{t('prefs.agents.cloud.key.stillInUse')}</>}
                  </StateLineView>
                  {keyLine.detail && <div className="pref-state-detail">{keyLine.detail}</div>}
                </>
              )}
              {keyNoteShown && <StateLineView line={keyNoteShown} />}
            </div>

            {workspace === 'sentence' && (
              <div className="setup-sub">
                <span id={wsSavedId}>{t('prefs.agents.cloud.ws.saved', { id: savedWorkspace ?? '' })}</span>
                <button type="button" className="btn-link" aria-describedby={wsSavedId} onClick={openWorkspaceField}>
                  {t('prefs.agents.cloud.ws.change')}
                </button>
                <button type="button" className="btn-link" aria-describedby={wsSavedId} onClick={() => askRemove('workspace')}>
                  {t('prefs.agents.cloud.action.remove')}
                </button>
              </div>
            )}
            {workspace === 'addLink' && (
              <div className="setup-sub">
                <button type="button" className="btn-link" onClick={openWorkspaceField}>
                  {t('prefs.agents.cloud.ws.add')}
                </button>
              </div>
            )}
            {wsFieldOpen && (
              <div className="setup-field">
                <label htmlFor={wsInputId}>{t('prefs.agents.cloud.workspace.title')}</label>
                <input
                  ref={wsInputRef}
                  id={wsInputId}
                  className="pref-input mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="wrkspc_…"
                  value={wsDraft}
                  readOnly={wsBusy || keyBusy}
                  aria-describedby={wsLineId}
                  aria-invalid={wsVerdict === 'fail' || undefined}
                  onChange={(e) => {
                    setWsDraft(e.target.value);
                    setWsVerdict(null);
                    setWsDetail(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void applyWorkspace('enter');
                    } else if (e.key === 'Escape' && !wsBusy && !keyBusy) {
                      // Esc keeps the current ID; with none yet, it puts the field away.
                      e.preventDefault();
                      e.stopPropagation();
                      closeWorkspaceField(true);
                    }
                  }}
                />
                {/* Beside a typed key, the key's own button checks both;
                    with no key at all there is nothing to check yet. */}
                {!keyTyped && keySource !== null && (
                  <button
                    type="button"
                    className={`btn sm${wsDraft.trim() && !wsBusy ? ' primary' : ''}`}
                    disabled={!wsDraft.trim()}
                    aria-disabled={wsBusy || undefined}
                    onClick={() => void applyWorkspace('button')}
                  >
                    {wsBusy
                      ? <><i className="fa-solid fa-spinner fa-spin" aria-hidden /> {t('prefs.agents.cloud.key.checkingBtn')}</>
                      : t('prefs.agents.cloud.key.check')}
                  </button>
                )}
                {wsMode === 'replace' && (
                  <button type="button" className="btn sm" onClick={() => closeWorkspaceField(true)}>
                    {t('prefs.agents.cloud.ws.keep')}
                  </button>
                )}
              </div>
            )}
            <div id={wsLineId} role="status">
              {wsLine && <StateLineView line={wsLine} />}
              {wsFieldOpen && wsVerdict === 'fail' && wsDetail && <div className="pref-state-detail">{wsDetail}</div>}
            </div>
          </div>
        </div>

        <div className="setup-row" ref={githubRowRef} tabIndex={-1} onBlur={onRowBlur(githubRowRef, githubRowLeft)}>
          <SetupMark kind={looking ? 'checking' : githubView.mark} step={2} />
          <div>
            <div className="pref-label-title" id={githubTitleId}>{t('prefs.agents.cloud.github.title')}</div>
            <div className="pref-label-desc" role="status">
              {githubView.sentence ? t(githubView.sentence) : ''}
            </div>
          </div>
          <div className="setup-actions">
            {tokenFieldOpen ? (
              <button type="button" className="btn sm" onClick={() => closeTokenField(true)}>
                {t(tokenCloseKey(githubSource))}
              </button>
            ) : githubView.actions.map((action) => {
              switch (action) {
                case 'lookAgain':
                  return (
                    <button key={action} type="button" className="btn sm" aria-disabled={looking || undefined} onClick={() => void lookAgain()}>
                      {looking ? t('prefs.agents.cloud.github.looking') : t('prefs.agents.cloud.github.lookAgain')}
                    </button>
                  );
                case 'paste':
                  return (
                    <button key={action} type="button" className="btn sm" onClick={openTokenField}>
                      {t('prefs.agents.cloud.github.paste')}
                    </button>
                  );
                case 'useToken':
                  return (
                    <button key={action} type="button" className="btn sm" onClick={openTokenField}>
                      {t('prefs.agents.cloud.github.useToken')}
                    </button>
                  );
                case 'replace':
                  return (
                    <button key={action} type="button" className="btn sm" aria-describedby={githubTitleId} onClick={openTokenField}>
                      {t('prefs.agents.cloud.action.replace')}
                    </button>
                  );
                default:
                  return (
                    <button key={action} type="button" className="btn sm ghost" aria-describedby={githubTitleId} onClick={() => askRemove('token')}>
                      {t('prefs.agents.cloud.action.remove')}
                    </button>
                  );
              }
            })}
          </div>
          <div className="setup-more">
            {githubView.howTo && !tokenFieldOpen && (
              <p className="pref-state">
                <i className={lineIcon('hint')} aria-hidden />
                <span>
                  {t('prefs.agents.cloud.github.howTo.before')}{' '}
                  <code className="pref-code">gh auth login</code>{' '}
                  {t('prefs.agents.cloud.github.howTo.after')}
                </span>
              </p>
            )}
            {tokenFieldOpen && (
              <div className="setup-field">
                <input
                  ref={tokenInputRef}
                  className="pref-input mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="ghp_… or github_pat_…"
                  value={tokenDraft}
                  aria-labelledby={githubTitleId}
                  aria-describedby={githubLineId}
                  aria-invalid={tokenLine.invalid || undefined}
                  onChange={(e) => {
                    setTokenDraft(e.target.value);
                    setTokenProblem(null);
                    setTokenError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void applyToken('enter');
                    } else if (e.key === 'Escape') {
                      // Esc keeps what is in use; with nothing yet, it puts the field away.
                      e.preventDefault();
                      e.stopPropagation();
                      closeTokenField(true);
                    }
                  }}
                />
                <button
                  type="button"
                  className={`btn sm${tokenDraft.trim() ? ' primary' : ''}`}
                  disabled={!tokenDraft.trim()}
                  onClick={() => void applyToken('button')}
                >
                  {t('prefs.agents.cloud.github.use')}
                </button>
              </div>
            )}
            <div id={githubLineId} role="status">
              {tokenFieldOpen && !tokenError && <StateLineView line={tokenLine.line} />}
              {/* Only a failed write to the settings store ends up here:
                  there is nothing to say but what it said. */}
              {tokenFieldOpen && tokenError && (
                <p className="pref-state error">
                  <i className={lineIcon('error')} aria-hidden />
                  <span>{tokenError}</span>
                </p>
              )}
              {githubNoteShown && <StateLineView line={githubNoteShown} />}
            </div>
          </div>
        </div>

        {footer && (
          <div className="setup-next">
            {onNewCloudChat && (
              <button type="button" className="btn sm primary" onClick={onNewCloudChat}>
                <i className="fa-solid fa-cloud" aria-hidden /> {t('prefs.agents.cloud.next.newChat')}
              </button>
            )}
            {/* Plain words that match the real controls: their names are
                read from the strings those controls use. */}
            <span className="setup-next-how">
              {footer === 'ready'
                ? t('prefs.agents.cloud.next.manual', { newChat: t('common.newChat'), cloud: t('agent.cloudToggle') })
                : t('prefs.agents.cloud.next.noGithub')}
            </span>
            <span className="setup-next-note">
              {t('prefs.agents.cloud.next.stop', { item: t('chat.cloud.shutdown') })}
            </span>
          </div>
        )}
      </div>

      {removal && (
        <ConfirmDialog
          title={removal.title}
          message={removal.message}
          confirmLabel={removal.confirm}
          cancelLabel={removal.cancel}
          destructive
          onConfirm={() => void removeIt()}
          onCancel={keepIt}
        />
      )}
    </FeatureSection>
  );
}

/**
 * Hosts: other boxes running popbot-host that chats can run on. A
 * host's fields save themselves when left; each saved host is asked
 * what it is, and its answer (version, CLIs, repositories) is shown
 * under it. Adding a host makes its record at once, with the local
 * daemon's address filled in.
 */
function PrefsHosts({ onGoTo }: { onGoTo: (section: string) => void }): JSX.Element {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostRecord[] | null>(null);
  const [removing, setRemoving] = useState<HostRecord | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.popbot.hosts.list().then((list) => { if (!cancelled) setHosts(list); });
    return () => { cancelled = true; };
  }, []);
  const add = async (): Promise<void> => {
    const created = await window.popbot.hosts.save({
      name: t('prefs.hosts.defaultName'),
      url: 'http://127.0.0.1:7677',
      token: '',
    });
    setHosts((prev) => [...(prev ?? []), created]);
  };
  const remove = async (host: HostRecord): Promise<void> => {
    await window.popbot.hosts.remove(host.id);
    setHosts((prev) => (prev ?? []).filter((h) => h.id !== host.id));
    setRemoving(null);
  };
  return (
    <div className="pref-section">
      <h3>{t('prefs.hosts.title')}</h3>
      <p className="pref-section-desc">{t('prefs.hosts.desc')}</p>
      <pre className="host-howto">{[
        'npm run build:host',
        'node dist-host/popbot-host.cjs --init --repo popbot=/path/to/repo',
        'node dist-host/popbot-host.cjs',
      ].join('\n')}</pre>
      {/* This computer is always a host and cannot be removed; its
          repositories and slot pools are the Repositories section. */}
      <LocalHostCard onGoTo={onGoTo} />
      {hosts && hosts.length === 0 && (
        <p className="pref-section-desc" style={{ marginTop: 10 }}>{t('prefs.hosts.none')}</p>
      )}
      {hosts?.map((h) => (
        <HostCard
          key={h.id}
          host={h}
          onSaved={(saved) => setHosts((prev) => (prev ?? []).map((x) => (x.id === saved.id ? saved : x)))}
          onRemove={() => setRemoving(h)}
        />
      ))}
      <div style={{ marginTop: 12 }}>
        <button className="btn sm" onClick={() => void add()}>
          <i className="fa-solid fa-plus" aria-hidden /> {t('prefs.hosts.add')}
        </button>
      </div>
      {removing && (
        <ConfirmDialog
          title={t('prefs.hosts.removeTitle')}
          message={t('prefs.hosts.removeConfirm', { name: removing.name })}
          confirmLabel={t('prefs.hosts.remove')}
          destructive
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

function LocalHostCard({ onGoTo }: { onGoTo: (section: string) => void }): JSX.Element {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<RepoRecord[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.popbot.repos.list().then((list) => { if (!cancelled) setRepos(list); });
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="host-card local">
      <div className="host-card-head">
        <i className="fa-solid fa-laptop" aria-hidden />
        <span className="host-card-title">{t('hosts.tab.local')}</span>
        <span className="host-card-status">{t('prefs.hosts.local.desc')}</span>
      </div>
      <div className="host-repos" style={{ borderTop: 0, paddingTop: 0 }}>
        {repos && repos.length === 0 && <div className="pref-label-desc">{t('prefs.hosts.local.noRepos')}</div>}
        {repos?.map((r) => (
          <div key={r.id} className="host-repo-line">
            <span className="host-repo-id mono" style={{ borderLeft: `3px solid ${r.color}`, paddingLeft: 6 }}>{r.id}</span>
            <span className={`repo-card-mode mode-${r.mode}`}>
              {r.mode === 'ephemeral' ? t('prefs.repos.mode.ephemeral') : t('prefs.repos.mode.slots', { count: r.slotCount })}
            </span>
            <span className="mono host-repo-path" title={r.repoPath}>{r.repoPath}</span>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => onGoTo('repos')}>
            <i className="fa-solid fa-code-fork" aria-hidden /> {t('prefs.hosts.local.manage')}
          </button>
        </div>
      </div>
    </div>
  );
}

function HostCard({
  host,
  onSaved,
  onRemove,
}: {
  host: HostRecord;
  onSaved: (saved: HostRecord) => void;
  onRemove: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(host.name);
  const [url, setUrl] = useState(host.url);
  const [token, setToken] = useState(host.token);
  const [probe, setProbe] = useState<{ state: 'idle' | 'checking' | 'ok' | 'error'; info?: HostInfo; error?: string }>({ state: 'idle' });
  // Bumped after a repository edit so the card re-reads the host.
  const [probeAt, setProbeAt] = useState(0);
  const commit = useAutoCommit({
    draft: () => ({ name, url, token }),
    saved: () => ({ name: host.name, url: host.url, token: host.token }),
    write: async (next) => { onSaved(await window.popbot.hosts.save({ id: host.id, ...next })); },
  });
  // Ask the host what it is whenever its saved address changes.
  useEffect(() => {
    if (!host.url.trim() || !host.token.trim()) {
      setProbe({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setProbe((prev) => (prev.state === 'ok' ? prev : { state: 'checking' }));
    void window.popbot.hosts.probe(host.url, host.token).then((r) => {
      if (cancelled) return;
      setProbe(r.ok ? { state: 'ok', info: r.info } : { state: 'error', error: r.error });
    });
    return () => { cancelled = true; };
  }, [host.url, host.token, probeAt]);
  const yesNo = (ok: boolean): string => (ok ? t('prefs.hosts.found') : t('prefs.hosts.missing'));
  const status = probe.state === 'checking'
    ? t('prefs.hosts.checking')
    : probe.state === 'error'
      ? t('prefs.hosts.error', { error: probe.error ?? '' })
      : probe.state === 'ok' && probe.info
        ? t('prefs.hosts.ok', {
            version: probe.info.version,
            platform: probe.info.platform,
            claude: yesNo(probe.info.claude.ok),
            codex: yesNo(probe.info.codex.ok),
            repos: probe.info.repos.length > 0 ? probe.info.repos.map((r) => r.id).join(', ') : t('prefs.hosts.okNoRepos'),
          })
        : t('prefs.hosts.noUrl');
  return (
    <div className="host-card">
      <div className="host-card-fields">
        <label className="host-card-field">
          <span>{t('prefs.hosts.name')}</span>
          <input
            className="pref-input narrow"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
          />
        </label>
        <label className="host-card-field">
          <span>{t('prefs.hosts.url')}</span>
          <input
            className="pref-input mono narrow"
            placeholder="http://127.0.0.1:7677"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
          />
        </label>
        <label className="host-card-field">
          <span>{t('prefs.hosts.token')}</span>
          <input
            className="pref-input mono narrow"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
          />
        </label>
      </div>
      <div className="host-card-foot">
        <span className={`host-card-status${probe.state === 'error' ? ' error' : ''}${probe.state === 'ok' ? ' ok' : ''}`}>
          {probe.state === 'ok' && <i className="fa-solid fa-circle-check" aria-hidden />}
          {probe.state === 'error' && <i className="fa-solid fa-circle-exclamation" aria-hidden />}
          {status}
        </span>
        <button className="btn sm danger" onClick={onRemove}>{t('prefs.hosts.remove')}</button>
      </div>
      {/* The host's repositories and their slot pools live in its config;
          these rows edit it in place. */}
      {probe.state === 'ok' && probe.info && (
        <div className="host-repos">
          <div className="host-repos-head">{t('prefs.hosts.repos.title')}</div>
          {probe.info.repos.length === 0 && (
            <div className="pref-label-desc">{t('prefs.hosts.repos.none')}</div>
          )}
          {probe.info.repos.map((r) => (
            <HostRepoRow
              key={r.id}
              hostId={host.id}
              hostName={host.name}
              repo={r}
              onChanged={() => setProbeAt(Date.now())}
            />
          ))}
          <AddHostRepo hostId={host.id} onAdded={() => setProbeAt(Date.now())} />
        </div>
      )}
    </div>
  );
}

/** One repository on a host. Fields save when left; the host rewrites
 *  its config and the card re-reads it. */
function HostRepoRow({
  hostId,
  hostName,
  repo,
  onChanged,
}: {
  hostId: string;
  hostName: string;
  repo: HostRepo;
  onChanged: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [path, setPath] = useState(repo.path);
  const [defaultBase, setDefaultBase] = useState(repo.defaultBase);
  const [slotPrefix, setSlotPrefix] = useState(repo.slotPrefix);
  const [slotCount, setSlotCount] = useState(String(repo.slotCount));
  const [mode, setMode] = useState<'slots' | 'ephemeral'>(repo.mode);
  const [error, setError] = useState<string | null>(null);
  const commit = useAutoCommit({
    draft: () => ({ path, defaultBase, slotPrefix, slotCount: Math.max(0, Number(slotCount) || 0), mode }),
    saved: () => ({ path: repo.path, defaultBase: repo.defaultBase, slotPrefix: repo.slotPrefix, slotCount: repo.slotCount, mode: repo.mode }),
    write: async (next) => {
      const res = await window.popbot.hosts.saveRepo(hostId, { id: repo.id, ...next });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      onChanged();
    },
  });
  const remove = async (): Promise<void> => {
    if (!confirm(t('prefs.hosts.repos.removeConfirm', { repo: repo.id, host: hostName }))) return;
    const res = await window.popbot.hosts.removeRepo(hostId, repo.id);
    if (!res.ok) setError(res.error);
    else onChanged();
  };
  return (
    <div className="host-repo">
      <div className="host-repo-head">
        <span className="host-repo-id mono">{repo.id}</span>
        <span className={`repo-card-mode mode-${mode}`}>
          {mode === 'ephemeral' ? t('prefs.repos.mode.ephemeral') : t('prefs.repos.mode.slots', { count: Number(slotCount) || 0 })}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn sm danger" onClick={() => void remove()}>{t('prefs.hosts.repos.remove')}</button>
      </div>
      <div className="host-repo-fields">
        <label className="host-card-field" style={{ gridColumn: '1 / -1' }}>
          <span>{t('prefs.hosts.repos.path')}</span>
          <input className="pref-input mono narrow" value={path} onChange={(e) => setPath(e.target.value)} onBlur={() => void commit()} onKeyDown={blurOnEnter} />
        </label>
        <label className="host-card-field">
          <span>{t('prefs.hosts.repos.defaultBase')}</span>
          <input className="pref-input mono narrow" value={defaultBase} onChange={(e) => setDefaultBase(e.target.value)} onBlur={() => void commit()} onKeyDown={blurOnEnter} />
        </label>
        <label className="host-card-field">
          <span>{t('prefs.hosts.repos.mode')}</span>
          <select
            className="pref-select"
            value={mode}
            onChange={(e) => {
              const next = e.currentTarget.value === 'ephemeral' ? 'ephemeral' : 'slots';
              setMode(next);
              void commit({ mode: next });
            }}
          >
            <option value="slots">{t('prefs.hosts.repos.modeSlots')}</option>
            <option value="ephemeral">{t('prefs.hosts.repos.modeEphemeral')}</option>
          </select>
        </label>
        {mode === 'slots' && (
          <>
            <label className="host-card-field">
              <span>{t('prefs.hosts.repos.slotPrefix')}</span>
              <input className="pref-input mono narrow" value={slotPrefix} onChange={(e) => setSlotPrefix(e.target.value)} onBlur={() => void commit()} onKeyDown={blurOnEnter} />
            </label>
            <label className="host-card-field">
              <span>{t('prefs.hosts.repos.slotCount')}</span>
              <input className="pref-input mono narrow" type="number" min={0} max={64} value={slotCount} onChange={(e) => setSlotCount(e.target.value)} onBlur={() => void commit()} onKeyDown={blurOnEnter} />
            </label>
          </>
        )}
      </div>
      {error && <div className="host-card-status error" style={{ marginTop: 6 }}>{t('prefs.hosts.repos.error', { error })}</div>}
    </div>
  );
}

/** Adding a repository needs an id and a path at once, so this one row
 *  has a button; the fields above it save on their own. */
function AddHostRepo({ hostId, onAdded }: { hostId: string; onAdded: () => void }): JSX.Element {
  const { t } = useTranslation();
  const [id, setId] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async (): Promise<void> => {
    if (!id.trim() || !path.trim()) return;
    const res = await window.popbot.hosts.saveRepo(hostId, { id: id.trim(), path: path.trim() });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setId('');
    setPath('');
    onAdded();
  };
  return (
    <div className="host-repo-add">
      <input className="pref-input mono narrow" placeholder={t('prefs.hosts.repos.id')} value={id} onChange={(e) => setId(e.target.value)} style={{ width: 120 }} />
      <input className="pref-input mono narrow" placeholder={t('prefs.hosts.repos.path')} value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} style={{ flex: 1 }} />
      <button className="btn sm" disabled={!id.trim() || !path.trim()} onClick={() => void add()}>
        <i className="fa-solid fa-plus" aria-hidden /> {t('prefs.hosts.repos.add')}
      </button>
      {error && <div className="host-card-status error" style={{ flexBasis: '100%' }}>{t('prefs.hosts.repos.error', { error })}</div>}
    </div>
  );
}

function PrefsAttachments(): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const initial = get<AttachmentsSettings>('attachments', {}) ?? {};
  const savedDays = clampAttachmentTtlDays(initial.ttlDays ?? ATTACHMENT_TTL_DAYS_DEFAULT);
  const [days, setDays] = useState<number>(savedDays);

  // Tool-result retention lives in its own settings key but belongs on
  // this panel: both are "how long do we keep bulk we can't reconstruct".
  const tool = get<ToolRetentionSettings>('toolRetention', {}) ?? {};
  const savedToolDays = clampToolResultTtlDays(tool.resultTtlDays ?? DEFAULT_TOOL_RESULT_TTL_DAYS);
  const savedToolOn = tool.pruneResults !== false;
  const [toolDays, setToolDays] = useState<number>(savedToolDays);
  const [toolOn, setToolOn] = useState<boolean>(savedToolOn);

  // Sync once useSettings finishes loading — same pattern as PrefsApps:
  // the first render captures the default before the saved value lands.
  useEffect(() => { setDays(savedDays); }, [savedDays]);
  useEffect(() => { setToolDays(savedToolDays); }, [savedToolDays]);
  useEffect(() => { setToolOn(savedToolOn); }, [savedToolOn]);
  const commit = useAutoCommit<AttachmentsSettings>({
    draft: () => ({ ttlDays: clampAttachmentTtlDays(days) }),
    saved: () => ({ ttlDays: savedDays }),
    write: (next) => set('attachments', next),
  });
  const commitTool = useAutoCommit<ToolRetentionSettings>({
    draft: () => ({ resultTtlDays: clampToolResultTtlDays(toolDays), pruneResults: toolOn }),
    saved: () => ({ resultTtlDays: savedToolDays, pruneResults: savedToolOn }),
    write: (next) => set('toolRetention', next),
  });

  if (loading) return <div className="pref-section"><h3>{t('prefs.runtime.title')}</h3></div>;

  return (
    <div className="pref-section">
      <h3>{t('prefs.runtime.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.runtime.desc')}
      </p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.runtime.keepFor.title')}</div>
            <div className="pref-label-desc">
              {t('prefs.runtime.keepFor.desc', {
                default: ATTACHMENT_TTL_DAYS_DEFAULT,
                min: ATTACHMENT_TTL_DAYS_MIN,
                max: ATTACHMENT_TTL_DAYS_MAX,
              })}
            </div>
          </div>
          <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              className="pref-input mono"
              min={ATTACHMENT_TTL_DAYS_MIN}
              max={ATTACHMENT_TTL_DAYS_MAX}
              value={days}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setDays(n);
              }}
              onBlur={() => { setDays(clampAttachmentTtlDays(days)); void commit(); }}
              onKeyDown={blurOnEnter}
              style={{ width: 90 }}
            />
            <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>{t('common.days')}</span>
          </div>
        </div>

        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.runtime.toolResults.title')}</div>
            <div className="pref-label-desc">
              {t('prefs.runtime.toolResults.desc', { default: DEFAULT_TOOL_RESULT_TTL_DAYS })}
            </div>
          </div>
          <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label className="pref-radio" style={{ gap: 6, marginRight: 4 }}>
              <input
                type="checkbox"
                checked={toolOn}
                onChange={(e) => { setToolOn(e.target.checked); void commitTool({ pruneResults: e.target.checked }); }}
              />
              <span className="pref-radio-label">{t('prefs.runtime.toolResults.enable')}</span>
            </label>
            <input
              type="number"
              className="pref-input mono"
              min={1}
              max={3650}
              disabled={!toolOn}
              value={toolDays}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setToolDays(n);
              }}
              onBlur={() => { setToolDays(clampToolResultTtlDays(toolDays)); void commitTool(); }}
              onKeyDown={blurOnEnter}
              style={{ width: 90 }}
            />
            <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>{t('common.days')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}


/** Issue trackers selectable as the ticket source. Each has its own config
 *  form below; capabilities (status changes, project scoping, etc.) are
 *  declared in shared/ticketProvider.ts and feature-detected by the UI. */
const TRACKERS: SelectChoice[] = [
  { id: 'linear', label: 'Linear', icon: <img src={linearIcon} alt="" className="tracker-dd-ico" /> },
  { id: 'jira', label: 'Jira', icon: <img src={jiraIcon} alt="" className="tracker-dd-ico" /> },
  { id: 'github', label: 'GitHub', icon: <img src={githubIcon} alt="" className="tracker-dd-ico" /> },
];

/** Chat-bar / panel-header glyph per engine (white logo on dark, or emoji). */
const ENGINE_ICON: Record<GameEngineId, ReactNode> = {
  unity: <img src={unityEngineIcon} alt="" className="tracker-dd-ico" />,
  unreal: <img src={unrealEngineIcon} alt="" className="tracker-dd-ico" />,
  custom: <span className="engine-emoji-ico">📦</span>,
};

/** Custom (non-native) dropdown — square panels + an icon per option,
 *  which a native <select> can't render. Used for the ticket-source and
 *  game-engine selectors. */
function PrefsIntegrations({ onLinearChanged }: { onLinearChanged?: () => void }): JSX.Element {
  const { t } = useTranslation();
  const { get, set, remove, loading } = useSettings();
  const linear = get<LinearSettings>('linear', {}) ?? {};
  const jira = get<JiraSettings>('jira', {}) ?? {};
  // Which tracker feeds the Tickets queue. The selector is ALWAYS shown —
  // picking a tracker is the model even when only one ships (you always
  // have one; there's no "(None)"). Jira is roughed in at
  // shared/ticketProvider.ts and slots in as another <option> when its
  // client + queue wiring land — no structural change here.
  const rawTracker = get<string>('ticketSource', 'linear') ?? 'linear';

  // Validate the persisted value against the options that actually ship.
  // A stale/unsupported id (e.g. ticketSource:'jira' from an older build)
  // would otherwise render the fallback button with nothing selected while
  // the invalid value lingers in storage.
  const tracker = TRACKERS.some((t) => t.id === rawTracker) ? rawTracker : TRACKERS[0].id;

  // Heal a stale value in place so it stops being dead/invalid state. Only
  // writes when the stored value differs from the normalized one, so this
  // can't loop.
  useEffect(() => {
    if (!loading && rawTracker !== tracker) void set('ticketSource', tracker);
  }, [loading, rawTracker, tracker]);

  if (loading) return <div className="pref-section"><h3>{t('prefs.integ.ticketSource.title')}</h3></div>;

  return (
    <>
      <div className="pref-section">
        {/* One line: the section label + the tracker selector. Always
            shown — picking a tracker is the model even with a single
            option (no "(None)"); more slot in as <option>s here. */}
        <div className="tracker-select-row">
          <h3 style={{ margin: 0 }}>{t('prefs.integ.ticketSource.title')}</h3>
          <IconSelect
            value={tracker}
            onChange={(v) => {
              // Persist the new source, then nudge the Tickets queue to
              // re-fetch so it reflects the switched provider immediately
              // (same signal the per-tracker forms fire on save).
              void set('ticketSource', v).then(() => onLinearChanged?.());
            }}
            options={TRACKERS}
          />
        </div>
        <p className="pref-section-desc">
          {t('prefs.integ.ticketSource.desc')}
        </p>
        {/* The selected tracker's config, grouped in its own box. Only the
            active tracker's form is shown; switching the selector swaps it. */}
        <div className="tracker-config">
          <div className="tracker-config-head">
            {(TRACKERS.find((t) => t.id === tracker) ?? TRACKERS[0]).icon}
            <span>{(TRACKERS.find((t) => t.id === tracker) ?? TRACKERS[0]).label}</span>
          </div>
          <div className="tracker-config-body">
            {tracker === 'github' ? (
              <GithubForm />
            ) : tracker === 'jira' ? (
              <JiraForm
                initial={jira}
                onSave={async (next) => {
                  await set('jira', next);
                  onLinearChanged?.();
                }}
                onDisconnect={async () => {
                  await remove('jira');
                  onLinearChanged?.();
                }}
              />
            ) : (
              <LinearForm
                initial={linear}
                onSave={async (next) => {
                  await set('linear', next);
                  onLinearChanged?.();
                }}
                onDisconnect={async () => {
                  await remove('linear');
                  onLinearChanged?.();
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Game engines — INDEPENDENT panels (unlike the single-select ticket
          source). Each engine can be enabled + configured on its own; every
          enabled engine gets a Run button on the chat bar. */}
      <div className="pref-section">
        <h3 style={{ margin: 0 }}>{t('prefs.integ.gameEngine.title')}</h3>
        <p className="pref-section-desc">{t('prefs.integ.gameEngine.desc')}</p>
        {GAME_ENGINES.map((e) => (
          <div className="tracker-config" key={e.id} style={{ marginTop: 12 }}>
            <div className="tracker-config-head">
              {ENGINE_ICON[e.id]}
              <span>{e.label}</span>
            </div>
            <div className="tracker-config-body">
              <EngineConfigPanel engineId={e.id} />
            </div>
          </div>
        ))}
      </div>

      {/* Slack (chat / notifications source) is parked — it was never
          tested end-to-end, so we don't ship it as a working integration
          yet. Re-add the section once it's verified. */}
      {/* <PrefsSlack /> */}

      {/* Sentry / crash-reporting is parked too. This panel is "where work
          comes from"; crash reporting isn't a work source today — though as
          a workflow tool we could turn crashes into work later. Re-add a
          dedicated section if/when it earns one. (The main-process Sentry +
          Slack pollers are no-ops without config.) */}
      {/* <PrefsSentry /> */}
    </>
  );
}

// Parked integrations — still defined so re-enabling is a one-line change
// in PrefsIntegrations above, but not currently rendered (Slack untested,
// Sentry not a work source yet). These references keep TypeScript's
// no-unused-locals check happy without exporting the components.
void PrefsSlack;
void PrefsSentry;

interface GitSettings {
  username?: string;
  repoPath?: string;
  /** Short repo identifier — folder segment in worktree paths, prefix
   *  on parking branches, label in UI. Default `app`. */
  repoName?: string;
  /** CSS color for slot pills belonging to chats in this repo. Lets
   *  multi-repo installs visually distinguish slots at a glance.
   *  Default `#6b7cff` (the app accent / current pill color). */
  repoColor?: string;
  /** Filesystem + branch-name prefix per slot. Slot worktrees live at
   *  `<worktreesDir>/<slotPrefix>-N`; parking branches use the same
   *  prefix. Default `slot`. */
  slotPrefix?: string;
  worktreesDir?: string;
  defaultBase?: string;
}

function PrefsGit(): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const initial = get<GitSettings>('git', {}) ?? {};
  const scInitial = get<SourceControlSettings>('sourceControl', {}) ?? {};
  const [username, setUsername] = useState(initial.username ?? '');
  const [maxFiles, setMaxFiles] = useState<number>(
    clampMaxChangedFiles(scInitial.maxChangedFiles ?? MAX_CHANGED_FILES_DEFAULT),
  );
  // Two settings keys, one draft: each field writes its own key on blur.
  const commit = useAutoCommit<{ maxFiles: number; username: string }>({
    draft: () => ({ maxFiles: clampMaxChangedFiles(maxFiles), username: username.trim() }),
    saved: () => ({
      maxFiles: clampMaxChangedFiles(scInitial.maxChangedFiles ?? MAX_CHANGED_FILES_DEFAULT),
      username: initial.username ?? '',
    }),
    write: async (next) => {
      if (next.maxFiles !== clampMaxChangedFiles(scInitial.maxChangedFiles ?? MAX_CHANGED_FILES_DEFAULT)) {
        await set('sourceControl', { ...scInitial, maxChangedFiles: next.maxFiles } satisfies SourceControlSettings);
      }
      if (next.username !== (initial.username ?? '')) {
        await set('git', { ...initial, username: next.username });
      }
    },
  });

  // Same sync-on-load fix as PrefsApps / UnityConfig. Without this,
  // useState captures defaults while useSettings is still loading and
  // a subsequent Save overwrites real persisted values with defaults.
  useEffect(() => { setUsername(initial.username ?? ''); }, [initial.username]);
  useEffect(() => {
    setMaxFiles(clampMaxChangedFiles(scInitial.maxChangedFiles ?? MAX_CHANGED_FILES_DEFAULT));
  }, [scInitial.maxChangedFiles]);

  if (loading) return <div className="pref-section"><h3>{t('prefs.git.title')}</h3></div>;

  return (
    <div className="pref-section">
      <h3>{t('prefs.git.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.git.desc', { reposLink: t('prefs.git.reposLabel') })}
      </p>

      {/* Shared (git + perforce): the change-view file cap. */}
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.git.maxChangedFiles.title')}</div>
            <div className="pref-label-desc">
              {t('prefs.git.maxChangedFiles.desc', {
                min: MAX_CHANGED_FILES_MIN,
                max: MAX_CHANGED_FILES_MAX,
              })}
            </div>
          </div>
          <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              className="pref-input mono"
              min={MAX_CHANGED_FILES_MIN}
              max={MAX_CHANGED_FILES_MAX}
              value={maxFiles}
              onChange={(e) =>
                setMaxFiles(
                  Math.max(
                    MAX_CHANGED_FILES_MIN,
                    Math.min(MAX_CHANGED_FILES_MAX, Number(e.target.value) || MAX_CHANGED_FILES_DEFAULT),
                  ),
                )
              }
              onBlur={() => { setMaxFiles(clampMaxChangedFiles(maxFiles)); void commit(); }}
              onKeyDown={blurOnEnter}
              style={{ width: 100 }}
            />
          </div>
        </div>
      </div>

      {/* Git config sub-panel (icon + label header, like Integrations). */}
      <div className="tracker-config" style={{ marginTop: 16 }}>
        <div className="tracker-config-head">
          <i className="fa-solid fa-code-branch" />
          <span>{t('prefs.repos.scm.git')}</span>
        </div>
        <div className="tracker-config-body">
          <div className="pref-rows">
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.git.branchUsername.title')}</div>
                <div className="pref-label-desc">
                  {t('prefs.git.branchUsername.desc', { pattern: '<username>/<ticket>-<slug>' })}
                </div>
              </div>
              <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="pref-input mono"
                  placeholder={t('prefs.git.usernamePlaceholder')}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onBlur={() => void commit()}
                  onKeyDown={blurOnEnter}
                  style={{ width: 160 }}
                />
              </div>
            </div>
          </div>
          <h4 style={{ margin: '16px 0 6px', fontSize: 'var(--fs-sm)' }}>{t('prefs.git.actionTemplates.title')}</h4>
          <TemplatesGroup
            fields={GIT_ACTION_TEMPLATE_FIELDS}
            intro={
              <p className="pref-section-desc">
                {t('prefs.git.actionTemplates.intro', { macro: '${name}' })}
              </p>
            }
          />
        </div>
      </div>

      {/* Perforce config sub-panel — always shown alongside Git. */}
      <PerforceConfigPanel />
    </div>
  );
}

/** Perforce connection defaults + transfer/submit options. Always shown in
 *  Source control beside the Git panel (no enable toggle): a repo's SCM is
 *  detected per-folder, so both providers' settings are always relevant. The
 *  defaults pre-fill the Add-Repository → Perforce connect step; the rest are
 *  read by the p4 provider (parallel sync threads, revert-unchanged on submit). */
function PerforceConfigPanel(): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const initial = get<PerforceSettings>('perforce', {}) ?? {};
  const [p4Path, setP4Path] = useState(initial.p4Path ?? '');
  const [defaultPort, setDefaultPort] = useState(initial.defaultPort ?? '');
  const [defaultUser, setDefaultUser] = useState(initial.defaultUser ?? '');
  const [parallelThreads, setParallelThreads] = useState<number>(initial.parallelThreads ?? 4);
  const [revertUnchanged, setRevertUnchanged] = useState<boolean>(initial.revertUnchanged !== false);
  const [reviewPollSec, setReviewPollSec] = useState<number>(Math.round((initial.reviewPollIntervalMs ?? 120_000) / 1000));
  const commit = useAutoCommit<PerforceSettings>({
    draft: () => ({
      ...initial,
      p4Path: p4Path.trim() || undefined,
      defaultPort: defaultPort.trim() || undefined,
      defaultUser: defaultUser.trim() || undefined,
      parallelThreads,
      revertUnchanged,
      reviewPollIntervalMs: Math.min(3600, Math.max(30, reviewPollSec)) * 1000,
    }),
    saved: () => ({
      ...initial,
      p4Path: initial.p4Path || undefined,
      defaultPort: initial.defaultPort || undefined,
      defaultUser: initial.defaultUser || undefined,
      parallelThreads: initial.parallelThreads ?? 4,
      revertUnchanged: initial.revertUnchanged !== false,
      reviewPollIntervalMs: initial.reviewPollIntervalMs ?? 120_000,
    }),
    write: (next) => set('perforce', next),
  });
  const leave = (): void => void commit();

  useEffect(() => { setP4Path(initial.p4Path ?? ''); }, [initial.p4Path]);
  useEffect(() => { setDefaultPort(initial.defaultPort ?? ''); }, [initial.defaultPort]);
  useEffect(() => { setDefaultUser(initial.defaultUser ?? ''); }, [initial.defaultUser]);
  useEffect(() => { setParallelThreads(initial.parallelThreads ?? 4); }, [initial.parallelThreads]);
  useEffect(() => { setRevertUnchanged(initial.revertUnchanged !== false); }, [initial.revertUnchanged]);
  useEffect(() => { setReviewPollSec(Math.round((initial.reviewPollIntervalMs ?? 120_000) / 1000)); }, [initial.reviewPollIntervalMs]);

  if (loading) return <></>;

  return (
    <div className="tracker-config" style={{ marginTop: 16 }}>
      <div className="tracker-config-head">
        <P4Glyph style={{ color: 'var(--scm-perforce)' }} />
        <span>{t('prefs.repos.scm.perforce')}</span>
      </div>
      <div className="tracker-config-body">
        <div className="pref-rows">
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.perforce.p4Path.title')}</div>
              <div className="pref-label-desc">{t('prefs.perforce.p4Path.desc')}</div>
            </div>
            <div className="pref-control">
              <input className="pref-input mono" placeholder="p4" value={p4Path}
                     onChange={(e) => setP4Path(e.target.value)} onBlur={leave} onKeyDown={blurOnEnter} style={{ width: 240 }} />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.perforce.defaultPort.title')}</div>
              <div className="pref-label-desc">{t('prefs.perforce.defaultPort.desc')}</div>
            </div>
            <div className="pref-control">
              <input className="pref-input mono" placeholder="ssl:host:1666" value={defaultPort}
                     onChange={(e) => setDefaultPort(e.target.value)} onBlur={leave} onKeyDown={blurOnEnter} style={{ width: 240 }} />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.perforce.defaultUser.title')}</div>
              <div className="pref-label-desc">{t('prefs.perforce.defaultUser.desc')}</div>
            </div>
            <div className="pref-control">
              <input className="pref-input mono" placeholder="user" value={defaultUser}
                     onChange={(e) => setDefaultUser(e.target.value)} onBlur={leave} onKeyDown={blurOnEnter} style={{ width: 240 }} />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.perforce.parallelThreads.title')}</div>
              <div className="pref-label-desc">{t('prefs.perforce.parallelThreads.desc')}</div>
            </div>
            <div className="pref-control">
              <input type="number" className="pref-input mono" min={1} max={64} value={parallelThreads}
                     onChange={(e) => setParallelThreads(Math.max(1, Math.min(64, Number(e.target.value) || 1)))}
                     onBlur={leave} onKeyDown={blurOnEnter} style={{ width: 100 }} />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.perforce.revertUnchanged.title')}</div>
              <div className="pref-label-desc">{t('prefs.perforce.revertUnchanged.desc')}</div>
            </div>
            <div className="pref-control">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={revertUnchanged} onChange={(e) => { setRevertUnchanged(e.target.checked); void commit({ revertUnchanged: e.target.checked }); }} />
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-2)' }}>{t('prefs.perforce.revertUnchanged.toggle')}</span>
              </label>
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.perforce.reviewPoll.title')}</div>
              <div className="pref-label-desc">{t('prefs.perforce.reviewPoll.desc')}</div>
            </div>
            <div className="pref-control" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="number" className="pref-input mono" min={30} max={3600} value={reviewPollSec}
                     onChange={(e) => setReviewPollSec(Math.max(30, Math.min(3600, Number(e.target.value) || 30)))}
                     onBlur={leave} onKeyDown={blurOnEnter} style={{ width: 100 }} />
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-2)' }}>{t('prefs.perforce.reviewPoll.unit')}</span>
            </div>
          </div>
        </div>
        <h4 style={{ margin: '16px 0 6px', fontSize: 'var(--fs-sm)' }}>{t('prefs.p4.actionTemplates.title')}</h4>
        <TemplatesGroup
          fields={P4_ACTION_TEMPLATE_FIELDS}
          intro={
            <p className="pref-section-desc">
              {t('prefs.p4.actionTemplates.intro', { macro: '${name}' })}
            </p>
          }
        />
      </div>
    </div>
  );
}

interface AppsSettings {
  /** macOS app name to launch for "Terminal" — see open(1)'s -a flag. */
  terminalApp?: string;
  /** Windows shell for the in-app terminal panel: 'powershell' (default)
   *  | 'cmd' | 'pwsh' (PowerShell 7). Read by the main-process PTY. */
  windowsShell?: string;
  /** Editor handler id ('vscode' | 'cursor'). Maps to URL scheme. */
  editorApp?: string;
  /** macOS app name for the git client. Defaults to 'GitHub Desktop'. */
  gitApp?: string;
  /** Per-engine launch config (Unity / Unreal / Custom), independently
   *  enable-able. See @shared/gameEngine. */
  engines?: GameEnginesSettings;
  /** @deprecated pre-multi-engine Unity binary — folded into engines.unity. */
  unityBinary?: string;
  /** @deprecated pre-multi-engine Unity subpath — folded into engines.unity. */
  unityProjectSubpath?: string;
  /** Chrome profile directory to route URL opens to (e.g. "Profile 1",
   *  "Default", "Person 2"). When set, popbot launches every URL via
   *  Chrome with this profile pinned, sidestepping macOS' default
   *  "whichever window has focus" routing — useful when you have a
   *  personal + work Chrome both open. Blank = OS default browser. */
  browserChromeProfile?: string;
}

const TERMINAL_OPTIONS = [
  { value: 'iTerm', label: 'iTerm2' },
  // Add others (Terminal.app, Warp, Ghostty, …) once a teammate asks.
] as const;

const EDITOR_OPTIONS = [
  { value: 'vscode', label: 'Visual Studio Code' },
  // 'cursor' wired in main but no teammate uses it yet — surface it
  // when someone needs it.
] as const;

const WINDOWS_SHELL_OPTIONS = [
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: 'Command Prompt (cmd)' },
  { value: 'pwsh', label: 'PowerShell 7 (pwsh)' },
] as const;

const IS_WINDOWS = window.popbot.platform === 'win32';

function PrefsApps(): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const initial = get<AppsSettings>('apps', {}) ?? {};
  const [terminalApp, setTerminalApp] = useState(initial.terminalApp || 'iTerm');
  const [windowsShell, setWindowsShell] = useState(initial.windowsShell || 'powershell');
  const [editorApp, setEditorApp] = useState(initial.editorApp || 'vscode');
  const [browserChromeProfile, setBrowserChromeProfile] = useState(initial.browserChromeProfile || '');
  const commit = useAutoCommit<AppsSettings>({
    draft: () => ({
      ...initial,
      terminalApp,
      windowsShell,
      editorApp,
      browserChromeProfile: browserChromeProfile.trim() || undefined,
    }),
    saved: () => ({
      ...initial,
      terminalApp: initial.terminalApp || 'iTerm',
      windowsShell: initial.windowsShell || 'powershell',
      editorApp: initial.editorApp || 'vscode',
      browserChromeProfile: initial.browserChromeProfile || undefined,
    }),
    write: (next) => set('apps', next),
  });

  // useState only captures its initial value once, on first mount.
  // But useSettings starts with `loading=true` and an empty cache, so
  // the first render hits these `useState(initial.foo || default)`
  // expressions when `initial.foo` is undefined — meaning the inputs
  // render with defaults. Without this sync, hitting Save then
  // overwrites the real saved values with those defaults. Same
  // pattern PrefsRuntime uses at line ~150.
  useEffect(() => { setTerminalApp(initial.terminalApp || 'iTerm'); }, [initial.terminalApp]);
  useEffect(() => { setWindowsShell(initial.windowsShell || 'powershell'); }, [initial.windowsShell]);
  useEffect(() => { setEditorApp(initial.editorApp || 'vscode'); }, [initial.editorApp]);
  useEffect(() => { setBrowserChromeProfile(initial.browserChromeProfile || ''); }, [initial.browserChromeProfile]);

  if (loading) return <div className="pref-section"><h3>{t('prefs.apps.title')}</h3></div>;

  return (
    <div className="pref-section">
      <h3>{t('prefs.apps.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.apps.desc')}
      </p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.apps.terminal.title')}</div>
            <div className="pref-label-desc">{t('prefs.apps.terminal.desc')}</div>
          </div>
          <div className="pref-control">
            <select
              className="pref-input"
              value={terminalApp}
              onChange={(e) => { setTerminalApp(e.target.value); void commit({ terminalApp: e.target.value }); }}
              style={{ width: 200 }}
            >
              {TERMINAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        {IS_WINDOWS && (
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.apps.windowsShell.title')}</div>
              <div className="pref-label-desc">
                {t('prefs.apps.windowsShell.desc')}
              </div>
            </div>
            <div className="pref-control">
              <select
                className="pref-input"
                value={windowsShell}
                onChange={(e) => { setWindowsShell(e.target.value); void commit({ windowsShell: e.target.value }); }}
                style={{ width: 200 }}
              >
                {WINDOWS_SHELL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.apps.editor.title')}</div>
            <div className="pref-label-desc">
              {t('prefs.apps.editor.desc')}
            </div>
          </div>
          <div className="pref-control">
            <select
              className="pref-input"
              value={editorApp}
              onChange={(e) => { setEditorApp(e.target.value); void commit({ editorApp: e.target.value }); }}
              style={{ width: 200 }}
            >
              {EDITOR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.apps.gitClient.title')}</div>
            <div className="pref-label-desc">
              {t('prefs.apps.gitClient.desc')}
            </div>
          </div>
          <div className="pref-control" style={{ color: 'var(--fg-3)' }}>GitHub Desktop</div>
        </div>
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.apps.chromeProfile.title')}</div>
            <div className="pref-label-desc">
              {t('prefs.apps.chromeProfile.desc')}
            </div>
          </div>
          <div className="pref-control" style={{ flex: 1, minWidth: 240 }}>
            <input
              className="pref-input mono"
              placeholder={t('prefs.apps.chromeProfile.placeholder')}
              value={browserChromeProfile}
              onChange={(e) => setBrowserChromeProfile(e.target.value)}
              onBlur={() => void commit()}
              onKeyDown={blurOnEnter}
              style={{ width: '100%' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One engine's config panel (Unity / Unreal / Custom). Independent from the
 * others — its own enable toggle, detection, and setup fields. Unity/Unreal
 * detect installs + take an editor binary; Custom takes a posix + a Windows
 * run command. Persists under `apps.engines[engineId]`.
 */
function EngineConfigPanel({ engineId }: { engineId: GameEngineId }): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const apps = get<AppsSettings>('apps', {}) ?? {};
  const cfg: GameEngineConfig = apps.engines?.[engineId] ?? {};
  const isCustom = engineId === 'custom';
  // Legacy fallback for Unity's pre-multi-engine top-level fields.
  const legacyBinary = engineId === 'unity' ? apps.unityBinary : undefined;
  const legacySubpath = engineId === 'unity' ? apps.unityProjectSubpath : undefined;

  const [versions, setVersions] = useState<Array<{ version: string; binary: string }>>([]);
  const [scanning, setScanning] = useState(!isCustom);
  const [binary, setBinary] = useState(cfg.binary ?? legacyBinary ?? '');
  const [subpath, setSubpath] = useState(cfg.projectSubpath ?? legacySubpath ?? '');
  const [runPosix, setRunPosix] = useState(cfg.runPosix ?? '');
  const [runWindows, setRunWindows] = useState(cfg.runWindows ?? '');
  // Result of the Unity "install title-bar script" button (path or error).
  const [titleScript, setTitleScript] = useState<{ ok: boolean; msg: string } | null>(null);
  const enabled = engineEnabled(cfg, engineId);
  // MCP is only meaningful for the two detectable editors, not Custom.
  // Inline the narrowing so `engineId` is provably `'unity' | 'unreal'` at the
  // mcpDefaultBasePort call (a separate boolean const doesn't narrow it).
  const supportsMcp = engineId === 'unity' || engineId === 'unreal';
  // Engine MCP (Unity + Unreal): the base-port field is a free-text buffer (so
  // a mid-edit empty string doesn't snap back), committed to settings on blur.
  const engineDefaultMcpPort =
    engineId === 'unity' || engineId === 'unreal' ? mcpDefaultBasePort(engineId) : 0;
  const [mcpBasePort, setMcpBasePort] = useState(String(cfg.mcpBasePort ?? engineDefaultMcpPort));

  const refresh = async () => {
    if (isCustom) return;
    setScanning(true);
    setVersions(await window.popbot.engines.listVersions(engineId));
    setScanning(false);
  };
  useEffect(() => { void refresh(); }, []);

  // Re-sync from persisted values once they load (useSettings starts empty),
  // so the fields don't render blank and a Save can't clobber real values.
  useEffect(() => { setBinary(cfg.binary ?? legacyBinary ?? ''); }, [cfg.binary, legacyBinary]);
  useEffect(() => { setSubpath(cfg.projectSubpath ?? legacySubpath ?? ''); }, [cfg.projectSubpath, legacySubpath]);
  useEffect(() => { setRunPosix(cfg.runPosix ?? ''); }, [cfg.runPosix]);
  useEffect(() => { setRunWindows(cfg.runWindows ?? ''); }, [cfg.runWindows]);
  useEffect(() => {
    setMcpBasePort(String(cfg.mcpBasePort ?? engineDefaultMcpPort));
  }, [cfg.mcpBasePort, engineDefaultMcpPort]);

  // Merge a patch into apps.engines[engineId] (preserving other engines).
  const writeEngine = async (patch: Partial<GameEngineConfig>): Promise<void> => {
    // The three EngineConfigPanels (unity/unreal/custom) each keep an INDEPENDENT
    // useSettings() cache of `apps` that never re-syncs across siblings, so
    // `get('apps')` here can be stale — merging onto it would clobber a sibling's
    // just-saved engine. Re-read the freshest persisted value before merging.
    const fresh = await window.popbot.settings.getAll();
    const cur = (fresh.apps as AppsSettings | undefined) ?? {};
    const curEngines: GameEnginesSettings = cur.engines ?? {};
    const nextCfg: GameEngineConfig = { ...(curEngines[engineId] ?? {}), ...patch };
    await set('apps', { ...cur, engines: { ...curEngines, [engineId]: nextCfg } } satisfies AppsSettings);
  };

  // The typed fields (the switches above write on their own): a field
  // writes when left, a picked version at once.
  type EngineDraft = Pick<GameEngineConfig, 'binary' | 'projectSubpath' | 'runPosix' | 'runWindows'>;
  const commit = useAutoCommit<EngineDraft>({
    draft: () => (isCustom
      ? {
          projectSubpath: subpath.trim() || undefined,
          runPosix: runPosix.trim() || undefined,
          runWindows: runWindows.trim() || undefined,
        }
      : { binary: binary.trim() || undefined, projectSubpath: subpath.trim() || undefined }),
    saved: () => (isCustom
      ? {
          projectSubpath: cfg.projectSubpath || legacySubpath || undefined,
          runPosix: cfg.runPosix || undefined,
          runWindows: cfg.runWindows || undefined,
        }
      : { binary: cfg.binary || legacyBinary || undefined, projectSubpath: cfg.projectSubpath || legacySubpath || undefined }),
    write: (next) => writeEngine(next),
  });

  if (loading) return <p className="pref-section-desc">{t('common.loading')}</p>;

  const binaryPlaceholder =
    engineId === 'unity'
      ? 'Unity.exe  /  Unity.app/Contents/MacOS/Unity'
      : 'UnrealEditor.exe  /  UnrealEditor.app/Contents/MacOS/UnrealEditor';

  return (
    <div className="pref-rows">
      {/* Enable toggle — persists immediately so the chat bar reflects it. */}
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.engine.enabled')}</div>
          <div className="pref-label-desc">{t('prefs.engine.enabledDesc')}</div>
        </div>
        <div className="pref-control">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void writeEngine({ enabled: e.target.checked })}
          />
        </div>
      </div>

      {!isCustom && (
        <>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.engine.editorVersion.title')}</div>
              <div className="pref-label-desc">
                {scanning
                  ? t('prefs.engine.scanning')
                  : t('prefs.engine.installedCount', { count: versions.length })}{' '}
                ·{' '}
                <button
                  className="btn-link"
                  onClick={() => void refresh()}
                  style={{ background: 'none', border: 0, color: 'var(--acc-hi)', cursor: 'pointer', padding: 0 }}
                >
                  {t('prefs.engine.rescan')}
                </button>
              </div>
            </div>
            <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
              <select
                className="pref-input mono"
                value={binary}
                onChange={(e) => { setBinary(e.target.value); void commit({ binary: e.target.value || undefined }); }}
                style={{ width: '100%' }}
                disabled={versions.length === 0}
              >
                <option value="">{t('prefs.engine.selectVersion')}</option>
                {versions.map((v) => (
                  <option key={v.binary} value={v.binary}>{v.version}</option>
                ))}
              </select>
            </div>
          </div>
          {versions.length === 0 && !scanning && (
            <div className="pref-row wide">
              <div className="pref-error">
                <i className="fa-solid fa-circle-exclamation" />
                <div>{t('prefs.engine.noneFound')}</div>
              </div>
            </div>
          )}
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.engine.binary.title')}</div>
              <div className="pref-label-desc">{t('prefs.engine.binary.desc')}</div>
            </div>
            <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
              <input
                className="pref-input mono"
                placeholder={binaryPlaceholder}
                value={binary}
                onChange={(e) => setBinary(e.target.value)}
                onBlur={() => void commit()}
                onKeyDown={blurOnEnter}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        </>
      )}

      {isCustom && (
        <>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.engine.custom.posix.title')}</div>
              <div className="pref-label-desc">{t('prefs.engine.custom.posix.desc')}</div>
            </div>
            <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
              <input
                className="pref-input mono"
                placeholder="./run-editor.sh"
                value={runPosix}
                onChange={(e) => setRunPosix(e.target.value)}
                onBlur={() => void commit()}
                onKeyDown={blurOnEnter}
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.engine.custom.windows.title')}</div>
              <div className="pref-label-desc">{t('prefs.engine.custom.windows.desc')}</div>
            </div>
            <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
              <input
                className="pref-input mono"
                placeholder="run-editor.bat"
                value={runWindows}
                onChange={(e) => setRunWindows(e.target.value)}
                onBlur={() => void commit()}
                onKeyDown={blurOnEnter}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        </>
      )}

      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.engine.subpath.title')}</div>
          <div className="pref-label-desc">{t('prefs.engine.subpath.desc')}</div>
        </div>
        <div className="pref-control" style={{ minWidth: 240 }}>
          <input
            className="pref-input mono"
            placeholder={t('prefs.engine.subpath.placeholder')}
            value={subpath}
            onChange={(e) => setSubpath(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            style={{ width: 240 }}
          />
        </div>
      </div>

      {supportsMcp && (
        <>
          {/* Engine MCP (Unity / Unreal) — persists immediately (like the enable
              toggle). When on, each slot's Editor is launched with an MCP port
              derived from the base port + slot index. Title/desc are per-engine
              (Unity → IvanMurzak/Unity-MCP URL; Unreal → Epic's MCP plugin flags). */}
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t(`prefs.engine.mcp.${engineId}.title`)}</div>
              <div className="pref-label-desc">{t(`prefs.engine.mcp.${engineId}.desc`)}</div>
            </div>
            <div className="pref-control">
              <input
                type="checkbox"
                // Coerce to a strict boolean so the box is always checked or
                // unchecked — never renders indeterminate from a stray value.
                checked={cfg.useMcp === true}
                onChange={(e) => void writeEngine({ useMcp: e.target.checked })}
              />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.engine.mcp.basePort.title')}</div>
              <div className="pref-label-desc">{t('prefs.engine.mcp.basePort.desc')}</div>
            </div>
            <div className="pref-control" style={{ minWidth: 120 }}>
              <input
                className="pref-input mono"
                type="number"
                min={1024}
                max={65535}
                disabled={cfg.useMcp !== true}
                value={mcpBasePort}
                onChange={(e) => setMcpBasePort(e.target.value)}
                onBlur={() => {
                  // Commit: blank restores the engine default; otherwise clamp to
                  // a valid port range (Number('') is 0, so guard blank first).
                  const raw = mcpBasePort.trim();
                  const n = Math.round(Number(raw));
                  const port =
                    raw === '' || !Number.isFinite(n)
                      ? engineDefaultMcpPort
                      : Math.min(65535, Math.max(1024, n));
                  setMcpBasePort(String(port));
                  void writeEngine({ mcpBasePort: port });
                }}
                style={{ width: 120 }}
              />
            </div>
          </div>
        </>
      )}

      {engineId === 'unity' && (
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.engine.unityTitleScript.title')}</div>
            <div className="pref-label-desc">{t('prefs.engine.unityTitleScript.desc')}</div>
          </div>
          <div className="pref-control" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn sm"
              onClick={() => {
                setTitleScript(null);
                void window.popbot.engines.installUnityTitleScript().then((r) =>
                  setTitleScript(
                    r.ok
                      ? { ok: true, msg: t('prefs.engine.unityTitleScript.done', { path: r.path }) }
                      : { ok: false, msg: r.error },
                  ),
                );
              }}
            >
              {t('prefs.engine.unityTitleScript.button')}
            </button>
            {titleScript && (
              <span
                className="mono"
                style={{ fontSize: 11, color: titleScript.ok ? 'var(--st-done)' : 'var(--st-err)' }}
              >
                {titleScript.msg}
              </span>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

interface TemplatesSettings {
  startTicket?: string;
  startCodeReview?: string;
  reReview?: string;
  /** The one-liner sent automatically in RAPID RE-REVIEW mode. */
  rapidReReview?: string;
  commitAi?: string;
  pushPr?: string;
  pushDraftPr?: string;
  makePrReady?: string;
  addressCr?: string;
  rebaseBase?: string;
  // Perforce panel action templates.
  p4NewCr?: string;
  p4AddressCr?: string;
  runTests?: string;
  p4ReviewCommit?: string;
  /** @deprecated pre-split combined "code review" template (kept so an existing
   *  override still round-trips; P4Panel reads it as a p4NewCr fallback). */
  p4CodeReview?: string;
}

interface TemplateField {
  key: keyof TemplatesSettings;
  labelKey: MessageKey;
  fallback: string;
  vars: ReadonlyArray<{ name: string; desc: string }>;
  rows: number;
}

/** Sent on chat creation. Lives under "Prompt templates". */
const CHAT_TEMPLATE_FIELDS: TemplateField[] = [
  {
    key: 'startTicket',
    labelKey: 'prefs.templates.chat.startTicket.label',
    fallback: DEFAULT_START_TICKET_TEMPLATE,
    vars: TICKET_TEMPLATE_VARS,
    rows: 12,
  },
  {
    key: 'startCodeReview',
    labelKey: 'prefs.templates.chat.startCodeReview.label',
    fallback: DEFAULT_START_CODE_REVIEW_TEMPLATE,
    vars: CODE_REVIEW_TEMPLATE_VARS,
    rows: 8,
  },
  {
    key: 'reReview',
    labelKey: 'prefs.templates.chat.reReview.label',
    fallback: DEFAULT_RE_REVIEW_TEMPLATE,
    vars: CODE_REVIEW_TEMPLATE_VARS,
    rows: 10,
  },
  {
    key: 'rapidReReview',
    labelKey: 'prefs.templates.chat.rapidReReview.label',
    fallback: DEFAULT_RAPID_RE_REVIEW_TEMPLATE,
    vars: CODE_REVIEW_TEMPLATE_VARS,
    rows: 3,
  },
];

/** Triggered from the git panel's action button. Lives under "Source control". */
const GIT_ACTION_TEMPLATE_FIELDS: TemplateField[] = [
  {
    key: 'commitAi',
    labelKey: 'prefs.templates.git.commitAi.label',
    fallback: DEFAULT_COMMIT_AI_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 8,
  },
  {
    key: 'pushPr',
    labelKey: 'prefs.templates.git.pushPr.label',
    fallback: DEFAULT_PUSH_PR_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 10,
  },
  {
    key: 'pushDraftPr',
    labelKey: 'prefs.templates.git.pushDraftPr.label',
    fallback: DEFAULT_PUSH_DRAFT_PR_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 10,
  },
  {
    key: 'makePrReady',
    labelKey: 'prefs.templates.git.makePrReady.label',
    fallback: DEFAULT_MAKE_PR_READY_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 6,
  },
  {
    key: 'addressCr',
    labelKey: 'prefs.templates.git.addressCr.label',
    fallback: DEFAULT_ADDRESS_CR_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 10,
  },
  {
    key: 'rebaseBase',
    labelKey: 'prefs.templates.git.rebaseBase.label',
    fallback: DEFAULT_REBASE_BASE_TEMPLATE,
    vars: GIT_REBASE_TEMPLATE_VARS,
    rows: 10,
  },
];

/** Triggered from the Perforce panel's action button. Lives under "Source
 *  control" alongside the git ones. */
const P4_ACTION_TEMPLATE_FIELDS: TemplateField[] = [
  {
    key: 'p4NewCr',
    labelKey: 'prefs.templates.p4.newCr.label',
    fallback: DEFAULT_P4_NEW_CR_TEMPLATE,
    vars: P4_ACTION_TEMPLATE_VARS,
    rows: 10,
  },
  {
    key: 'p4AddressCr',
    labelKey: 'prefs.templates.p4.addressCr.label',
    fallback: DEFAULT_P4_ADDRESS_CR_TEMPLATE,
    vars: P4_ACTION_TEMPLATE_VARS,
    rows: 10,
  },
  {
    key: 'runTests',
    labelKey: 'prefs.templates.p4.runTests.label',
    fallback: DEFAULT_RUN_TESTS_TEMPLATE,
    vars: P4_ACTION_TEMPLATE_VARS,
    rows: 8,
  },
  {
    key: 'p4ReviewCommit',
    labelKey: 'prefs.templates.p4.reviewCommit.label',
    fallback: DEFAULT_P4_REVIEW_COMMIT_TEMPLATE,
    vars: P4_ACTION_TEMPLATE_VARS,
    rows: 10,
  },
];

/**
 * Reusable group of template editors. Each call manages its own
 * subset of the shared `templates` settings blob, save merges over
 * the existing blob so groups don't clobber each other.
 */
function TemplatesGroup({
  fields,
  intro,
}: {
  fields: TemplateField[];
  intro?: React.ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const initial = get<TemplatesSettings>('templates', {}) ?? {};
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = initial[f.key] ?? f.fallback;
    return out;
  });
  // Accordion: collapsed by default so a long list of templates stays compact.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // If this mounts before the settings store has loaded, the useState
  // initializer above captured the built-in fallbacks — the editors would
  // show defaults and a Save would write them back over the user's saved
  // templates. Hydrate once, when the real values land. Guarded by a ref
  // so a later save (which republishes `templates`) can't stomp on text
  // the user is in the middle of editing.
  const hydrated = useRef(false);
  useEffect(() => {
    if (loading || hydrated.current) return;
    hydrated.current = true;
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = initial[f.key] ?? f.fallback;
    setValues(out);
    // `initial`/`fields` are read at hydration time only — this must run
    // exactly once, when loading flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // A template writes when its editor is left; a reset writes at once.
  const commit = useAutoCommit<Record<string, string>>({
    draft: () => {
      const out: Record<string, string> = {};
      for (const f of fields) out[f.key] = values[f.key] ?? f.fallback;
      return out;
    },
    saved: () => {
      const out: Record<string, string> = {};
      for (const f of fields) out[f.key] = initial[f.key] ?? f.fallback;
      return out;
    },
    write: (next) => set('templates', { ...initial, ...next } satisfies TemplatesSettings),
  });

  if (loading) return <div />;

  const setField = (key: string, v: string): void =>
    setValues((prev) => ({ ...prev, [key]: v }));
  const resetField = (key: string, v: string): void => {
    setField(key, v);
    void commit({ [key]: v });
  };
  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const resetAll = (): void => {
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = f.fallback;
    setValues(out);
    void commit(out);
  };

  return (
    <>
      {intro}
      {fields.map((f) => {
        const open = expanded.has(f.key);
        const modified = (values[f.key] ?? f.fallback) !== f.fallback;
        return (
          <div key={f.key} className={`pref-tmpl-acc ${open ? 'open' : ''}`}>
            <button
              type="button"
              className="pref-tmpl-acc-head"
              aria-expanded={open}
              onClick={() => toggle(f.key)}
            >
              <i className={`fa-solid fa-chevron-${open ? 'down' : 'right'} pref-tmpl-acc-caret`} />
              <span className="pref-tmpl-acc-label">{t(f.labelKey)}</span>
              {modified && <span className="pref-tmpl-acc-dot" title={t('prefs.templates.modified')} />}
              {open && (
                <span
                  className="pref-tmpl-acc-reset"
                  role="button"
                  tabIndex={0}
                  title={t('prefs.templates.resetThis')}
                  onClick={(e) => { e.stopPropagation(); resetField(f.key, f.fallback); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); resetField(f.key, f.fallback); } }}
                >
                  <i className="fa-solid fa-rotate-left" />
                </span>
              )}
            </button>
            {open && (
              <div className="pref-tmpl-acc-body">
                <div className="pref-macro-row">
                  {f.vars.map((v) => (
                    <span key={v.name} className="pref-macro" title={v.desc}>
                      {`\${${v.name}}`}
                    </span>
                  ))}
                </div>
                <textarea
                  className="pref-template mono"
                  value={values[f.key] ?? ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                  onBlur={() => void commit()}
                  spellCheck={false}
                  rows={f.rows}
                />
              </div>
            )}
          </div>
        );
      })}
      <div className="pref-template-actions">
        <button className="btn ghost sm" onClick={resetAll}>{t('prefs.templates.resetDefaults')}</button>
      </div>
    </>
  );
}

function PrefsTemplates(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="pref-section">
      <h3>{t('prefs.templates.title')}</h3>
      <TemplatesGroup
        fields={CHAT_TEMPLATE_FIELDS}
        intro={
          <p className="pref-section-desc">
            {t('prefs.templates.intro', {
              macro: '${name}',
              link: t('prefs.templates.gitPanelLink'),
            })}
          </p>
        }
      />
    </div>
  );
}

interface ReviewsSettings {
  ignoreTitlePatterns?: string[];
  ignoreAuthors?: string[];
  /** Your team's GitHub logins — PRs they author get their own tier. */
  teamMembers?: string[];
  /** Outside contributors treated as colleagues. */
  vettedAuthors?: string[];
  /** Show unvetted outside contributors at all. */
  includeOutside?: boolean;
  /** Cap on optional (not-addressed-to-me) PRs shown per author. */
  maxPerAuthor?: number;
  /** How wide a net the Reviews panel casts — see ReviewScope. */
  scope?: ReviewScope;
}

const DEFAULT_REVIEW_TITLE_PATTERNS = ['DO NOT SUBMIT', 'Crowdin'];

/** One pattern per line — split + trim, drop empties. Used both ways
 *  (string ⇄ string[]) so we can render the saved list in a textarea. */
function linesToList(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}
function listToLines(list: string[] | undefined): string {
  return (list ?? []).join('\n');
}

interface PanelASearchSettings {
  /** Days back covered by the search cache (Linear + GitHub recent
   *  pulls that the "+ Add" picker fuzzy-matches against). */
  recentDays?: number;
}
const DEFAULT_SEARCH_DAYS = 30;
const MIN_SEARCH_DAYS = 1;
const MAX_SEARCH_DAYS = 365;

function PrefsReviews(): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const initial = get<ReviewsSettings>('reviews', {}) ?? {};
  const initialSearch = get<PanelASearchSettings>('panela.search', {}) ?? {};
  const [titles, setTitles] = useState(() =>
    listToLines(initial.ignoreTitlePatterns ?? DEFAULT_REVIEW_TITLE_PATTERNS),
  );
  const [authors, setAuthors] = useState(() => listToLines(initial.ignoreAuthors));
  const [scope, setScope] = useState<ReviewScope>(initial.scope ?? DEFAULT_REVIEW_SCOPE);
  const [team, setTeam] = useState(() => listToLines(initial.teamMembers));
  const [vetted, setVetted] = useState(() => listToLines(initial.vettedAuthors));
  const [includeOutside, setIncludeOutside] = useState(initial.includeOutside === true);
  const [maxPerAuthor, setMaxPerAuthor] = useState(initial.maxPerAuthor ?? DEFAULT_MAX_PER_AUTHOR);
  const [searchDays, setSearchDays] = useState(initialSearch.recentDays ?? DEFAULT_SEARCH_DAYS);
  /** Pinned reviews the just-saved rules would now exclude, awaiting the
   *  user's yes/no. `kept` is the pin list to write on confirm. */
  const [pendingPrune, setPendingPrune] = useState<
    { matched: ReviewItem[]; kept: PinnedReview[] } | null
  >(null);

  // Hydrate once `useSettings` finishes loading — without this the
  // initial useState value (default) wins over the persisted setting
  // and a Save would clobber the user's saved preference. Covers the
  // two textareas as well as the day count; they were previously left
  // out, so saved ignore-patterns/authors reverted to defaults.
  const hydrated = useRef(false);
  useEffect(() => {
    if (loading || hydrated.current) return;
    hydrated.current = true;
    setTitles(listToLines(initial.ignoreTitlePatterns ?? DEFAULT_REVIEW_TITLE_PATTERNS));
    setAuthors(listToLines(initial.ignoreAuthors));
    setScope(initial.scope ?? DEFAULT_REVIEW_SCOPE);
    setTeam(listToLines(initial.teamMembers));
    setVetted(listToLines(initial.vettedAuthors));
    setIncludeOutside(initial.includeOutside === true);
    setMaxPerAuthor(initial.maxPerAuthor ?? DEFAULT_MAX_PER_AUTHOR);
    setSearchDays(initialSearch.recentDays ?? DEFAULT_SEARCH_DAYS);
    // Persisted values are read at hydration time only; re-running on
    // every change would fight the user's in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // The lists write when their editor is left; the scope, the switch and
  // a reset write at once. One draft covers both settings keys.
  interface ReviewsDraft {
    titles: string[];
    authors: string[];
    scope: ReviewScope;
    team: string[];
    vetted: string[];
    includeOutside: boolean;
    maxPerAuthor: number;
    searchDays: number;
  }
  const commit = useAutoCommit<ReviewsDraft>({
    draft: () => ({
      titles: linesToList(titles),
      authors: linesToList(authors),
      scope,
      team: linesToList(team),
      vetted: linesToList(vetted),
      includeOutside,
      maxPerAuthor,
      searchDays,
    }),
    saved: () => ({
      titles: initial.ignoreTitlePatterns ?? DEFAULT_REVIEW_TITLE_PATTERNS,
      authors: initial.ignoreAuthors ?? [],
      scope: initial.scope ?? DEFAULT_REVIEW_SCOPE,
      team: initial.teamMembers ?? [],
      vetted: initial.vettedAuthors ?? [],
      includeOutside: initial.includeOutside === true,
      maxPerAuthor: initial.maxPerAuthor ?? DEFAULT_MAX_PER_AUTHOR,
      searchDays: initialSearch.recentDays ?? DEFAULT_SEARCH_DAYS,
    }),
    write: async (next) => {
      const rules = { ignoreTitlePatterns: next.titles, ignoreAuthors: next.authors };
      // Only the filtering rules can change what belongs in the list —
      // writing an unrelated field (the search window) must not nag
      // about pins that were already exempt before.
      const rulesChanged =
        JSON.stringify(rules.ignoreTitlePatterns) !== JSON.stringify(initial.ignoreTitlePatterns ?? DEFAULT_REVIEW_TITLE_PATTERNS) ||
        JSON.stringify(rules.ignoreAuthors) !== JSON.stringify(initial.ignoreAuthors ?? []) ||
        next.scope !== (initial.scope ?? DEFAULT_REVIEW_SCOPE);
      await set('reviews', {
        ...(initial as Record<string, unknown>),
        ...rules,
        scope: next.scope,
        teamMembers: next.team,
        vettedAuthors: next.vetted,
        includeOutside: next.includeOutside,
        maxPerAuthor: next.maxPerAuthor,
      } satisfies ReviewsSettings);
      if (next.searchDays !== (initialSearch.recentDays ?? DEFAULT_SEARCH_DAYS)) {
        await set('panela.search', {
          ...(initialSearch as Record<string, unknown>),
          recentDays: next.searchDays,
        } satisfies PanelASearchSettings);
      }
      if (rulesChanged) await offerToApplyToPinned(rules, next.scope);
    },
  });

  if (loading) return <div className="pref-section"><h3>{t('prefs.reviews.title')}</h3></div>;

  /**
   * The auto-list re-filters itself in main on the next poll, so new
   * rules take care of it. Pinned reviews don't: pinning is an explicit
   * override that survives every filter, so a review the user just
   * muted would sit there forever. Offer to drop the ones that no
   * longer qualify — never silently, since un-pinning is the user's
   * curation to undo.
   */
  const offerToApplyToPinned = async (rules: {
    ignoreTitlePatterns: string[];
    ignoreAuthors: string[];
  }, scopeNow: ReviewScope): Promise<void> => {
    const raw = get<Array<number | PinnedReview>>('panela.pinned.prs', []) ?? [];
    if (!Array.isArray(raw) || raw.length === 0) return;
    const pins: PinnedReview[] = raw.map((e) =>
      typeof e === 'number' ? { scm: 'github', number: e } : e,
    );
    const fetched = await Promise.all(
      pins.map(async (p) => {
        const res = await window.popbot.reviews.getPr(p.number, providerIdForReviewSystem(p.scm));
        // A pin we can't resolve (deleted PR, lost access) can't be
        // judged against the rules — leave it alone rather than guess.
        return res.ok ? { pin: p, review: res.pr } : null;
      }),
    );
    const matched: Array<{ pin: PinnedReview; review: ReviewItem }> = [];
    for (const entry of fetched) {
      if (!entry) continue;
      if (reviewIsIgnored(entry.review, rules) || !reviewInScope(entry.review, scopeNow)) {
        matched.push(entry);
      }
    }
    if (matched.length === 0) return;
    const drop = new Set(matched.map((m) => `${m.pin.scm}:${m.pin.number}`));
    setPendingPrune({
      matched: matched.map((m) => m.review),
      kept: pins.filter((p) => !drop.has(`${p.scm}:${p.number}`)),
    });
  };

  const reset = (): void => {
    setTitles(listToLines(DEFAULT_REVIEW_TITLE_PATTERNS));
    setAuthors('');
    void commit({ titles: DEFAULT_REVIEW_TITLE_PATTERNS, authors: [] });
  };

  return (
    <div className="pref-section">
      <h3>{t('prefs.reviews.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.reviews.desc')}
      </p>

      <h4 className="pref-subhead" style={{ marginTop: 18 }}>{t('prefs.reviews.scope.title')}</h4>
      <div className="pref-radio-group">
        {([
          { value: 'requested', label: 'prefs.reviews.scope.requested', desc: 'prefs.reviews.scope.requested.desc' },
          { value: 'unreviewed', label: 'prefs.reviews.scope.unreviewed', desc: 'prefs.reviews.scope.unreviewed.desc' },
        ] as const).map((opt) => (
          <label key={opt.value} className="pref-radio">
            <input
              type="radio"
              name="reviews-scope"
              checked={scope === opt.value}
              onChange={() => { setScope(opt.value); void commit({ scope: opt.value }); }}
            />
            <span>
              <span className="pref-radio-label">{t(opt.label)}</span>
              <span className="pref-radio-desc">{t(opt.desc, { tag: 'ENG-####' })}</span>
            </span>
          </label>
        ))}
      </div>

      <h4 className="pref-subhead" style={{ marginTop: 18 }}>{t('prefs.reviews.searchWindow.title')}</h4>
      <p className="pref-section-desc" style={{ marginBottom: 8 }}>
        {t('prefs.reviews.searchWindow.desc')}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <input
          className="pref-input mono narrow"
          type="number"
          min={MIN_SEARCH_DAYS}
          max={MAX_SEARCH_DAYS}
          value={searchDays}
          onChange={(e) => setSearchDays(
            Math.max(MIN_SEARCH_DAYS, Math.min(MAX_SEARCH_DAYS, Number(e.target.value) || DEFAULT_SEARCH_DAYS)),
          )}
          onBlur={() => void commit()}
          onKeyDown={blurOnEnter}
          style={{ width: 80 }}
        />
        <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>{t('common.days')}</span>
      </div>

      <h4 className="pref-subhead">{t('prefs.reviews.team.title')}</h4>
      <p className="pref-section-desc" style={{ marginBottom: 8 }}>
        {t('prefs.reviews.team.desc')}
      </p>
      <textarea
        className="pref-template mono"
        value={team}
        onChange={(e) => setTeam(e.target.value)}
        onBlur={() => void commit()}
        spellCheck={false}
        rows={5}
        placeholder={t('prefs.reviews.team.placeholder')}
      />

      <h4 className="pref-subhead" style={{ marginTop: 18 }}>{t('prefs.reviews.vetted.title')}</h4>
      <p className="pref-section-desc" style={{ marginBottom: 8 }}>
        {t('prefs.reviews.vetted.desc')}
      </p>
      <textarea
        className="pref-template mono"
        value={vetted}
        onChange={(e) => setVetted(e.target.value)}
        onBlur={() => void commit()}
        spellCheck={false}
        rows={4}
        placeholder={t('prefs.reviews.vetted.placeholder')}
      />
      <label className="pref-radio" style={{ marginTop: 10 }}>
        <input
          type="checkbox"
          checked={includeOutside}
          onChange={(e) => { setIncludeOutside(e.target.checked); void commit({ includeOutside: e.target.checked }); }}
        />
        <span>
          <span className="pref-radio-label">{t('prefs.reviews.includeOutside.label')}</span>
          <span className="pref-radio-desc">{t('prefs.reviews.includeOutside.desc')}</span>
        </span>
      </label>

      <h4 className="pref-subhead" style={{ marginTop: 18 }}>{t('prefs.reviews.maxPerAuthor.title')}</h4>
      <p className="pref-section-desc" style={{ marginBottom: 8 }}>
        {t('prefs.reviews.maxPerAuthor.desc')}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <input
          className="pref-input mono narrow"
          type="number"
          min={1}
          max={MAX_MAX_PER_AUTHOR}
          value={maxPerAuthor}
          onChange={(e) => setMaxPerAuthor(
            Math.max(1, Math.min(MAX_MAX_PER_AUTHOR, Number(e.target.value) || DEFAULT_MAX_PER_AUTHOR)),
          )}
          onBlur={() => void commit()}
          onKeyDown={(e) => { if (e.key === 'Enter') void commit(); }}
          style={{ width: 80 }}
        />
        <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>{t('prefs.reviews.maxPerAuthor.unit')}</span>
      </div>

      <h4 className="pref-subhead" style={{ marginTop: 18 }}>{t('prefs.reviews.ignoreTitle.title')}</h4>
      <textarea
        className="pref-template mono"
        value={titles}
        onChange={(e) => setTitles(e.target.value)}
        onBlur={() => void commit()}
        spellCheck={false}
        rows={6}
        placeholder={t('prefs.reviews.ignoreTitle.placeholder')}
      />

      <h4 className="pref-subhead" style={{ marginTop: 18 }}>{t('prefs.reviews.ignoreAuthor.title')}</h4>
      <textarea
        className="pref-template mono"
        value={authors}
        onChange={(e) => setAuthors(e.target.value)}
        onBlur={() => void commit()}
        spellCheck={false}
        rows={6}
        placeholder={t('prefs.reviews.ignoreAuthor.placeholder')}
      />

      <div className="pref-template-actions">
        <button className="btn ghost sm" onClick={reset}>{t('prefs.templates.resetDefaults')}</button>
      </div>

      {pendingPrune && (
        <ConfirmDialog
          title={t('prefs.reviews.apply.title')}
          message={t('prefs.reviews.apply.message', {
            count: pendingPrune.matched.length,
            list: pendingPrune.matched
              .map((r) => `  • #${r.number}  ${r.title}`)
              .join('\n'),
          })}
          confirmLabel={t('prefs.reviews.apply.confirm')}
          cancelLabel={t('prefs.reviews.apply.keep')}
          destructive
          onConfirm={() => {
            const kept = pendingPrune.kept;
            setPendingPrune(null);
            void set('panela.pinned.prs', kept);
          }}
          onCancel={() => setPendingPrune(null)}
        />
      )}
    </div>
  );
}

function LinearForm({
  initial,
  onSave,
  onDisconnect,
}: {
  initial: LinearSettings;
  onSave: (next: LinearSettings) => Promise<void>;
  onDisconnect: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState(initial.apiKey ?? '');
  const [teamKey, setTeamKey] = useState(initial.teamKey ?? '');
  const [projectId, setProjectId] = useState(initial.projectId ?? '');
  const [projects, setProjects] = useState<LinearProjectDto[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAs, setSavedAs] = useState<{ email: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasConnected = Boolean(initial.apiKey);

  // Load the project list whenever we have a usable key + (optional) team.
  // Debounced via the empty-key guard so we don't spam the API while
  // typing.
  useEffect(() => {
    const k = apiKey.trim();
    if (!k) {
      setProjects([]);
      return;
    }
    let cancelled = false;
    setProjectsLoading(true);
    void window.popbot.linear
      .listProjects({ apiKey: k, teamKey: teamKey.trim() })
      .then((res) => {
        if (cancelled) return;
        setProjects(res.projects ?? []);
      })
      .finally(() => {
        if (!cancelled) setProjectsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, teamKey]);

  // Leaving a field writes the form. A changed key is verified first
  // and the verdict shown in the status row; the form is saved either
  // way, so a typo shows up as a red status rather than as nothing.
  const commit = useAutoCommit<LinearSettings>({
    draft: () => ({
      apiKey: apiKey.trim(),
      teamKey: teamKey.trim(),
      projectId: projectId.trim() || undefined,
    }),
    saved: () => ({
      apiKey: initial.apiKey ?? '',
      teamKey: initial.teamKey ?? '',
      projectId: initial.projectId || undefined,
    }),
    write: async (next) => {
      if (!next.apiKey) return;
      setSaving(true);
      setError(null);
      setSavedAs(null);
      try {
        if (next.apiKey !== (initial.apiKey ?? '')) {
          const result = await window.popbot.linear.test(next.apiKey);
          if (!result.ok) {
            setError(result.error === 'auth'
              ? t('prefs.integ.linear.error.auth')
              : t('prefs.integ.linear.error.generic', { error: result.error }));
          } else {
            setSavedAs({ email: result.email, name: result.name });
          }
        }
        await onSave(next);
      } finally {
        setSaving(false);
      }
    },
  });

  return (
    <div className="pref-rows">
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.integ.linear.apiKey.title')}</div>
          <div className="pref-label-desc">
            {t('prefs.integ.linear.apiKey.desc')}{' '}
            <a
              href="https://linear.app/settings/api"
              onClick={(e) => { e.preventDefault(); window.open('https://linear.app/settings/api', '_blank'); }}
              style={{ color: 'var(--acc)', cursor: 'pointer' }}
            >
              {t('prefs.integ.linear.getKey')}
            </a>
          </div>
        </div>
        <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
          <input
            className="pref-input mono"
            type="password"
            placeholder="lin_api_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.integ.linear.teamKey.title')}</div>
          <div className="pref-label-desc">{t('prefs.integ.linear.teamKey.desc', { example: 'ENG' })}</div>
        </div>
        <div className="pref-control">
          <input
            className="pref-input mono"
            placeholder="ENG"
            value={teamKey}
            onChange={(e) => setTeamKey(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            style={{ width: 120 }}
          />
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.integ.linear.project.title')}</div>
          <div className="pref-label-desc">
            {t('prefs.integ.linear.project.desc')}
            {projectsLoading && <span style={{ marginLeft: 6, color: 'var(--fg-3)' }}>{t('common.loading')}</span>}
          </div>
        </div>
        <div className="pref-control" style={{ flex: 1, minWidth: 240 }}>
          <select
            className="pref-input"
            value={projectId}
            onChange={(e) => { setProjectId(e.target.value); void commit({ projectId: e.target.value || undefined }); }}
            disabled={!apiKey.trim() || projectsLoading}
            style={{ width: '100%' }}
          >
            <option value="">{t('prefs.integ.linear.allProjects')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('common.status')}</div>
          <div className="pref-label-desc">
            {saving ? (
              <span className="pill muted"><i className="fa-solid fa-spinner fa-spin" /> {t('prefs.integ.linear.verifying')}</span>
            ) : error ? (
              <span className="pill err"><i className="fa-solid fa-circle-xmark" /> {error}</span>
            ) : savedAs ? (
              <span className="pill done">
                <i className="fa-solid fa-circle-check" /> {t('prefs.integ.linear.connectedAs', { email: savedAs.email })}
              </span>
            ) : wasConnected ? (
              <span className="pill done"><i className="fa-solid fa-circle-check" /> {t('prefs.integ.linear.connected')}</span>
            ) : (
              <span className="pill muted"><i className="fa-regular fa-circle" /> {t('prefs.integ.linear.notConnected')}</span>
            )}
          </div>
        </div>
        <div className="pref-control" style={{ display: 'flex', gap: 8 }}>
          {wasConnected && (
            <button className="btn ghost sm" disabled={saving} onClick={() => void onDisconnect()}>
              {t('common.disconnect')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function JiraForm({
  initial,
  onSave,
  onDisconnect,
}: {
  initial: JiraSettings;
  onSave: (next: JiraSettings) => Promise<void>;
  onDisconnect: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [apiToken, setApiToken] = useState(initial.apiToken ?? '');
  const [projectKey, setProjectKey] = useState(initial.projectKey ?? '');
  const [jql, setJql] = useState(initial.jql ?? '');
  const [projects, setProjects] = useState<LinearProjectDto[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAs, setSavedAs] = useState<{ email: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasConnected = Boolean(initial.apiToken && initial.baseUrl && initial.email);

  const draft = (): JiraSettings => ({
    baseUrl: baseUrl.trim(),
    email: email.trim(),
    apiToken: apiToken.trim(),
    projectKey: projectKey.trim() || undefined,
    jql: jql.trim() || undefined,
  });

  // Load the project list once we have full credentials. Guarded on all
  // three required fields so we don't fire half-configured requests.
  useEffect(() => {
    if (!baseUrl.trim() || !email.trim() || !apiToken.trim()) {
      setProjects([]);
      setProjectsLoading(false);
      return;
    }
    let cancelled = false;
    // Debounce so we don't fire a lookup on every credential keystroke.
    const timer = window.setTimeout(() => {
      setProjectsLoading(true);
      void window.popbot.jira
        .listProjects({ baseUrl: baseUrl.trim(), email: email.trim(), apiToken: apiToken.trim() })
        .then((res) => {
          if (cancelled) return;
          setProjects(res.projects ?? []);
        })
        .catch(() => {
          // Swallow IPC rejections (e.g. transient failure while typing);
          // the Save flow surfaces a real error.
          if (!cancelled) setProjects([]);
        })
        .finally(() => {
          if (!cancelled) setProjectsLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [baseUrl, email, apiToken]);

  const ready = Boolean(baseUrl.trim() && email.trim() && apiToken.trim());

  // Leaving a field writes the form once all three credentials are
  // there. Changed credentials are verified first and the verdict shown
  // in the status row; the form is saved either way.
  const credsOf = (d: JiraSettings): string => `${d.baseUrl}\n${d.email}\n${d.apiToken}`;
  const commit = useAutoCommit<JiraSettings>({
    draft,
    saved: () => ({
      baseUrl: initial.baseUrl ?? '',
      email: initial.email ?? '',
      apiToken: initial.apiToken ?? '',
      projectKey: initial.projectKey || undefined,
      jql: initial.jql || undefined,
    }),
    write: async (next) => {
      if (!next.baseUrl || !next.email || !next.apiToken) return;
      setSaving(true);
      setError(null);
      setSavedAs(null);
      try {
        const savedCreds = credsOf({ baseUrl: initial.baseUrl ?? '', email: initial.email ?? '', apiToken: initial.apiToken ?? '' });
        if (credsOf(next) !== savedCreds) {
          try {
            const result = await window.popbot.jira.test(next);
            if (!result.ok) {
              setError(
                result.error === 'auth'
                  ? t('prefs.integ.jira.error.auth')
                  : t('prefs.integ.jira.error.generic', { error: result.error }),
              );
            } else {
              setSavedAs({ email: result.email, name: result.name });
            }
          } catch (err) {
            setError(t('prefs.integ.jira.error.generic', { error: err instanceof Error ? err.message : String(err) }));
          }
        }
        await onSave(next);
      } finally {
        setSaving(false);
      }
    },
  });

  return (
    <div className="pref-rows">
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.integ.jira.siteUrl.title')}</div>
          <div className="pref-label-desc">
            {t('prefs.integ.jira.siteUrl.desc')}{' '}
            <span className="mono">https://your-domain.atlassian.net</span>.
          </div>
        </div>
        <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
          <input
            className="pref-input mono"
            placeholder="https://your-domain.atlassian.net"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.integ.jira.email.title')}</div>
          <div className="pref-label-desc">{t('prefs.integ.jira.email.desc')}</div>
        </div>
        <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
          <input
            className="pref-input mono"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.integ.jira.apiToken.title')}</div>
          <div className="pref-label-desc">
            {t('prefs.integ.jira.apiToken.desc')}{' '}
            <a
              href="https://id.atlassian.com/manage-profile/security/api-tokens"
              onClick={(e) => {
                e.preventDefault();
                window.open('https://id.atlassian.com/manage-profile/security/api-tokens', '_blank');
              }}
              style={{ color: 'var(--acc)', cursor: 'pointer' }}
            >
              {t('prefs.integ.jira.getToken')}
            </a>
          </div>
        </div>
        <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
          <input
            className="pref-input mono"
            type="password"
            placeholder="••••••••"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.integ.jira.project.title')}</div>
          <div className="pref-label-desc">
            {t('prefs.integ.jira.project.desc')}
            {projectsLoading && <span style={{ marginLeft: 6, color: 'var(--fg-3)' }}>{t('common.loading')}</span>}
          </div>
        </div>
        <div className="pref-control" style={{ flex: 1, minWidth: 240 }}>
          <select
            className="pref-input"
            value={projectKey}
            onChange={(e) => { setProjectKey(e.target.value); void commit({ projectKey: e.target.value || undefined }); }}
            disabled={!ready || projectsLoading}
            style={{ width: '100%' }}
          >
            <option value="">{t('prefs.integ.jira.allProjects')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('prefs.integ.jira.jql.title')}</div>
          <div className="pref-label-desc">
            {t('prefs.integ.jira.jql.desc')}{' '}
            <span className="mono">labels = backend</span>.
          </div>
        </div>
        <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
          <input
            className="pref-input mono"
            placeholder="labels = backend"
            value={jql}
            onChange={(e) => setJql(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('common.status')}</div>
          <div className="pref-label-desc">
            {saving ? (
              <span className="pill muted"><i className="fa-solid fa-spinner fa-spin" /> {t('prefs.integ.jira.verifying')}</span>
            ) : error ? (
              <span className="pill err"><i className="fa-solid fa-circle-xmark" /> {error}</span>
            ) : savedAs ? (
              <span className="pill done">
                <i className="fa-solid fa-circle-check" /> {t('prefs.integ.jira.connectedAs', { email: savedAs.email })}
              </span>
            ) : wasConnected ? (
              <span className="pill done"><i className="fa-solid fa-circle-check" /> {t('prefs.integ.jira.connected')}</span>
            ) : (
              <span className="pill muted"><i className="fa-regular fa-circle" /> {t('prefs.integ.jira.notConnected')}</span>
            )}
          </div>
        </div>
        <div className="pref-control" style={{ display: 'flex', gap: 8 }}>
          {wasConnected && (
            <button className="btn ghost sm" disabled={saving} onClick={() => void onDisconnect()}>
              {t('common.disconnect')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * GitHub Issues config. Unlike Linear/Jira there are no credentials to
 * enter: the provider shells out to the `gh` CLI (already authenticated for
 * the Reviews tab + git actions) and spans the same repos configured in the
 * Repositories section. So this form is informational + a status check that
 * confirms `gh` is installed/authenticated and reports the repo span.
 */
function GithubForm(): JSX.Element {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<GithubTestResult | null>(null);

  const check = async (): Promise<void> => {
    setChecking(true);
    setResult(null);
    try {
      setResult(await window.popbot.github.test());
    } catch (err) {
      setResult({ ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecking(false);
    }
  };

  // Verify on mount so the status line reflects reality without a click.
  useEffect(() => {
    void check();
  }, []);

  const statusPill = (): JSX.Element => {
    if (checking && !result) {
      return <span className="pill muted"><i className="fa-regular fa-circle" /> Checking…</span>;
    }
    if (!result) {
      return <span className="pill muted"><i className="fa-regular fa-circle" /> Not checked</span>;
    }
    if (result.ok) {
      return (
        <span className="pill done">
          <i className="fa-solid fa-circle-check" /> Authenticated as {result.login} · {result.repoCount}{' '}
          {result.repoCount === 1 ? 'repo' : 'repos'}
        </span>
      );
    }
    const msg =
      result.reason === 'gh-not-found'
        ? 'The gh CLI isn’t installed or isn’t on PATH.'
        : result.reason === 'gh-not-authed'
          ? 'gh is installed but not authenticated — run `gh auth login`.'
          : result.reason === 'no-repo'
            ? 'No repositories configured — add one in the Repositories section.'
            : `GitHub error: ${result.error ?? 'unknown'}`;
    return <span className="pill err"><i className="fa-solid fa-circle-xmark" /> {msg}</span>;
  };

  return (
    <div className="pref-rows">
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">Authentication</div>
          <div className="pref-label-desc">
            GitHub Issues use the <span className="mono">gh</span> CLI you’ve already authenticated for
            reviews and git actions — there’s nothing to enter here. The queue spans the same
            repositories configured in the Repositories section.
          </div>
        </div>
        <div className="pref-control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn ghost sm" disabled={checking} onClick={() => void check()}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">Status</div>
          <div className="pref-label-desc">{statusPill()}</div>
        </div>
        <div className="pref-control" />
      </div>
    </div>
  );
}

// ----- Sentry section -----------------------------------------------------

interface SentryUiSettings {
  enabled?: boolean;
  authToken?: string;
  orgSlug?: string;
  projectSlug?: string;
  pollIntervalMs?: number;
}

function PrefsSentry(): JSX.Element {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [pollMins, setPollMins] = useState<number>(1);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<
    | { ok: true; org: string }
    | { ok: false; reason: string }
    | null
  >(null);

  useEffect(() => {
    void window.popbot.settings.get<SentryUiSettings>('sentry').then((s) => {
      if (s) {
        setEnabled(!!s.enabled);
        setAuthToken(s.authToken ?? '');
        setOrgSlug(s.orgSlug ?? '');
        setProjectSlug(s.projectSlug ?? '');
        if (s.pollIntervalMs) setPollMins(Math.round(s.pollIntervalMs / 60_000));
      }
      setLoaded(true);
    });
  }, []);

  const onTest = async (): Promise<void> => {
    if (!authToken.trim() || !orgSlug.trim()) return;
    setBusy(true);
    setTestResult(null);
    try {
      const r = await window.popbot.sentry.test({
        token: authToken.trim(),
        orgSlug: orgSlug.trim(),
      });
      if (r.ok) setTestResult({ ok: true, org: r.org });
      else setTestResult({ ok: false, reason: r.reason });
    } finally {
      setBusy(false);
    }
  };

  // Written when a field is left; the switch writes at once. The saved
  // twin is what was last written (this panel loads its own copy).
  const written = useRef<SentryUiSettings | null>(null);
  const commit = useAutoCommit<SentryUiSettings>({
    draft: () => ({
      enabled,
      authToken: authToken.trim() || undefined,
      orgSlug: orgSlug.trim() || undefined,
      projectSlug: projectSlug.trim() || undefined,
      pollIntervalMs: Math.max(1, Math.min(60, pollMins)) * 60_000,
    }),
    saved: () => written.current ?? { enabled: false, pollIntervalMs: 60_000 },
    write: async (next) => {
      await window.popbot.settings.set('sentry', next);
      written.current = next;
    },
  });
  useEffect(() => {
    if (!loaded) return;
    written.current = {
      enabled,
      authToken: authToken.trim() || undefined,
      orgSlug: orgSlug.trim() || undefined,
      projectSlug: projectSlug.trim() || undefined,
      pollIntervalMs: Math.max(1, Math.min(60, pollMins)) * 60_000,
    };
    // Snapshot what the panel loaded, once, so the first blur compares
    // against it rather than writing unchanged values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (!loaded) return <div style={{ padding: 24, color: 'var(--fg-3)' }}>{t('common.loading')}</div>;

  return (
    <div className="pref-section">
      <h3>{t('prefs.integ.sentry.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.integ.sentry.desc', {
          link: t('prefs.integ.sentry.authTokensLink'),
          scopes: 'event:read, project:read, org:read',
        })}
        {' ('}
        <a href="https://sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noreferrer noopener">
          {t('prefs.integ.sentry.authTokensLink')}
        </a>
        {')'}
      </p>

      <div className="pref-row">
        <div className="pref-label">{t('prefs.integ.enabled')}</div>
        <div className="pref-control" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className={`pref-toggle ${enabled ? 'on' : ''}`}
            onClick={() => { setEnabled(!enabled); void commit({ enabled: !enabled }); }}
            aria-pressed={enabled}
          >
            <span className="pref-toggle-thumb" />
          </button>
          <span style={{ color: 'var(--fg-2)', fontSize: 12 }}>
            {enabled ? t('prefs.integ.pollingOn') : t('prefs.integ.off')}
          </span>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">{t('prefs.integ.sentry.authToken')}</div>
        <div className="pref-control">
          <input
            className="input"
            type="password"
            placeholder="sntryu_..."
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">{t('prefs.integ.sentry.orgSlug')}</div>
        <div className="pref-control">
          <input
            className="input"
            placeholder="my-org"
            value={orgSlug}
            onChange={(e) => setOrgSlug(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">{t('prefs.integ.sentry.projectSlug')}</div>
        <div className="pref-control">
          <input
            className="input"
            placeholder={t('prefs.integ.sentry.projectSlug.placeholder')}
            value={projectSlug}
            onChange={(e) => setProjectSlug(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">{t('prefs.integ.pollInterval')}</div>
        <div className="pref-control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            className="input"
            type="number"
            min={1}
            max={60}
            value={pollMins}
            onChange={(e) => setPollMins(Number(e.target.value) || 5)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            style={{ width: 80 }}
          />
          <span style={{ color: 'var(--fg-3)' }}>{t('common.minutes')}</span>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">{t('common.status')}</div>
        <div className="pref-control">
          {testResult?.ok && (
            <span className="pill done">
              <i className="fa-solid fa-circle-check" /> {t('prefs.integ.sentry.verified', { org: testResult.org })}
            </span>
          )}
          {testResult?.ok === false && (
            <span className="pill err">
              <i className="fa-solid fa-circle-xmark" /> {testResult.reason}
            </span>
          )}
          {!testResult && (
            <span className="pill muted">
              <i className="fa-regular fa-circle" /> {t('prefs.integ.notVerified')}
            </span>
          )}
        </div>
        <div className="pref-control" style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn ghost sm"
            disabled={!authToken.trim() || !orgSlug.trim() || busy}
            onClick={() => void onTest()}
          >
            {busy ? t('prefs.integ.testing') : t('prefs.integ.testConnection')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----- Slack section ------------------------------------------------------

interface SlackUiSettings {
  enabled?: boolean;
  token?: string;
  pollIntervalMs?: number;
}

function PrefsSlack(): JSX.Element {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState('');
  const [pollMins, setPollMins] = useState<number>(1);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<
    | { ok: true; team: string; user: string }
    | { ok: false; reason: string }
    | null
  >(null);

  useEffect(() => {
    void window.popbot.settings.get<SlackUiSettings>('slack').then((s) => {
      if (s) {
        setEnabled(!!s.enabled);
        setToken(s.token ?? '');
        if (s.pollIntervalMs) setPollMins(Math.round(s.pollIntervalMs / 60_000));
      }
      setLoaded(true);
    });
  }, []);

  const onTest = async (): Promise<void> => {
    if (!token.trim()) return;
    setBusy(true);
    setTestResult(null);
    try {
      const r = await window.popbot.slack.test(token.trim());
      if (r.ok) setTestResult({ ok: true, team: r.team, user: r.user });
      else setTestResult({ ok: false, reason: r.reason + (r.error ? ` (${r.error})` : '') });
    } finally {
      setBusy(false);
    }
  };

  // Written when a field is left; the switch writes at once. The saved
  // twin is what was last written (this panel loads its own copy).
  const written = useRef<SlackUiSettings | null>(null);
  const commit = useAutoCommit<SlackUiSettings>({
    draft: () => ({
      enabled,
      token: token.trim() || undefined,
      pollIntervalMs: Math.max(1, Math.min(10, pollMins)) * 60_000,
    }),
    saved: () => written.current ?? { enabled: false, pollIntervalMs: 60_000 },
    write: async (next) => {
      await window.popbot.settings.set('slack', next);
      written.current = next;
    },
  });
  useEffect(() => {
    if (!loaded) return;
    written.current = {
      enabled,
      token: token.trim() || undefined,
      pollIntervalMs: Math.max(1, Math.min(10, pollMins)) * 60_000,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (!loaded) return <div style={{ padding: 24, color: 'var(--fg-3)' }}>{t('common.loading')}</div>;

  return (
    <div className="pref-section">
      <h3>{t('prefs.integ.slack.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.integ.slack.desc')}
      </p>
      <p className="pref-section-desc" style={{ marginTop: -6, fontSize: 11 }}>
        {t('prefs.integ.slack.tokenHelp', {
          link: t('prefs.integ.slack.appsLink'),
          scopes: 'channels:history, groups:history, im:history, mpim:history, users:read, search:read',
          prefix: 'xoxp-',
        })}
        {' ('}
        <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer noopener">{t('prefs.integ.slack.appsLink')}</a>
        {')'}
      </p>

      <div className="pref-row">
        <div className="pref-label">{t('prefs.integ.enabled')}</div>
        <div className="pref-control" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className={`pref-toggle ${enabled ? 'on' : ''}`}
            onClick={() => { setEnabled(!enabled); void commit({ enabled: !enabled }); }}
            aria-pressed={enabled}
          >
            <span className="pref-toggle-thumb" />
          </button>
          <span style={{ color: 'var(--fg-2)', fontSize: 12 }}>
            {enabled ? t('prefs.integ.pollingOn') : t('prefs.integ.off')}
          </span>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">{t('prefs.integ.slack.userToken')}</div>
        <div className="pref-control">
          <input
            className="input"
            type="password"
            placeholder="xoxp-..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">{t('prefs.integ.pollInterval')}</div>
        <div className="pref-control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            className="input"
            type="number"
            min={1}
            max={10}
            value={pollMins}
            onChange={(e) => setPollMins(Number(e.target.value) || 1)}
            onBlur={() => void commit()}
            onKeyDown={blurOnEnter}
            style={{ width: 80 }}
          />
          <span style={{ color: 'var(--fg-3)' }}>{t('common.minutes')}</span>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">{t('common.status')}</div>
        <div className="pref-control">
          {testResult?.ok && (
            <span className="pill done">
              <i className="fa-solid fa-circle-check" /> {t('prefs.integ.slack.connectedTo', { team: testResult.team, user: testResult.user })}
            </span>
          )}
          {testResult?.ok === false && (
            <span className="pill err">
              <i className="fa-solid fa-circle-xmark" /> {testResult.reason}
            </span>
          )}
          {!testResult && (
            <span className="pill muted">
              <i className="fa-regular fa-circle" /> {t('prefs.integ.notVerified')}
            </span>
          )}
        </div>
        <div className="pref-control" style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn ghost sm"
            disabled={!token.trim() || busy}
            onClick={() => void onTest()}
          >
            {busy ? t('prefs.integ.testing') : t('prefs.integ.testConnection')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----- Notifications section ---------------------------------------------

interface NotificationsUiSettings {
  vips?: string[];
  /** When true, toasts arrive at top-CENTER and exit by flying toward
   *  the bell icon. Off by default — only useful on very wide displays
   *  where the corner placement falls outside foveal vision. */
  centerFly?: boolean;
}

function PrefsNotifications(): JSX.Element {
  const { t } = useTranslation();
  const [vipsText, setVipsText] = useState('');
  // Default ON; an explicit `false` in saved settings turns it off.
  // Mirrors the App-level default so the checkbox shows the right
  // state on first open even when no value was ever persisted.
  const [centerFly, setCenterFly] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void window.popbot.settings.get<NotificationsUiSettings>('notifications').then((s) => {
      if (s?.vips) setVipsText(s.vips.join('\n'));
      setCenterFly(s?.centerFly !== false);
      setLoaded(true);
    });
  }, []);

  // The list writes when its editor is left; the switch writes at once.
  const written = useRef<NotificationsUiSettings | null>(null);
  const commit = useAutoCommit<NotificationsUiSettings>({
    draft: () => ({ vips: vipsText.split('\n').map((s) => s.trim()).filter(Boolean), centerFly }),
    saved: () => written.current ?? { vips: [], centerFly: true },
    write: async (next) => {
      await window.popbot.settings.set('notifications', next);
      written.current = next;
      // Tell the live App to refetch the notifications prefs so the
      // toast placement / bell pulse reflect the new setting without
      // requiring a reload.
      globalThis.dispatchEvent(new CustomEvent('popbot:notifications-prefs-changed'));
    },
  });
  useEffect(() => {
    if (!loaded) return;
    written.current = { vips: vipsText.split('\n').map((s) => s.trim()).filter(Boolean), centerFly };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (!loaded) return <div style={{ padding: 24, color: 'var(--fg-3)' }}>{t('common.loading')}</div>;

  return (
    <div className="pref-section">
      <h3>{t('prefs.notify.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.notify.desc')}
      </p>
      <div className="pref-row">
        <div className="pref-label">{t('prefs.notify.vipNames')}</div>
        <div className="pref-control" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <textarea
            className="input"
            placeholder={t('prefs.notify.vipPlaceholder')}
            value={vipsText}
            onChange={(e) => setVipsText(e.target.value)}
            onBlur={() => void commit()}
            rows={6}
            style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
            spellCheck={false}
          />
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">{t('prefs.notify.toastPlacement')}</div>
        <div className="pref-control" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={centerFly}
              onChange={(e) => {
                setCenterFly(e.target.checked);
                void commit({ centerFly: e.target.checked });
              }}
            />
            <span>{t('prefs.notify.centerFly.label')}</span>
          </label>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-3)', maxWidth: 480 }}>
            {t('prefs.notify.centerFly.desc')}
          </p>
        </div>
      </div>

      {/* TEMPORARY: test buttons for the new-item flow. Each marks a
          handful of *real* items in the current queue as unseen so the
          NEW chips re-appear and the tab pip bumps. No fake data is
          injected. Remove this whole block once the flow has been
          validated end-to-end. */}
      <div className="pref-row" style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed var(--line-1)' }}>
        <div className="pref-label">{t('prefs.notify.testFlow.title')}</div>
        <div className="pref-control" style={{ display: 'flex', gap: 8, flexDirection: 'column', alignItems: 'flex-start' }}>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-3)', maxWidth: 480 }}>
            {t('prefs.notify.testFlow.desc')}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn ghost sm"
              onClick={() => globalThis.dispatchEvent(new CustomEvent('popbot:test-mark-unseen', { detail: { kind: 'tickets', count: 2 } }))}
            >
              <i className="fa-solid fa-flask" /> {t('prefs.notify.testFlow.flagTickets')}
            </button>
            <button
              className="btn ghost sm"
              onClick={() => globalThis.dispatchEvent(new CustomEvent('popbot:test-mark-unseen', { detail: { kind: 'reviews', count: 2 } }))}
            >
              <i className="fa-solid fa-flask" /> {t('prefs.notify.testFlow.flagPrs')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----- Permissions section ------------------------------------------------

interface GlobalPermissionRule {
  tool: string;
  action: 'allow' | 'deny';
}

/** Well-known Claude Code tools we always render so the user can set
 *  defaults proactively without having to encounter each one in a
 *  prompt first. Order = visible order in Preferences. Custom tools
 *  (skills, MCP servers, anything the agent loads dynamically) get
 *  appended below this list when the user has saved a rule for them. */
// Descriptions are intentionally similar in length so each card
// renders the same height — keeps the list scannable and the toggle
// columns aligned. Roughly 5-8 words, single short sentence each.
const CORE_TOOLS: Array<{ name: string; descKey: MessageKey }> = [
  { name: 'Bash',         descKey: 'prefs.permissions.tool.bash.desc' },
  { name: 'Read',         descKey: 'prefs.permissions.tool.read.desc' },
  { name: 'Write',        descKey: 'prefs.permissions.tool.write.desc' },
  { name: 'Edit',         descKey: 'prefs.permissions.tool.edit.desc' },
  { name: 'NotebookEdit', descKey: 'prefs.permissions.tool.notebookEdit.desc' },
  { name: 'Grep',         descKey: 'prefs.permissions.tool.grep.desc' },
  { name: 'Glob',         descKey: 'prefs.permissions.tool.glob.desc' },
  { name: 'WebFetch',     descKey: 'prefs.permissions.tool.webFetch.desc' },
  { name: 'WebSearch',    descKey: 'prefs.permissions.tool.webSearch.desc' },
  { name: 'TodoWrite',    descKey: 'prefs.permissions.tool.todoWrite.desc' },
  { name: 'Task',         descKey: 'prefs.permissions.tool.task.desc' },
  { name: 'ExitPlanMode', descKey: 'prefs.permissions.tool.exitPlanMode.desc' },
];

type ToolState = 'ask' | 'allow' | 'deny';

function PrefsPermissions(): JSX.Element {
  const { t } = useTranslation();
  const [rules, setRules] = useState<GlobalPermissionRule[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void window.popbot.settings.get<GlobalPermissionRule[]>('permissions.rules').then((v) => {
      setRules(Array.isArray(v) ? v : []);
      setLoaded(true);
    });
  }, []);

  const setState = (tool: string, state: ToolState): void => {
    const without = rules.filter((r) => r.tool !== tool);
    const next: GlobalPermissionRule[] =
      state === 'ask' ? without : [...without, { tool, action: state }];
    setRules(next);
    void window.popbot.settings.set('permissions.rules', next);
  };

  // Always-shown MCP server toggles: a single wildcard rule per editor MCP
  // pre-allows (or denies) every tool from that slot's Unity/Unreal editor, so
  // the user isn't prompted for each MCP call. Set to 'allow' to enable all of
  // that engine's MCP tools; leave 'ask' to be prompted per tool.
  const MCP_SERVER_TOGGLES: Array<{ name: string; descKey: MessageKey }> = [
    { name: 'mcp__unrealEditor__*', descKey: 'prefs.permissions.tool.mcpUnreal.desc' },
    { name: 'mcp__unityEditor__*', descKey: 'prefs.permissions.tool.mcpUnity.desc' },
  ];

  // A friendly display label for a rule's tool pattern. MCP tools read
  // `mcp__unrealEditor__call_tool`; show `unrealEditor → call_tool` (and
  // `unrealEditor → all tools` for a wildcard) instead of the raw namespace.
  const labelForTool = (name: string): string => {
    if (!isMcpTool(name)) return name;
    const server = mcpServerOfTool(name) ?? 'MCP';
    const rest = name.slice(`mcp__${server}__`.length);
    return `${server} → ${rest === '*' ? t('prefs.permissions.mcpAllTools') : rest}`;
  };

  // Merge core tools + MCP server toggles with user-added (non-core) rules so
  // MCP / custom tools the user has opinions on don't disappear from the list.
  const alwaysShown = new Set([
    ...CORE_TOOLS.map((tool) => tool.name),
    ...MCP_SERVER_TOGGLES.map((m) => m.name),
  ]);
  // Auto-collapse: hide a per-tool MCP rule when a wildcard for the SAME server
  // already covers it with the SAME action — the wildcard row makes it
  // redundant. Keep it when the actions differ (a meaningful per-tool override).
  const isRedundantUnderWildcard = (name: string): boolean => {
    if (!isMcpTool(name) || name.endsWith('*')) return false;
    const rule = rules.find((r) => r.tool === name);
    if (!rule) return false;
    return rules.some(
      (w) => w.tool.endsWith('*') && w.action === rule.action && permissionRuleMatches(w.tool, name),
    );
  };
  const customToolNames = rules
    .map((r) => r.tool)
    .filter((name) => !alwaysShown.has(name) && !isRedundantUnderWildcard(name));
  const renderRows: Array<{ name: string; label: string; description: string | null }> = [
    ...CORE_TOOLS.map((tool) => ({ name: tool.name, label: tool.name, description: t(tool.descKey) })),
    ...MCP_SERVER_TOGGLES.map((m) => ({ name: m.name, label: labelForTool(m.name), description: t(m.descKey) })),
    ...customToolNames.map((name) => ({ name, label: labelForTool(name), description: null })),
  ];

  const stateLabel: Record<ToolState, string> = {
    ask: t('prefs.permissions.state.ask'),
    allow: t('prefs.permissions.state.allow'),
    deny: t('prefs.permissions.state.deny'),
  };

  if (!loaded) return <div style={{ padding: 24, color: 'var(--fg-3)' }}>{t('common.loading')}</div>;

  const stateOf = (tool: string): ToolState => {
    const rule = rules.find((r) => r.tool === tool);
    if (!rule) return 'ask';
    return rule.action;
  };

  return (
    <div className="pref-section">
      <h3>{t('prefs.permissions.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.permissions.desc')}
      </p>
      <div className="pref-row wide" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {renderRows.map((row) => {
          const cur = stateOf(row.name);
          return (
            <div
              key={row.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                background: 'var(--bg-2)',
                border: '1px solid var(--line-2)',
                borderRadius: 6,
                // Fixed height keeps every card aligned even when
                // descriptions differ slightly in length or a custom
                // (non-core) tool has no description at all.
                height: 56,
                boxSizing: 'border-box',
              }}
            >
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                  {row.label}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--fg-3)',
                    marginTop: 2,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {row.description ?? '—'}
                </div>
              </div>
              <div
                style={{ display: 'flex', gap: 2, flex: '0 0 auto' }}
                role="radiogroup"
                aria-label={t('prefs.permissions.toolDefaultAria', { tool: row.label })}
              >
                {(['ask', 'allow', 'deny'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={cur === s}
                    className={`btn sm ${cur === s ? 'primary' : 'ghost'}`}
                    onClick={() => setState(row.name, s)}
                    style={{
                      width: 64,
                      justifyContent: 'center',
                      textTransform: 'capitalize',
                    }}
                  >
                    {stateLabel[s]}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
 * Repositories
 * ============================================================ */

interface NewRepoDraft {
  id: string;
  repoPath: string;
  color: string;
  defaultBase: string;
  slotPrefix: string;
  slotCount: number;
  mode: RepoWorktreeMode;
  /** Detected source control of repoPath. null = not yet detected / invalid
   *  folder (the repo step blocks Next until this is git or perforce). */
  scm: SourceControlProviderId | null;
  // Perforce connection. Auto-discovered from the workspace when possible
  // (then shown read-only), else entered manually.
  p4Port: string;
  p4User: string;
  p4Depot: string;
  baseChangelist: number;
  /** True once the connection was auto-filled from the folder's P4 client. */
  p4Discovered: boolean;
  /** The discovered client name (for the read-only summary). */
  p4Client: string;
  /** Path (relative to the slot/workspace root) where the agent starts (its
   *  cwd). `/` = the mount root itself; a subpath like `/depot/PopBotGame`
   *  starts the agent there so repo-committed `.claude/skills` are discovered. */
  p4AgentCwd: string;
}

function emptyDraft(): NewRepoDraft {
  return {
    id: '',
    repoPath: '',
    color: DEFAULT_REPO_COLOR,
    defaultBase: 'main',
    slotPrefix: 'slot',
    slotCount: 4,
    mode: 'slots',
    scm: null,
    p4Port: '',
    p4User: '',
    p4Depot: '',
    baseChangelist: 0,
    p4Discovered: false,
    p4Client: '',
    p4AgentCwd: '/',
  };
}

/** Twelve-swatch color picker — replaces a freeform color input
 *  everywhere a repo accent is chosen. The fixed palette is what
 *  lets the rest of the app hardcode white text on accent buttons. */
function RepoColorSwatches({
  value,
  onChange,
  usedColors = [],
}: {
  value: string;
  onChange: (next: string) => void;
  /** Colors taken by OTHER repos — marked with an × and unselectable so two
   *  repos can't share an accent (the current selection is always allowed). */
  usedColors?: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const used = new Set(usedColors.map((c) => c.toLowerCase()));
  return (
    <div className="repo-swatches" role="radiogroup" aria-label={t('prefs.repos.colorAria')}>
      {POPBOT_PALETTE.map((c) => {
        const selected = value.toLowerCase() === c.value.toLowerCase();
        const taken = !selected && used.has(c.value.toLowerCase());
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={taken}
            aria-label={taken ? `${c.name} — ${t('prefs.repos.colorTaken')}` : c.name}
            title={taken ? t('prefs.repos.colorTaken') : c.name}
            className={`repo-swatch ${selected ? 'selected' : ''} ${taken ? 'taken' : ''}`}
            style={{ background: c.value }}
            onClick={() => { if (!taken) onChange(c.value); }}
          >
            {taken && <i className="fa-solid fa-xmark" />}
          </button>
        );
      })}
    </div>
  );
}

function PrefsRepos({ onReposChanged }: { onReposChanged?: () => void }): JSX.Element {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<RepoRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newRepo, setNewRepo] = useState<NewRepoDraft | null>(null);
  const [editing, setEditing] = useState<RepoRecord | null>(null);
  const [deleting, setDeleting] = useState<RepoRecord | null>(null);

  const refresh = async () => {
    try {
      const list = await window.popbot.repos.list();
      setRepos(list);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => { void refresh(); }, []);

  /** Refetch our local repo list AND notify the host so the chat
   *  list re-fetches its denormalized `repoColor`/`repoMode` JOIN. */
  const refreshAll = async () => {
    await refresh();
    onReposChanged?.();
  };

  if (repos === null) return <div className="pref-section"><h3>{t('prefs.repos.title')}</h3></div>;

  return (
    <div className="pref-section">
      <h3>{t('prefs.repos.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.repos.desc')}
      </p>
      {error && <div className="pref-error">{error}</div>}
      <div className="repo-list">
        {repos.map((r) => (
          <div key={r.id} className="repo-card" style={{ borderLeft: `4px solid ${r.color}` }}>
            <div className="repo-card-head">
              <span className="repo-card-id mono">{r.id}</span>
              <span className={`repo-card-scm scm-${r.scm ?? 'git'}`}>
                {(r.scm ?? 'git') === 'perforce' ? (
                  <><P4Glyph /> {t('prefs.repos.scm.perforce')}</>
                ) : (
                  <><i className="fa-solid fa-code-branch" /> {t('prefs.repos.scm.git')}</>
                )}
              </span>
              <span className={`repo-card-mode mode-${r.mode}`}>
                {r.mode === 'ephemeral'
                  ? t('prefs.repos.mode.ephemeral')
                  : t('prefs.repos.mode.slots', { count: r.slotCount })}
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => setEditing(r)}>{t('common.edit')}</button>
              <button className="btn sm danger" onClick={() => setDeleting(r)}>{t('prefs.repos.delete')}</button>
            </div>
            <div className="repo-card-body">
              <div className="repo-card-row">
                <span className="repo-card-label">{t('prefs.repos.card.path')}</span>
                <span className="mono">{r.repoPath}</span>
              </div>
              {/* Perforce has no default branch — it just shows Path + Slot
                  prefix, so its card matches the height of a 2-row git card. */}
              {(r.scm ?? 'git') !== 'perforce' && (
                <div className="repo-card-row">
                  <span className="repo-card-label">{t('prefs.repos.card.defaultBase')}</span>
                  <span className="mono">{r.defaultBase}</span>
                </div>
              )}
              {r.mode === 'slots' && (
                <div className="repo-card-row">
                  <span className="repo-card-label">{t('prefs.repos.card.slotPrefix')}</span>
                  <span className="mono">{r.slotPrefix}-N</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={() => {
            // Open on the first color no other repo is using, so the default
            // isn't a taken (and thus unselectable) swatch.
            const used = new Set(repos.map((r) => r.color.toLowerCase()));
            const free = POPBOT_PALETTE.find((c) => !used.has(c.value.toLowerCase()))?.value;
            setNewRepo({ ...emptyDraft(), color: free ?? DEFAULT_REPO_COLOR });
          }}
        >
          <i className="fa-solid fa-plus" />&nbsp;{t('prefs.repos.addRepository')}
        </button>
      </div>

      {newRepo && (
        <NewRepoWizard
          draft={newRepo}
          onChange={setNewRepo}
          existingIds={repos.map((r) => r.id)}
          existingPaths={repos.map((r) => r.repoPath)}
          existingColors={repos.map((r) => r.color)}
          onCancel={() => setNewRepo(null)}
          onCreated={async () => {
            setNewRepo(null);
            await refreshAll();
          }}
        />
      )}
      {editing && (
        <EditRepoModal
          repo={editing}
          usedColors={repos.filter((r) => r.id !== editing.id).map((r) => r.color)}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refreshAll();
          }}
        />
      )}
      {deleting && (
        <DeleteRepoModal
          repo={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await refreshAll();
          }}
        />
      )}
    </div>
  );
}

/** Add-Repository wizard. Folder FIRST: pick a folder, detect its SCM, then
 *  branch. Git → choose slots/ephemeral → (slots) prefix+count → init. Perforce
 *  is always slot mode → connect → disk preflight → build the frozen base →
 *  prefix+count → init. The step list is computed from the draft, so the header
 *  shows just "Step N". */
/** Derive a sensible default repo id + slot prefix from a repo path —
 *  basename, lowercased, trailing `.git` stripped, non-alnum→dash.
 *  Handles both POSIX (`/`) and Windows (`\`) separators.
 *  E.g. `/Users/me/code/MyGame/` → `mygame`,
 *       `C:\Users\me\code\MyGame` → `mygame`,
 *       `/Users/me/widgets.git`  → `widgets`. */
function deriveRepoId(path: string): string {
  const basename = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  return basename.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Perforce setup, orchestrated on ONE progress screen: build the base + all
 *  slot clones (a single elevated UAC), create the repo record, then init each
 *  slot's p4 client (the clones already exist, so this is unprivileged). Streams
 *  live progress; on any failure it stops and offers a back-out. */
function SlotSetupProgress({
  draft,
  sizeGb,
  onDone,
  onBack,
  onClose,
  onSettled,
}: {
  draft: NewRepoDraft;
  sizeGb: number;
  onDone: () => void;
  onBack: () => void;
  /** Hard-close the wizard (discard) — the error state's Close button. */
  onClose: () => void;
  /** Signals whether the wizard may UNLOCK its X + scrim: true ONLY when the run
   *  FAILED, so a stuck failure can be dismissed. On success it stays locked and
   *  exits via Done → onCreated, so the X can't bypass the repo refresh. */
  onSettled?: (canDismiss: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const isP4 = draft.scm === 'perforce';
  const [phase, setPhase] = useState<'building' | 'creating' | 'initing' | 'done' | 'error'>('building');
  const [progress, setProgress] = useState('');
  const [slotDone, setSlotDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  // Unlock the wizard's X + scrim ONLY on failure, so a FAILED setup can be
  // dismissed (previously it trapped the modal — only Back worked). A SUCCESSFUL
  // run stays locked and exits through the Done button (→ onCreated), so the X
  // can't dismiss past the repo-refresh step.
  useEffect(() => {
    onSettled?.(phase === 'error');
  }, [phase, onSettled]);

  useEffect(() => window.popbot.repos.onBaseProgress((m) => setProgress(m)), []);

  useEffect(() => {
    if (ran.current) return; // run the orchestration exactly once
    ran.current = true;
    const id = draft.id.trim().toLowerCase();
    void (async () => {
      try {
        // 1. Elevated: freeze the base + mount every slot clone (one UAC).
        const built = await window.popbot.repos.buildBase({
          repoPath: draft.repoPath.trim(),
          repoId: id,
          baseName: id,
          sizeGb,
          // p4 connection drives the changelist capture — empty for git.
          port: isP4 ? draft.p4Port.trim() : '',
          user: isP4 ? draft.p4User.trim() : '',
          depotPath: isP4 ? draft.p4Depot.trim() : '',
          baseChangelist: isP4 ? draft.baseChangelist : 0,
          slotPrefix: draft.slotPrefix.trim(),
          slotCount: draft.slotCount,
        });
        if (!built.ok) {
          setError(built.error);
          setPhase('error');
          return;
        }
        // 2. Create the repo record (with the captured base changelist).
        setProgress('');
        setPhase('creating');
        const created = await window.popbot.repos.create({
          id,
          repoPath: draft.repoPath.trim(),
          color: draft.color,
          slotPrefix: draft.slotPrefix.trim(),
          defaultBase: isP4 ? '' : draft.defaultBase.trim(),
          slotCount: draft.slotCount,
          mode: 'slots',
          scm: draft.scm ?? 'git',
          p4: isP4
            ? {
                port: draft.p4Port.trim(),
                user: draft.p4User.trim(),
                depotPath: draft.p4Depot.trim(),
                // The detected main workspace client — its view holds the full
                // (aggregate) include list used to scope "recent changes".
                mainClient: draft.p4Client.trim() || undefined,
                shadoBase: id,
                baseChangelist: built.baseChangelist,
                agentCwd: draft.p4AgentCwd.trim() || undefined,
              }
            : undefined,
        });
        if (!created.ok) {
          setError(
            created.reason === 'duplicate-id'
              ? t('prefs.repos.error.duplicateId', { id })
              : created.reason === 'duplicate-path'
                ? t('prefs.repos.error.duplicatePath', { id: created.existingId })
                : created.reason === 'invalid' ? created.message : t('prefs.repos.error.generic'),
          );
          setPhase('error');
          return;
        }
        // 3. Init each slot's p4 client (clones exist → unprivileged).
        setPhase('initing');
        for (let k = 1; k <= draft.slotCount; k += 1) {
          const r = await window.popbot.repos.initializeOneSlot(id, k);
          if (!('ok' in r) || !r.ok) {
            setError('error' in r ? r.error : t('prefs.repos.error.generic'));
            setPhase('error');
            return;
          }
          setSlotDone(k);
        }
        setPhase('done');
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="modal-body">
        {phase === 'building' && (
          <p className="pref-progress"><i className="fa-solid fa-spinner fa-spin" /> {progress || t('prefs.repos.wizard.progress.building')}</p>
        )}
        {phase === 'creating' && (
          <p className="pref-progress"><i className="fa-solid fa-spinner fa-spin" /> {t('prefs.repos.wizard.progress.creating')}</p>
        )}
        {phase === 'initing' && (
          <p className="pref-progress"><i className="fa-solid fa-spinner fa-spin" /> {t('prefs.repos.wizard.progress.initing', { done: slotDone, total: draft.slotCount })}</p>
        )}
        {phase === 'done' && (
          <div className="pref-ok"><i className="fa-solid fa-circle-check" /> {t('prefs.repos.wizard.progress.done', { id: draft.id, count: draft.slotCount })}</div>
        )}
        {phase === 'error' && error && (
          <>
            <div className="pref-error">{error}</div>
            <p className="pref-section-desc" style={{ marginTop: 10 }}>{t('prefs.repos.wizard.progress.failHint')}</p>
          </>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onBack} disabled={phase !== 'error'}>{t('common.back')}</button>
        <span style={{ flex: 1 }} />
        {phase === 'error' ? (
          // Setup failed — let the user bail out entirely (discard + back to
          // Preferences), not just step Back. The frozen base stays on disk.
          <button className="btn primary" onClick={onClose}>{t('common.close')}</button>
        ) : (
          <button className="btn primary" onClick={onDone} disabled={phase !== 'done'}>{t('common.done')}</button>
        )}
      </div>
    </>
  );
}

type WizardStep = 'repo' | 'mode' | 'setup' | 'progress' | 'slots' | 'init';

/** Bytes → a compact "12.3 GB" / "812 MB" string for the disk preflight. */
function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function NewRepoWizard({
  draft,
  onChange,
  onCancel,
  onCreated,
  existingIds,
  existingPaths,
  existingColors,
}: {
  draft: NewRepoDraft;
  onChange: (d: NewRepoDraft) => void;
  onCancel: () => void;
  onCreated: () => void;
  existingIds: string[];
  existingPaths: string[];
  existingColors: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const { get } = useSettings();
  const [step, setStep] = useState<WizardStep>('repo');
  // True while a build is ACTIVELY running on the 'progress' step; locks the
  // wizard X + scrim so setup can't be abandoned mid-run. Cleared when the run
  // settles (done/error) so a FAILED build can still be dismissed.
  const [progressRunning, setProgressRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Created repo record — populated once create() succeeds. Drives the SHARED
  // 'init' step (ConfigureSlotsPanel), used identically by git + perforce slots.
  const [createdRepo, setCreatedRepo] = useState<RepoRecord | null>(null);
  // Only auto-fill id / prefix / base name from the path while untouched.
  const [idTouched, setIdTouched] = useState(false);
  const [prefixTouched, setPrefixTouched] = useState(false);
  // Folder SCM detection (repo step).
  const [detecting, setDetecting] = useState(false);
  const detectSeq = useRef(0);
  // Debounce the folder detection run so we don't fire server probes (SCM
  // detection + the ambient `p4 login -s` preflight) on every keystroke.
  const detectTimer = useRef<number | null>(null);
  // Ambient Perforce login prompt — shown when folder detection finds the p4
  // session expired (the server probes would otherwise read a real workspace as
  // "not Perforce"). On success we re-detect against the same folder.
  const [p4LoginOpen, setP4LoginOpen] = useState(false);
  // Perforce base-build sub-flow + live progress for the long operations.
  const [preflight, setPreflight] = useState<BasePreflightInfo | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [progress, setProgress] = useState<string>('');

  const isP4 = draft.scm === 'perforce';
  // Lock the modal-dismiss while a long, side-effecting op is mid-flight so a
  // stray scrim click can't abandon a running measure.
  const locked = busy || preflighting;
  // The 'init' and 'progress' steps run their own slot-setup with embedded
  // footers (the shared footer below is hidden for them). The wizard's X + scrim
  // must ALSO be blocked across those steps so the setup can't be abandoned
  // mid-run — you exit via the panel's own Cancel/Close/Done, which appear at
  // the right phase.
  const chromeLocked = locked || step === 'init' || (step === 'progress' && progressRunning);

  // Uniqueness guards (also enforced server-side on create). Surface them on
  // the repo step so the user can't get all the way to submit before failing.
  const normPath = (p: string): string =>
    p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const alreadyAdded =
    draft.repoPath.trim().length > 0 &&
    existingPaths.some((p) => normPath(p) === normPath(draft.repoPath));
  const idTaken =
    draft.id.trim().length > 0 &&
    existingIds.some((id) => id.toLowerCase() === draft.id.trim().toLowerCase());

  // Live progress lines from the main process (measure + build).
  useEffect(() => window.popbot.repos.onBaseProgress((m) => setProgress(m)), []);

  // Slot mode (git OR perforce) is two screens: 'setup' (connection [p4] +
  // slots + disk check) then 'progress' (build base+clones + create + slot
  // init, with back-out). Git ephemeral stays the instant one-step create.
  const sequence: WizardStep[] = isP4
    ? ['repo', 'setup', 'progress']
    : draft.mode === 'slots'
      ? ['repo', 'mode', 'setup', 'progress']
      : ['repo', 'mode'];
  const stepNum = sequence.indexOf(step) + 1;
  // The last config step — its primary button kicks off creation. The 'setup'
  // step hands off to the orchestrated 'progress' screen; git ephemeral
  // creates directly from 'mode'.
  const lastConfig: WizardStep = !isP4 && draft.mode === 'ephemeral' ? 'mode' : 'setup';

  const onPathChange = (newPath: string): void => {
    const derived = deriveRepoId(newPath);
    const next: NewRepoDraft = {
      ...draft,
      repoPath: newPath,
      scm: null,
      p4Discovered: false,
      p4Client: '',
    };
    if (derived) {
      if (!idTouched) next.id = derived;
      if (!prefixTouched) next.slotPrefix = derived;
    }
    onChange(next);
    if (detectTimer.current != null) window.clearTimeout(detectTimer.current);
    if (!newPath.trim()) {
      setDetecting(false);
      return;
    }
    const seq = ++detectSeq.current;
    setDetecting(true);
    // Debounce the actual detection run — including the `p4 login -s` preflight
    // below — so typing a path doesn't spam server probes on each keystroke.
    detectTimer.current = window.setTimeout(() => {
      void (async () => {
        try {
          // Perforce folder probes hit the server, so an expired ambient p4
          // session would make a real workspace read as "not Perforce". Check the
          // login first; if expired, prompt to log in and re-detect afterward.
          const p4 = await window.popbot.git.p4LoginStatus().catch(() => 'unreachable' as const);
          if (seq !== detectSeq.current) return;
          if (p4 === 'expired') {
            setP4LoginOpen(true);
            return; // `finally` clears `detecting`; re-detect via the modal's onSuccess
          }
          const scm = await window.popbot.repos.detectScm(newPath.trim());
          if (seq !== detectSeq.current) return; // a newer path won
          let upd: NewRepoDraft = { ...next, scm };
          if (scm === 'perforce') {
            // Auto-fill the connection from the folder's P4 client workspace —
            // we already know the port/user/depot/changelist, so don't ask.
            const info = await window.popbot.repos.detectP4Workspace(newPath.trim());
            if (seq !== detectSeq.current) return;
            if (info) {
              upd = {
                ...upd,
                p4Port: info.port,
                p4User: info.user,
                p4Depot: info.depotPath,
                baseChangelist: info.baseChangelist,
                p4Discovered: true,
                p4Client: info.client,
              };
            } else {
              // No mapping client — manual entry, prefilled from saved defaults.
              const p4s = get<PerforceSettings>('perforce', {}) ?? {};
              upd = {
                ...upd,
                p4Port: upd.p4Port || p4s.defaultPort || '',
                p4User: upd.p4User || p4s.defaultUser || '',
              };
            }
          }
          onChange(upd);
        } catch {
          if (seq === detectSeq.current) onChange({ ...next, scm: null });
        } finally {
          if (seq === detectSeq.current) setDetecting(false);
        }
      })();
    }, 400);
  };

  // Run the disk preflight when the user reaches the setup step (re-runs on retry).
  useEffect(() => {
    if (step !== 'setup') return;
    let cancelled = false;
    setPreflight(null);
    setPreflighting(true);
    setProgress('');
    setError(null);
    void window.popbot.repos
      .basePreflight(draft.repoPath.trim())
      .then((pf) => {
        if (!cancelled) setPreflight(pf);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setPreflighting(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const canAdvance =
    step === 'repo'
      ? !detecting &&
        !alreadyAdded &&
        !idTaken &&
        draft.id.trim().length > 0 &&
        draft.repoPath.trim().length > 0 &&
        draft.scm != null &&
        (isP4 || draft.defaultBase.trim().length > 0)
      : step === 'mode'
        ? !!draft.mode
        : step === 'setup'
          ? preflight?.ok === true &&
            draft.slotPrefix.trim().length > 0 &&
            draft.slotCount >= 1 &&
            (!isP4 ||
              draft.p4Discovered ||
              (draft.p4Port.trim().length > 0 &&
                draft.p4User.trim().length > 0 &&
                draft.p4Depot.trim().length > 0))
          : step === 'slots'
            ? draft.slotPrefix.trim().length > 0 && draft.slotCount >= 1
            : true;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const ephemeral = !isP4 && draft.mode === 'ephemeral';
      const res = await window.popbot.repos.create({
        id: draft.id.trim().toLowerCase(),
        repoPath: draft.repoPath.trim(),
        color: draft.color,
        slotPrefix: ephemeral ? 'slot' : draft.slotPrefix.trim(),
        defaultBase: isP4 ? '' : draft.defaultBase.trim(),
        slotCount: ephemeral ? 1 : draft.slotCount,
        mode: isP4 ? 'slots' : draft.mode,
        scm: draft.scm ?? 'git',
        p4: isP4
          ? {
              port: draft.p4Port.trim(),
              user: draft.p4User.trim(),
              depotPath: draft.p4Depot.trim(),
              mainClient: draft.p4Client.trim() || undefined,
              shadoBase: draft.id.trim().toLowerCase(),
              baseChangelist: draft.baseChangelist,
              agentCwd: draft.p4AgentCwd.trim() || undefined,
            }
          : undefined,
      });
      if (!res.ok) {
        setError(
          res.reason === 'duplicate-id'
            ? t('prefs.repos.error.duplicateId', { id: draft.id.trim() })
            : res.reason === 'duplicate-path'
              ? t('prefs.repos.error.duplicatePath', { id: res.existingId })
              : res.reason === 'invalid' ? res.message : t('prefs.repos.error.generic'),
        );
        return;
      }
      // Both git-slots and perforce run the shared slot-init step next.
      if (ephemeral) {
        onCreated();
      } else {
        setCreatedRepo(res.repo);
        setStep('init');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const goNext = (): void => {
    if (step === lastConfig) {
      if (step === 'setup') {
        // Git-slots + perforce hand off to the orchestrated progress screen.
        setError(null);
        setProgressRunning(true);
        setStep('progress');
        return;
      }
      void submit(); // git ephemeral creates directly from 'mode'
      return;
    }
    const i = sequence.indexOf(step);
    if (i >= 0 && i < sequence.length - 1) {
      setError(null);
      setStep(sequence[i + 1]);
    }
  };
  const goBack = (): void => {
    const i = sequence.indexOf(step);
    if (i > 0) {
      setError(null);
      setStep(sequence[i - 1]);
    }
  };

  // Portal to <body>: the Preferences sheet (`.prefs`) sets `transform` +
  // `overflow: hidden`, which makes any `position: fixed` descendant resolve
  // against — and get CLIPPED by — the Preferences frame instead of the
  // viewport. Rendering outside that subtree lets the wizard overlay the whole
  // window (and centers correctly), so the footer is never clipped.
  return createPortal(
    <div className="wizard-portal">
    <div className="modal-scrim" onClick={chromeLocked ? undefined : onCancel}>
      <div className="modal wizard-modal" onClick={(e) => e.stopPropagation()} style={{ width: 540, maxWidth: '92vw' }}>
        <div className="modal-head">
          <h3>
            {t('prefs.repos.wizard.title')}
            <span className="modal-step">
              {step === 'init'
                ? t('prefs.repos.wizard.initializingSlots')
                : step === 'progress'
                  ? t('prefs.repos.wizard.settingUp')
                  : t('prefs.repos.wizard.step', { step: stepNum })}
            </span>
          </h3>
          <button className="iconbtn" onClick={onCancel} disabled={chromeLocked} title={t('common.cancel')}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="wizard-modal-body">
        {/* Repository: folder → detect → identity (shared by git + perforce) */}
        {step === 'repo' && (
          <div className="modal-body">
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.repoPath.title')}</div>
                <div className="pref-label-desc">{t('prefs.repos.wizard.repoPath.desc')}</div>
              </div>
              <div className="pref-control" style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                <input className="pref-input mono narrow" placeholder="/Users/you/code/myrepo" value={draft.repoPath}
                       onChange={(e) => onPathChange(e.target.value)} style={{ width: 260 }} />
                <button
                  type="button"
                  className="btn sm"
                  title={t('prefs.repos.wizard.browseTitle')}
                  onClick={async () => {
                    const picked = await window.popbot.files.pickDirectory({
                      title: t('prefs.repos.wizard.pickDirTitle'),
                      defaultPath: draft.repoPath || undefined,
                    });
                    if (picked) onPathChange(picked);
                  }}
                >
                  <i className="fa-solid fa-folder-open" />&nbsp;{t('prefs.repos.wizard.browse')}
                </button>
              </div>
            </div>
            {/* Reserved, fixed-height detection status under the folder box. */}
            <div className="repo-detect">
              {detecting ? (
                <span className="repo-detect-busy"><i className="fa-solid fa-spinner fa-spin" /> {t('prefs.repos.wizard.detect.detecting')}</span>
              ) : alreadyAdded ? (
                <span className="repo-detect-bad"><i className="fa-solid fa-triangle-exclamation" /> {t('prefs.repos.wizard.detect.alreadyAdded')}</span>
              ) : draft.scm === 'git' ? (
                <span className="repo-detect-git"><i className="fa-solid fa-code-branch" /> {t('prefs.repos.wizard.detect.git')}</span>
              ) : draft.scm === 'perforce' ? (
                <span className="repo-detect-perforce"><P4Glyph /> {t('prefs.repos.wizard.detect.perforce')}</span>
              ) : draft.repoPath.trim() ? (
                <span className="repo-detect-bad"><i className="fa-solid fa-triangle-exclamation" /> {t('prefs.repos.wizard.detect.invalid')}</span>
              ) : (
                <span>&nbsp;</span>
              )}
            </div>
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.shortId.title')}</div>
                <div className="pref-label-desc">
                  {idTaken
                    ? <span className="repo-detect-bad">{t('prefs.repos.wizard.detect.idTaken')}</span>
                    : t('prefs.repos.wizard.shortId.desc')}
                </div>
              </div>
              <div className="pref-control">
                <input className="pref-input mono narrow" placeholder={t('prefs.repos.wizard.shortId.placeholder')} value={draft.id}
                       onChange={(e) => { setIdTouched(true); onChange({ ...draft, id: e.target.value }); }}
                       style={{ width: 200 }} />
              </div>
            </div>
            {/* Default base is git-only — perforce has no branch model. */}
            {draft.scm === 'git' && (
              <div className="pref-row">
                <div className="pref-label">
                  <div className="pref-label-title">{t('prefs.repos.wizard.defaultBase.title')}</div>
                  <div className="pref-label-desc">{t('prefs.repos.wizard.defaultBase.desc')}</div>
                </div>
                <div className="pref-control">
                  <input className="pref-input mono narrow" value={draft.defaultBase}
                         onChange={(e) => onChange({ ...draft, defaultBase: e.target.value })} style={{ width: 200 }} />
                </div>
              </div>
            )}
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.color.title')}</div>
                <div className="pref-label-desc">{t('prefs.repos.wizard.color.desc')}</div>
              </div>
              <div className="pref-control">
                <RepoColorSwatches value={draft.color} usedColors={existingColors} onChange={(next) => onChange({ ...draft, color: next })} />
              </div>
            </div>
          </div>
        )}

        {/* Mode: git only (perforce is always slot mode → no mode step). */}
        {step === 'mode' && (
          <div className="modal-body">
            <p className="pref-section-desc">{t('prefs.repos.wizard.modeIntro')}</p>
            <label className={`mode-card ${draft.mode === 'slots' ? 'selected' : ''}`}
                   onClick={() => onChange({ ...draft, mode: 'slots' })}>
              <div className="mode-card-head">
                <i className="fa-solid fa-layer-group mode-card-icon slots" />
                <strong>{t('prefs.repos.wizard.mode.slots.title')}</strong>
                <span className="mode-card-pill">{t('prefs.repos.wizard.mode.slots.pill')}</span>
              </div>
              <p className="mode-card-lead">{t('prefs.repos.wizard.mode.slots.lead')}</p>
              <p className="mode-card-desc">{t('prefs.repos.wizard.mode.slots.desc')}</p>
            </label>
            <label className={`mode-card ${draft.mode === 'ephemeral' ? 'selected' : ''}`}
                   onClick={() => onChange({ ...draft, mode: 'ephemeral' })}>
              <div className="mode-card-head">
                <i className="fa-solid fa-wind mode-card-icon ephemeral" />
                <strong>{t('prefs.repos.wizard.mode.ephemeral.title')}</strong>
                <span className="mode-card-pill">{t('prefs.repos.wizard.mode.ephemeral.pill')}</span>
              </div>
              <p className="mode-card-lead">{t('prefs.repos.wizard.mode.ephemeral.lead')}</p>
              <p className="mode-card-desc">{t('prefs.repos.wizard.mode.ephemeral.desc')}</p>
            </label>
          </div>
        )}

        {/* Perforce: connection + base name. */}
        {/* Perforce: ONE setup screen — connection (read-only if discovered),
            slot config, and the disk preflight together. */}
        {step === 'setup' && (
          <div className="modal-body">
            {!isP4 ? (
              <p className="pref-section-desc">{t('prefs.repos.wizard.setup.gitIntro')}</p>
            ) : draft.p4Discovered ? (
              <>
                <p className="pref-section-desc">
                  {t('prefs.repos.wizard.connect.discovered', { client: draft.p4Client })}
                </p>
                <div className="pref-rows" style={{ marginTop: 12 }}>
                  <div className="repo-card-row"><span className="repo-card-label">{t('prefs.repos.wizard.connect.port.title')}</span><span className="mono">{draft.p4Port}</span></div>
                  <div className="repo-card-row"><span className="repo-card-label">{t('prefs.repos.wizard.connect.user.title')}</span><span className="mono">{draft.p4User}</span></div>
                  <div className="repo-card-row"><span className="repo-card-label">{t('prefs.repos.wizard.connect.depot.title')}</span><span className="mono">{draft.p4Depot}</span></div>
                  <div className="repo-card-row"><span className="repo-card-label">{t('prefs.repos.wizard.connect.changelist')}</span><span className="mono">{draft.baseChangelist || '—'}</span></div>
                </div>
              </>
            ) : (
              <>
                <p className="pref-section-desc">{t('prefs.repos.wizard.connect.intro')}</p>
                <div className="pref-row">
                  <div className="pref-label">
                    <div className="pref-label-title">{t('prefs.repos.wizard.connect.port.title')}</div>
                    <div className="pref-label-desc">{t('prefs.repos.wizard.connect.port.desc')}</div>
                  </div>
                  <div className="pref-control">
                    <input className="pref-input mono narrow" placeholder="ssl:host:1666" value={draft.p4Port}
                           onChange={(e) => onChange({ ...draft, p4Port: e.target.value })} style={{ width: 240 }} />
                  </div>
                </div>
                <div className="pref-row">
                  <div className="pref-label">
                    <div className="pref-label-title">{t('prefs.repos.wizard.connect.user.title')}</div>
                    <div className="pref-label-desc">{t('prefs.repos.wizard.connect.user.desc')}</div>
                  </div>
                  <div className="pref-control">
                    <input className="pref-input mono narrow" placeholder="user" value={draft.p4User}
                           onChange={(e) => onChange({ ...draft, p4User: e.target.value })} style={{ width: 240 }} />
                  </div>
                </div>
                <div className="pref-row">
                  <div className="pref-label">
                    <div className="pref-label-title">{t('prefs.repos.wizard.connect.depot.title')}</div>
                    <div className="pref-label-desc">{t('prefs.repos.wizard.connect.depot.desc')}</div>
                  </div>
                  <div className="pref-control">
                    <input className="pref-input mono narrow" placeholder="//depot/MyGame" value={draft.p4Depot}
                           onChange={(e) => onChange({ ...draft, p4Depot: e.target.value })} style={{ width: 240 }} />
                  </div>
                </div>
              </>
            )}
            {/* Agent working dir is Perforce-only — a depot subpath under the
                mount root. Hidden for git repos (their worktree root is the
                agent cwd). */}
            {isP4 && (
              <div className="pref-row">
                <div className="pref-label">
                  <div className="pref-label-title">{t('prefs.repos.wizard.agentCwd.title')}</div>
                  <div className="pref-label-desc">{t('prefs.repos.wizard.agentCwd.desc')}</div>
                </div>
                <div className="pref-control">
                  <input className="pref-input mono narrow" placeholder="/"
                         value={draft.p4AgentCwd}
                         onChange={(e) => onChange({ ...draft, p4AgentCwd: e.target.value })} style={{ width: 240 }} />
                </div>
              </div>
            )}

            <h4 style={{ margin: '18px 0 6px', fontSize: 'var(--fs-sm)' }}>{t('prefs.repos.wizard.setup.slotsHead')}</h4>
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.slotPrefix.title')}</div>
                <div className="pref-label-desc">{t('prefs.repos.wizard.slotPrefix.desc', { prefix: `${draft.slotPrefix}-N` })}</div>
              </div>
              <div className="pref-control">
                <input className="pref-input mono narrow" value={draft.slotPrefix}
                       onChange={(e) => { setPrefixTouched(true); onChange({ ...draft, slotPrefix: e.target.value }); }}
                       style={{ width: 160 }} />
              </div>
            </div>
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.slotCount.title')}</div>
                <div className="pref-label-desc">{t('prefs.repos.wizard.slotCount.desc')}</div>
              </div>
              <div className="pref-control">
                <input className="pref-input mono narrow" type="number" min={1} max={64} value={draft.slotCount}
                       onChange={(e) => onChange({ ...draft, slotCount: Math.max(1, Math.min(64, Number(e.target.value) || 1)) })}
                       style={{ width: 80 }} />
              </div>
            </div>

            <h4 style={{ margin: '18px 0 6px', fontSize: 'var(--fs-sm)' }}>{t('prefs.repos.wizard.setup.diskHead')}</h4>
            {preflighting ? (
              <p className="pref-progress"><i className="fa-solid fa-spinner fa-spin" /> {progress || t('prefs.repos.wizard.preflight.measuring')}</p>
            ) : preflight ? (
              <>
                <div className="pref-rows">
                  <div className="repo-card-row"><span className="repo-card-label">{t('prefs.repos.wizard.preflight.folder')}</span><span className="mono">{fmtBytes(preflight.folderBytes)} · {preflight.fileCount.toLocaleString()} files</span></div>
                  <div className="repo-card-row"><span className="repo-card-label">{t('prefs.repos.wizard.preflight.free')}</span><span className="mono">{fmtBytes(preflight.freeBytes)}</span></div>
                  <div className="repo-card-row"><span className="repo-card-label">{t('prefs.repos.wizard.preflight.needs')}</span><span className="mono">{fmtBytes(preflight.neededBytes)}</span></div>
                </div>
                {preflight.ok ? (
                  <div className="pref-ok"><i className="fa-solid fa-circle-check" /> {t('prefs.repos.wizard.preflight.ok')}</div>
                ) : (
                  <div className="pref-error">{t('prefs.repos.wizard.preflight.block', { free: fmtBytes(preflight.freeBytes), need: fmtBytes(preflight.neededBytes) })}</div>
                )}
              </>
            ) : null}
          </div>
        )}

        {/* Perforce: ONE progress screen — build (elevated) + create + slot
            init, with a back-out if anything fails. */}
        {step === 'progress' && (
          <SlotSetupProgress
            draft={draft}
            sizeGb={preflight?.sizeGb ?? 32}
            onDone={onCreated}
            onBack={() => setStep('setup')}
            onClose={onCancel}
            onSettled={(canDismiss) => setProgressRunning(!canDismiss)}
          />
        )}

        {/* Slots: prefix + count — SHARED by git-slots and perforce. */}
        {step === 'slots' && (
          <div className="modal-body">
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.slotPrefix.title')}</div>
                <div className="pref-label-desc">
                  {t('prefs.repos.wizard.slotPrefix.desc', { prefix: `${draft.slotPrefix}-N` })}
                </div>
              </div>
              <div className="pref-control">
                <input className="pref-input mono narrow" value={draft.slotPrefix}
                       onChange={(e) => { setPrefixTouched(true); onChange({ ...draft, slotPrefix: e.target.value }); }}
                       style={{ width: 160 }} />
              </div>
            </div>
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.slotCount.title')}</div>
                <div className="pref-label-desc">{t('prefs.repos.wizard.slotCount.desc')}</div>
              </div>
              <div className="pref-control">
                <input className="pref-input mono narrow" type="number" min={1} max={64}
                       value={draft.slotCount}
                       onChange={(e) => onChange({ ...draft, slotCount: Math.max(1, Math.min(64, Number(e.target.value) || 1)) })}
                       style={{ width: 80 }} />
              </div>
            </div>
          </div>
        )}

        {/* Init slots: the SHARED tail (provider dispatched per repo.scm). */}
        {step === 'init' && createdRepo && (
          <div className="modal-body">
            <p className="pref-section-desc" style={{ marginTop: 0 }}>
              {t(
                createdRepo.slotCount === 1
                  ? 'prefs.repos.wizard.createdOne'
                  : 'prefs.repos.wizard.created',
                { id: createdRepo.id, count: createdRepo.slotCount },
              )}
            </p>
            <ConfigureSlotsPanel
              repo={createdRepo}
              currentCount={0}
              targetCount={createdRepo.slotCount}
              onDone={onCreated}
            />
          </div>
        )}

        {error && <div className="pref-error" style={{ margin: '0 16px' }}>{error}</div>}
        </div>

        {/* 'init' (git) and 'progress' (perforce) embed their own footer.
            Footer is locked while a measure runs so it can't be abandoned. */}
        {step !== 'init' && step !== 'progress' && (
          <div className="modal-foot">
            <button className="btn" onClick={onCancel} disabled={locked}>{t('common.cancel')}</button>
            <span style={{ flex: 1 }} />
            {stepNum > 1 && (
              <button className="btn" onClick={goBack} disabled={locked}>{t('common.back')}</button>
            )}
            <button className="btn primary" disabled={!canAdvance || locked} onClick={goNext}>
              {step === lastConfig
                ? isP4
                  ? t('prefs.repos.wizard.setUp')
                  : (busy ? t('prefs.repos.wizard.adding') : t('prefs.repos.addRepository'))
                : t('common.next')}
            </button>
          </div>
        )}
      </div>
    </div>
    <P4LoginModal
      open={p4LoginOpen}
      onClose={() => setP4LoginOpen(false)}
      onSuccess={() => {
        setP4LoginOpen(false);
        onPathChange(draft.repoPath); // re-detect now that we're logged in
      }}
    />
    </div>,
    document.body,
  );
}

/** Edit existing repo. Mode, slot prefix, and slot count are all
 *  write-once (set in the create wizard, permanent thereafter): the
 *  prefix is baked into folder paths and parking-branch names already
 *  on disk, and shrinking the slot count would orphan worktrees.
 *  Path / color / default base are safely editable. */
function EditRepoModal({
  repo,
  usedColors,
  onCancel,
  onSaved,
}: {
  repo: RepoRecord;
  usedColors: string[];
  onCancel: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState({
    color: repo.color,
    defaultBase: repo.defaultBase,
    agentCwd: repo.p4?.agentCwd ?? '/',
  });
  const isP4 = repo.scm === 'perforce';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resizeOpen, setResizeOpen] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.popbot.repos.update({
        id: repo.id,
        // Repo path + slot prefix are write-once (set in the create
        // wizard, baked into folder/branch names already on disk).
        // Pass current values through unchanged.
        repoPath: repo.repoPath,
        slotPrefix: repo.slotPrefix,
        color: draft.color,
        defaultBase: draft.defaultBase,
        slotCount: repo.slotCount,
        ...(isP4 ? { agentCwd: draft.agentCwd.trim() } : {}),
      });
      if (!res.ok) {
        setError(t('prefs.repos.error.notFound'));
        return;
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 540, maxWidth: "92vw" }}>
        <div className="modal-head">
          <h3>{t('prefs.repos.edit.title', { id: repo.id })}</h3>
          <button className="iconbtn" onClick={onCancel} title={t('common.cancel')}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-body">
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.repos.edit.mode.title')}</div>
              <div className="pref-label-desc">{t('prefs.repos.edit.mode.desc')}</div>
            </div>
            <div className="pref-control">
              <span className={`repo-card-mode mode-${repo.mode}`}>
                {repo.mode === 'ephemeral'
                  ? t('prefs.repos.mode.ephemeral')
                  : t('prefs.repos.mode.slots', { count: repo.slotCount })}
              </span>
            </div>
          </div>
          {repo.mode === 'slots' && (
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.card.slotPrefix')}</div>
                <div className="pref-label-desc">{t('prefs.repos.edit.slotPrefix.desc')}</div>
              </div>
              <div className="pref-control">
                <span className="mono" style={{ color: 'var(--fg-2)' }}>{repo.slotPrefix}-N</span>
              </div>
            </div>
          )}
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.repos.wizard.repoPath.title')}</div>
              <div className="pref-label-desc">{t('prefs.repos.edit.repoPath.desc')}</div>
            </div>
            <div className="pref-control" style={{ flex: 1 }}>
              <span className="mono" style={{ color: 'var(--fg-2)' }}>{repo.repoPath}</span>
            </div>
          </div>
          {/* Perforce has no branch model — no default base to edit. */}
          {(repo.scm ?? 'git') !== 'perforce' && (
            <div className="pref-row">
              <div className="pref-label"><div className="pref-label-title">{t('prefs.repos.card.defaultBase')}</div></div>
              <div className="pref-control">
                <input className="pref-input mono narrow" value={draft.defaultBase}
                       onChange={(e) => setDraft({ ...draft, defaultBase: e.target.value })} style={{ width: 200 }} />
              </div>
            </div>
          )}
          <div className="pref-row">
            <div className="pref-label"><div className="pref-label-title">{t('prefs.repos.wizard.color.title')}</div></div>
            <div className="pref-control">
              <RepoColorSwatches
                value={draft.color}
                usedColors={usedColors}
                onChange={(next) => setDraft({ ...draft, color: next })}
              />
            </div>
          </div>
          {isP4 && (
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.agentCwd.title')}</div>
                <div className="pref-label-desc">{t('prefs.repos.wizard.agentCwd.desc')}</div>
              </div>
              <div className="pref-control">
                <input className="pref-input mono narrow" placeholder="/"
                       value={draft.agentCwd}
                       onChange={(e) => setDraft({ ...draft, agentCwd: e.target.value })} style={{ width: 240 }} />
              </div>
            </div>
          )}
          {repo.mode === 'slots' && (
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.slotCount.title')}</div>
                <div className="pref-label-desc">
                  {t('prefs.repos.edit.slotCount.desc')}
                </div>
              </div>
              <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="mono" style={{ color: 'var(--fg-2)' }}>{repo.slotCount}</span>
                <button className="btn sm" onClick={() => setResizeOpen(true)}>{t('prefs.repos.edit.resizeSlots')}</button>
              </div>
            </div>
          )}
        </div>
        {error && <div className="pref-error" style={{ margin: '0 16px' }}>{error}</div>}
        <div className="modal-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
      {resizeOpen && (
        <ResizeSlotsModal
          repo={repo}
          onClose={() => {
            setResizeOpen(false);
            // Slot count may have changed — close the edit modal too so
            // the parent re-fetches and the card reflects the new value.
            onSaved();
          }}
        />
      )}
    </div>
  );
}

/** Standalone modal wrapping {@link ConfigureSlotsPanel}. The user
 *  picks the new target count, then runs the per-slot init/delete loop
 *  with progress. We pop this from the Edit Repo modal so the panel's
 *  scrim stacks on top of the edit-modal scrim, giving a clear "this
 *  is a sub-action" feel. */
function ResizeSlotsModal({
  repo,
  onClose,
}: {
  repo: RepoRecord;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [target, setTarget] = useState(repo.slotCount);
  const [confirmed, setConfirmed] = useState(false);

  // Nested inside the Edit-repo modal's own scrim (z50) + modal (z51), this
  // modal's box was painted UNDER the edit modal — only its scrim darkening
  // showed. `modal-scrim-stacked` lifts it above (z60) so it actually appears.
  // (Portaling to <body> instead sent it BEHIND the Preferences sheet.)
  return (
    <div className="modal-scrim modal-scrim-stacked" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 540, maxWidth: "92vw" }}>
        <div className="modal-head">
          <h3>{t('prefs.repos.resize.title')} <span className="modal-step mono">{repo.id}</span></h3>
          <button className="iconbtn" onClick={onClose} title={t('common.cancel')}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-body">
          {!confirmed ? (
            <>
              <div className="pref-row">
                <div className="pref-label">
                  <div className="pref-label-title">{t('prefs.repos.resize.newCount.title')}</div>
                  <div className="pref-label-desc">
                    {t('prefs.repos.resize.newCount.desc', { count: repo.slotCount })}
                  </div>
                </div>
                <div className="pref-control">
                  <input className="pref-input mono narrow" type="number" min={1} max={64}
                         value={target}
                         onChange={(e) => setTarget(Math.max(1, Math.min(64, Number(e.target.value) || 1)))}
                         style={{ width: 80 }} />
                </div>
              </div>
            </>
          ) : (
            <ConfigureSlotsPanel
              repo={repo}
              currentCount={repo.slotCount}
              targetCount={target}
              onDone={onClose}
            />
          )}
        </div>
        {!confirmed && (
          <div className="modal-foot">
            <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <span style={{ flex: 1 }} />
            <button className="btn primary" disabled={target < 1} onClick={() => setConfirmed(true)}>
              {t('common.continue')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Delete-confirm modal: shows the chat-count warning and requires the
 *  user to type the repo id verbatim before the Delete button enables. */
function DeleteRepoModal({
  repo,
  onCancel,
  onDeleted,
}: {
  repo: RepoRecord;
  onCancel: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [chatCount, setChatCount] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.popbot.repos.countChats(repo.id).then(setChatCount).catch((err) => {
      setError((err as Error).message);
      setChatCount(0);
    });
  }, [repo.id]);

  const matches = typed.trim() === repo.id;

  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.popbot.repos.delete(repo.id);
      if (!res.ok) {
        // Keep the modal open with the reason so the user can clear whatever's
        // blocking cleanup (a locked folder, a running app — maybe reboot) and
        // retry; the repo stays in the list, never half-deleted.
        setError(res.message);
        return;
      }
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: "92vw" }}>
        <div className="modal-head">
          <h3 style={{ color: 'var(--danger, #d33)' }}>
            <i className="fa-solid fa-triangle-exclamation" />&nbsp;{t('prefs.repos.delete.title')}
          </h3>
          <button className="iconbtn" onClick={onCancel} title={t('common.cancel')}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-body">
          <p>
            {t('prefs.repos.delete.about', { id: repo.id })}
          </p>
          {chatCount !== null && chatCount > 0 && (
            <div className="pref-warn" style={{ marginBottom: 12 }}>
              {t(
                chatCount === 1
                  ? 'prefs.repos.delete.attachedWarningOne'
                  : 'prefs.repos.delete.attachedWarning',
                { count: chatCount },
              )}
            </div>
          )}
          <p style={{ fontSize: 13, color: 'var(--fg-2)' }}>
            <i className="fa-solid fa-info-circle" />&nbsp;
            <strong>{t('prefs.repos.delete.reversible')}</strong>{' '}
            {t('prefs.repos.delete.reversibleBody', { id: repo.id })}
          </p>
          <p style={{ fontSize: 13, color: 'var(--fg-2)' }}>
            <i className="fa-solid fa-shield-halved" style={{ color: '#5fb98a' }} />&nbsp;
            {t('prefs.repos.delete.noTouch', { path: repo.repoPath })}
          </p>
          <div style={{ marginTop: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-2)', marginBottom: 4 }}>
              {t('prefs.repos.delete.typeToConfirm', { id: repo.id })}
            </label>
            <input
              className="pref-input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              style={{ width: '100%' }}
              placeholder={repo.id}
            />
          </div>
        </div>
        {error && <div className="pref-error" style={{ margin: '0 16px' }}>{error}</div>}
        <div className="modal-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
          <span style={{ flex: 1 }} />
          <button className="btn danger" disabled={!matches || busy} onClick={() => void submit()}>
            {busy ? t('prefs.repos.delete.deleting') : t('prefs.repos.delete.title')}
          </button>
        </div>
      </div>
    </div>
  );
}

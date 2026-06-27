import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hotkey } from '../lib/hotkeys';
import { useTranslation } from '../lib/i18n';
import { LOCALES, type Locale, type MessageKey } from '@shared/i18n';
import linearIcon from '../assets/notif/linear.png';
import jiraIcon from '../assets/notif/jira.png';
import githubIcon from '../assets/notif/github.png';
import type { LinearProjectDto } from '@shared/linear';
import type { GithubTestResult, JiraSettings } from '@shared/ticketProvider';
import {
  ATTACHMENT_TTL_DAYS_DEFAULT,
  ATTACHMENT_TTL_DAYS_MAX,
  ATTACHMENT_TTL_DAYS_MIN,
  CLAUDE_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
  clampAttachmentTtlDays,
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
import type { BasePreflightInfo } from '@shared/ipc';
import { useSettings } from '../lib/useSettings';
import { ConfigureSlotsPanel } from './ConfigureSlotsPanel';
import { P4Glyph } from './P4Glyph';
import {
  AGENT_EFFORT_DEFAULTS_SETTING,
  normalizeAgentEffortDefaults,
  reasoningEffortLabel,
  type AgentEffortDefaultsSettings,
} from './AgentCreateControls';
import { DEFAULT_REPO_COLOR, POPBOT_PALETTE } from '../lib/repoColor';
import {
  CODE_REVIEW_TEMPLATE_VARS,
  DEFAULT_ADDRESS_CR_TEMPLATE,
  DEFAULT_COMMIT_AI_TEMPLATE,
  DEFAULT_MAKE_PR_READY_TEMPLATE,
  DEFAULT_PUSH_DRAFT_PR_TEMPLATE,
  DEFAULT_PUSH_PR_TEMPLATE,
  DEFAULT_REBASE_BASE_TEMPLATE,
  DEFAULT_RE_REVIEW_TEMPLATE,
  DEFAULT_START_CODE_REVIEW_TEMPLATE,
  DEFAULT_START_TICKET_TEMPLATE,
  GIT_ACTION_TEMPLATE_VARS,
  GIT_REBASE_TEMPLATE_VARS,
  TICKET_TEMPLATE_VARS,
} from '../lib/templates';

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
   *  in the app — e.g. the slot-not-configured prompt opens 'runtime'. */
  initialSection?: string;
}

interface NavSection {
  id: string;
  /** i18n key for the nav label (translated at render time). */
  labelKey: MessageKey;
  icon: string;
}

// Only sections with a real component below are listed here. The
// "Coming soon" entries (general, appearance, agents, automation,
// windows, shortcuts, privacy, advanced) were removed because they
// confused first-time users into thinking the prefs were broken; we
// can put them back here as each one ships.
const SECTIONS: NavSection[] = [
  { id: 'integ', labelKey: 'prefs.section.integ', icon: 'fa-plug' },
  { id: 'agents', labelKey: 'prefs.section.agents', icon: 'fa-robot' },
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
}: PreferencesSheetProps): JSX.Element {
  // Fall back to the first section if we're handed (or deep-linked to) an
  // id that no longer has a render branch — otherwise the content pane
  // renders empty with nothing highlighted in the nav.
  const known = (id: string | undefined): string =>
    SECTIONS.some((s) => s.id === id) ? (id as string) : SECTIONS[0].id;
  const [section, setSection] = useState(() => known(initialSection));
  const { t } = useTranslation();

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
                onClick={() => setSection(s.id)}
              >
                <i className={`fa-solid ${s.icon}`} />
                <span>{t(s.labelKey)}</span>
              </button>
            ))}
          </nav>
          <div className="prefs-content">
            {section === 'integ' && <PrefsIntegrations onLinearChanged={onLinearChanged} />}
            {section === 'agents' && <PrefsAgents />}
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
          <span className="prefs-foot-meta">{t('prefs.footMeta')}</span>
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

function PrefsAgents(): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const saved = normalizeAgentEffortDefaults(
    get<AgentEffortDefaultsSettings>(AGENT_EFFORT_DEFAULTS_SETTING),
  );
  const [values, setValues] = useState(saved);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setValues(saved);
  }, [
    saved.claudeReasoningEffort,
    saved.codexReasoningEffort,
    saved.codeReviewClaudeReasoningEffort,
    saved.codeReviewCodexReasoningEffort,
  ]);

  if (loading) return <div className="pref-section"><h3>{t('prefs.agents.title')}</h3></div>;

  const dirty =
    values.claudeReasoningEffort !== saved.claudeReasoningEffort
    || values.codexReasoningEffort !== saved.codexReasoningEffort
    || values.codeReviewClaudeReasoningEffort !== saved.codeReviewClaudeReasoningEffort
    || values.codeReviewCodexReasoningEffort !== saved.codeReviewCodexReasoningEffort;

  const save = async () => {
    await set(AGENT_EFFORT_DEFAULTS_SETTING, values satisfies AgentEffortDefaultsSettings);
    setSavedAt(Date.now());
  };

  return (
    <div className="pref-section">
      <h3>{t('prefs.agents.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.agents.desc')}
      </p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.agents.newChats.title')}</div>
            <div className="pref-label-desc">
              {t('prefs.agents.newChats.desc')}
            </div>
          </div>
          <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <AgentEffortField
              label="Claude"
              value={values.claudeReasoningEffort}
              options={CLAUDE_REASONING_EFFORTS}
              onChange={(claudeReasoningEffort) => setValues((prev) => ({ ...prev, claudeReasoningEffort }))}
            />
            <AgentEffortField
              label="Codex"
              value={values.codexReasoningEffort}
              options={CODEX_REASONING_EFFORTS}
              onChange={(codexReasoningEffort) => setValues((prev) => ({ ...prev, codexReasoningEffort }))}
            />
          </div>
        </div>

        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.agents.codeReviews.title')}</div>
            <div className="pref-label-desc">
              {t('prefs.agents.codeReviews.desc')}
            </div>
          </div>
          <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <AgentEffortField
              label="Claude"
              value={values.codeReviewClaudeReasoningEffort}
              options={CLAUDE_REASONING_EFFORTS}
              onChange={(codeReviewClaudeReasoningEffort) => setValues((prev) => ({ ...prev, codeReviewClaudeReasoningEffort }))}
            />
            <AgentEffortField
              label="Codex"
              value={values.codeReviewCodexReasoningEffort}
              options={CODEX_REASONING_EFFORTS}
              onChange={(codeReviewCodexReasoningEffort) => setValues((prev) => ({ ...prev, codeReviewCodexReasoningEffort }))}
            />
          </div>
        </div>

        <div className="pref-row wide">
          <div className="pref-control" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, width: '100%' }}>
            {savedAt && !dirty && (
              <span style={{ color: 'var(--fg-3)', fontSize: 11, alignSelf: 'center' }}>{t('common.saved')}</span>
            )}
            <button className="btn primary sm" disabled={!dirty} onClick={() => void save()}>
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentEffortField<T extends ClaudeReasoningEffort | CodexReasoningEffort>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="mono" style={{ color: 'var(--fg-2)', fontSize: 11 }}>{label}</span>
      <select
        className="pref-input"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as T)}
        style={{ width: 112 }}
      >
        {options.map((item) => (
          <option key={item} value={item}>{reasoningEffortLabel(item, t)}</option>
        ))}
      </select>
    </label>
  );
}

function PrefsAttachments(): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const initial = get<AttachmentsSettings>('attachments', {}) ?? {};
  const savedDays = clampAttachmentTtlDays(initial.ttlDays ?? ATTACHMENT_TTL_DAYS_DEFAULT);
  const [days, setDays] = useState<number>(savedDays);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Sync once useSettings finishes loading — same pattern as PrefsApps:
  // the first render captures the default before the saved value lands.
  useEffect(() => { setDays(savedDays); }, [savedDays]);

  if (loading) return <div className="pref-section"><h3>{t('prefs.runtime.title')}</h3></div>;

  const dirty = days !== savedDays;

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
              style={{ width: 90 }}
            />
            <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>{t('common.days')}</span>
          </div>
        </div>
        <div className="pref-row">
          <div className="pref-label" />
          <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn primary sm"
              disabled={!dirty}
              onClick={async () => {
                const ttlDays = clampAttachmentTtlDays(days);
                setDays(ttlDays);
                await set('attachments', { ttlDays } satisfies AttachmentsSettings);
                setSavedAt(Date.now());
              }}
            >
              {t('common.save')}
            </button>
            {savedAt && !dirty && (
              <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('common.saved')}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface SelectChoice { id: string; label: string; icon: ReactNode }

/** Issue trackers selectable as the ticket source. Each has its own config
 *  form below; capabilities (status changes, project scoping, etc.) are
 *  declared in shared/ticketProvider.ts and feature-detected by the UI. */
const TRACKERS: SelectChoice[] = [
  { id: 'linear', label: 'Linear', icon: <img src={linearIcon} alt="" className="tracker-dd-ico" /> },
  { id: 'jira', label: 'Jira', icon: <img src={jiraIcon} alt="" className="tracker-dd-ico" /> },
  { id: 'github', label: 'GitHub', icon: <img src={githubIcon} alt="" className="tracker-dd-ico" /> },
];

/** Game engines selectable as the launch target. Only Unity ships today. */
const ENGINES: SelectChoice[] = [
  { id: 'unity', label: 'Unity', icon: <i className="fa-solid fa-cube tracker-dd-ico-fa" /> },
];

/** Custom (non-native) dropdown — square panels + an icon per option,
 *  which a native <select> can't render. Used for the ticket-source and
 *  game-engine selectors. */
function IconSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: SelectChoice[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  // Which option the keyboard cursor is on while the menu is open.
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const currentIndex = Math.max(0, options.findIndex((t) => t.id === value));
  const current = options[currentIndex] ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture-phase Escape so it closes only this dropdown without also
    // bubbling to a parent modal / global hotkeys (same approach as
    // BaseBranchPicker in BaseBranchDialog).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btnRef.current?.focus(); }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Each time we open, start the cursor on the current selection.
  useEffect(() => { if (open) setActive(currentIndex); }, [open, currentIndex]);

  // Move DOM focus to the active option so screen readers announce it and
  // keyboard users see a real focus ring while arrowing through the menu.
  useEffect(() => { if (open) itemRefs.current[active]?.focus(); }, [open, active]);

  const choose = (i: number): void => {
    const opt = options[i];
    if (opt) onChange(opt.id);
    setOpen(false);
    btnRef.current?.focus();
  };

  // Arrow/Enter/Space while focus is within the component. Escape is
  // handled by the capture-phase listener above so it can't leak to a
  // parent.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => (i + 1) % options.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => (i - 1 + options.length) % options.length);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!open) setOpen(true);
        else choose(active);
        break;
      default:
        break;
    }
  };

  return (
    <div className="tracker-dd" ref={ref} onKeyDown={onKeyDown}>
      <button
        ref={btnRef}
        type="button"
        className="tracker-dd-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current.icon}
        <span>{current.label}</span>
        <i className="fa-solid fa-chevron-down tracker-dd-caret" />
      </button>
      {open && (
        <div className="tracker-dd-menu" role="listbox">
          {options.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              className={`tracker-dd-item${t.id === value ? ' selected' : ''}${i === active ? ' active' : ''}`}
              role="option"
              aria-selected={t.id === value}
              onClick={() => choose(i)}
              onMouseEnter={() => setActive(i)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  // Game engine launched for a chat's worktree. Same always-shown,
  // default-to-the-only-option model as the ticket source.
  const rawEngine = get<string>('gameEngine', 'unity') ?? 'unity';

  // Validate the persisted value against the options that actually ship.
  // A stale/unsupported id (e.g. ticketSource:'jira' from an older build)
  // would otherwise render the fallback button with nothing selected while
  // the invalid value lingers in storage.
  const tracker = TRACKERS.some((t) => t.id === rawTracker) ? rawTracker : TRACKERS[0].id;
  const engine = ENGINES.some((e) => e.id === rawEngine) ? rawEngine : ENGINES[0].id;

  // Heal a stale value in place so it stops being dead/invalid state. Only
  // writes when the stored value differs from the normalized one, so this
  // can't loop.
  useEffect(() => {
    if (!loading && rawTracker !== tracker) void set('ticketSource', tracker);
  }, [loading, rawTracker, tracker]);
  useEffect(() => {
    if (!loading && rawEngine !== engine) void set('gameEngine', engine);
  }, [loading, rawEngine, engine]);

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

      {/* Game engine — same selector model as the ticket source. */}
      <div className="pref-section">
        <div className="tracker-select-row">
          <h3 style={{ margin: 0 }}>{t('prefs.integ.gameEngine.title')}</h3>
          <IconSelect value={engine} onChange={(v) => void set('gameEngine', v)} options={ENGINES} />
        </div>
        <p className="pref-section-desc">
          {t('prefs.integ.gameEngine.desc')}
        </p>
        <div className="tracker-config">
          <div className="tracker-config-head">
            <i className="fa-solid fa-cube tracker-dd-ico-fa" />
            <span>Unity</span>
          </div>
          <div className="tracker-config-body">
            <UnityConfig />
          </div>
        </div>
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
  const [savedCap, setSavedCap] = useState(false);
  const [savedGit, setSavedGit] = useState(false);

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
              style={{ width: 100 }}
            />
            <button
              className="btn primary sm"
              onClick={async () => {
                const max = clampMaxChangedFiles(maxFiles);
                setMaxFiles(max);
                await set('sourceControl', { ...scInitial, maxChangedFiles: max } satisfies SourceControlSettings);
                setSavedCap(true);
              }}
            >
              {t('common.save')}
            </button>
            {savedCap && <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('common.saved')}</span>}
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
                  style={{ width: 160 }}
                />
                <button
                  className="btn primary sm"
                  onClick={async () => {
                    await set('git', { ...initial, username: username.trim() });
                    setSavedGit(true);
                  }}
                >
                  {t('common.save')}
                </button>
                {savedGit && <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('common.saved')}</span>}
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
  const [saved, setSaved] = useState(false);

  useEffect(() => { setP4Path(initial.p4Path ?? ''); }, [initial.p4Path]);
  useEffect(() => { setDefaultPort(initial.defaultPort ?? ''); }, [initial.defaultPort]);
  useEffect(() => { setDefaultUser(initial.defaultUser ?? ''); }, [initial.defaultUser]);
  useEffect(() => { setParallelThreads(initial.parallelThreads ?? 4); }, [initial.parallelThreads]);
  useEffect(() => { setRevertUnchanged(initial.revertUnchanged !== false); }, [initial.revertUnchanged]);

  if (loading) return <></>;

  return (
    <div className="tracker-config" style={{ marginTop: 16 }}>
      <div className="tracker-config-head">
        <P4Glyph style={{ color: '#4c00ff' }} />
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
                     onChange={(e) => setP4Path(e.target.value)} style={{ width: 240 }} />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.perforce.defaultPort.title')}</div>
              <div className="pref-label-desc">{t('prefs.perforce.defaultPort.desc')}</div>
            </div>
            <div className="pref-control">
              <input className="pref-input mono" placeholder="ssl:host:1666" value={defaultPort}
                     onChange={(e) => setDefaultPort(e.target.value)} style={{ width: 240 }} />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.perforce.defaultUser.title')}</div>
              <div className="pref-label-desc">{t('prefs.perforce.defaultUser.desc')}</div>
            </div>
            <div className="pref-control">
              <input className="pref-input mono" placeholder="user" value={defaultUser}
                     onChange={(e) => setDefaultUser(e.target.value)} style={{ width: 240 }} />
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
                     style={{ width: 100 }} />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">{t('prefs.perforce.revertUnchanged.title')}</div>
              <div className="pref-label-desc">{t('prefs.perforce.revertUnchanged.desc')}</div>
            </div>
            <div className="pref-control">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={revertUnchanged} onChange={(e) => setRevertUnchanged(e.target.checked)} />
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-2)' }}>{t('prefs.perforce.revertUnchanged.toggle')}</span>
              </label>
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label" />
            <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn primary sm"
                onClick={async () => {
                  await set('perforce', {
                    ...initial,
                    p4Path: p4Path.trim() || undefined,
                    defaultPort: defaultPort.trim() || undefined,
                    defaultUser: defaultUser.trim() || undefined,
                    parallelThreads,
                    revertUnchanged,
                  } satisfies PerforceSettings);
                  setSaved(true);
                }}
              >
                {t('common.save')}
              </button>
              {saved && <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('common.saved')}</span>}
            </div>
          </div>
        </div>
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
  /** Absolute path to the Unity Editor binary. When set, slot launches
   *  go direct (no Unity Hub round-trip). */
  unityBinary?: string;
  /** Path of the Unity project relative to the worktree root.
   *  Defaults to blank (worktree root is the Unity project). */
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
  const [savedAt, setSavedAt] = useState<number | null>(null);

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

  const dirty =
    terminalApp !== (initial.terminalApp || 'iTerm') ||
    windowsShell !== (initial.windowsShell || 'powershell') ||
    editorApp !== (initial.editorApp || 'vscode') ||
    browserChromeProfile !== (initial.browserChromeProfile || '');

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
              onChange={(e) => setTerminalApp(e.target.value)}
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
                onChange={(e) => setWindowsShell(e.target.value)}
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
              onChange={(e) => setEditorApp(e.target.value)}
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
              style={{ width: '100%' }}
            />
          </div>
        </div>
        <div className="pref-row">
          <div className="pref-label" />
          <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn primary sm"
              disabled={!dirty}
              onClick={async () => {
                await set('apps', {
                  ...initial,
                  terminalApp,
                  windowsShell,
                  editorApp,
                  browserChromeProfile: browserChromeProfile.trim() || undefined,
                } satisfies AppsSettings);
                setSavedAt(Date.now());
              }}
            >
              {t('common.save')}
            </button>
            {savedAt && !dirty && (
              <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('common.saved')}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function UnityConfig(): JSX.Element {
  const { t } = useTranslation();
  const { get, set, loading } = useSettings();
  const initial = get<AppsSettings>('apps', {}) ?? {};
  const [versions, setVersions] = useState<Array<{ version: string; binary: string }>>([]);
  const [scanning, setScanning] = useState(true);
  const [picked, setPicked] = useState<string>(initial.unityBinary ?? '');
  const [subpath, setSubpath] = useState<string>(initial.unityProjectSubpath ?? '');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const refresh = async () => {
    setScanning(true);
    const list = await window.popbot.unity.listVersions();
    setVersions(list);
    setScanning(false);
  };
  useEffect(() => { void refresh(); }, []);

  // useState captured initial.* on first render, but useSettings starts
  // empty while loading — so without this the fields render blank and a
  // Save would clobber the real apps.unityBinary/unityProjectSubpath with
  // empty defaults. Re-sync once the persisted values land. Same
  // sync-on-load pattern as PrefsApps/PrefsGit.
  useEffect(() => { setPicked(initial.unityBinary ?? ''); }, [initial.unityBinary]);
  useEffect(() => { setSubpath(initial.unityProjectSubpath ?? ''); }, [initial.unityProjectSubpath]);

  if (loading) return <p className="pref-section-desc">{t('common.loading')}</p>;

  const dirty =
    picked !== (initial.unityBinary ?? '') ||
    subpath !== (initial.unityProjectSubpath ?? '');

  return (
    <>
      <p className="pref-section-desc">
        {t('prefs.apps.unity.desc', { path: '/Applications/Unity/Hub/Editor' })}
      </p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.apps.unity.editorVersion.title')}</div>
            <div className="pref-label-desc">
              {scanning
                ? t('prefs.apps.unity.scanning')
                : t('prefs.apps.unity.installedCount', { count: versions.length })}{' '}
              ·{' '}
              <button
                className="btn-link"
                onClick={() => void refresh()}
                style={{ background: 'none', border: 0, color: 'var(--acc-hi)', cursor: 'pointer', padding: 0 }}
              >
                {t('prefs.apps.unity.rescan')}
              </button>
            </div>
          </div>
          <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
            <select
              className="pref-input mono"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              style={{ width: '100%' }}
              disabled={versions.length === 0}
            >
              <option value="">{t('prefs.apps.unity.selectVersion')}</option>
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
              <div>
                {t('prefs.apps.unity.noneFound', { path: '/Applications/Unity/Hub/Editor' })}
              </div>
            </div>
          </div>
        )}
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.apps.unity.customBinary.title')}</div>
            <div className="pref-label-desc">{t('prefs.apps.unity.customBinary.desc')}</div>
          </div>
          <div className="pref-control" style={{ flex: 1, minWidth: 280 }}>
            <input
              className="pref-input mono"
              placeholder="/path/to/Unity.app/Contents/MacOS/Unity"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
        </div>
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">{t('prefs.apps.unity.subpath.title')}</div>
            <div className="pref-label-desc">
              {t('prefs.apps.unity.subpath.desc')}
            </div>
          </div>
          <div className="pref-control" style={{ minWidth: 240 }}>
            <input
              className="pref-input mono"
              placeholder={t('prefs.apps.unity.subpath.placeholder')}
              value={subpath}
              onChange={(e) => setSubpath(e.target.value)}
              style={{ width: 240 }}
            />
          </div>
        </div>
        <div className="pref-row">
          <div className="pref-label" />
          <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn primary sm"
              disabled={!dirty}
              onClick={async () => {
                // Merge into the apps blob; that's where the launcher reads from.
                const cur = get<AppsSettings>('apps', {}) ?? {};
                await set('apps', {
                  ...cur,
                  unityBinary: picked.trim() || undefined,
                  unityProjectSubpath: subpath.trim() || undefined,
                } satisfies AppsSettings);
                setSavedAt(Date.now());
              }}
            >
              {t('common.save')}
            </button>
            {savedAt && !dirty && (
              <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('common.saved')}</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

interface TemplatesSettings {
  startTicket?: string;
  startCodeReview?: string;
  reReview?: string;
  commitAi?: string;
  pushPr?: string;
  pushDraftPr?: string;
  makePrReady?: string;
  addressCr?: string;
  rebaseBase?: string;
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
  const [savedAt, setSavedAt] = useState<number | null>(null);

  if (loading) return <div />;

  const dirty = fields.some((f) => values[f.key] !== (initial[f.key] ?? f.fallback));
  const setField = (key: string, v: string): void =>
    setValues((prev) => ({ ...prev, [key]: v }));
  const resetAll = (): void => {
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = f.fallback;
    setValues(out);
  };
  const save = async (): Promise<void> => {
    const next: TemplatesSettings = { ...initial };
    for (const f of fields) (next as Record<string, string>)[f.key] = values[f.key] ?? f.fallback;
    await set('templates', next);
    setSavedAt(Date.now());
  };

  return (
    <>
      {intro}
      {fields.map((f) => (
        <div key={f.key} className="pref-template-block">
          <h4 className="pref-subhead">{t(f.labelKey)}</h4>
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
            spellCheck={false}
            rows={f.rows}
          />
        </div>
      ))}
      <div className="pref-template-actions">
        <button className="btn ghost sm" onClick={resetAll}>{t('prefs.templates.resetDefaults')}</button>
        <span style={{ flex: 1 }} />
        <button
          className="btn primary sm"
          disabled={!dirty}
          onClick={() => void save()}
        >
          {t('common.save')}
        </button>
        {savedAt && !dirty && (
          <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('common.saved')}</span>
        )}
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
  const [searchDays, setSearchDays] = useState(initialSearch.recentDays ?? DEFAULT_SEARCH_DAYS);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Sync once `useSettings` finishes loading — without this the
  // initial useState value (default) wins over the persisted setting
  // and a Save would clobber the user's saved preference.
  useEffect(() => { setSearchDays(initialSearch.recentDays ?? DEFAULT_SEARCH_DAYS); }, [initialSearch.recentDays]);

  if (loading) return <div className="pref-section"><h3>{t('prefs.reviews.title')}</h3></div>;

  const dirty =
    listToLines(initial.ignoreTitlePatterns ?? DEFAULT_REVIEW_TITLE_PATTERNS) !== titles ||
    listToLines(initial.ignoreAuthors) !== authors ||
    (initialSearch.recentDays ?? DEFAULT_SEARCH_DAYS) !== searchDays;

  const save = async (): Promise<void> => {
    await set('reviews', {
      ...(initial as Record<string, unknown>),
      ignoreTitlePatterns: linesToList(titles),
      ignoreAuthors: linesToList(authors),
    } satisfies ReviewsSettings);
    await set('panela.search', {
      ...(initialSearch as Record<string, unknown>),
      recentDays: searchDays,
    } satisfies PanelASearchSettings);
    setSavedAt(Date.now());
  };

  const reset = (): void => {
    setTitles(listToLines(DEFAULT_REVIEW_TITLE_PATTERNS));
    setAuthors('');
  };

  return (
    <div className="pref-section">
      <h3>{t('prefs.reviews.title')}</h3>
      <p className="pref-section-desc">
        {t('prefs.reviews.desc', { tag: 'ENG-####' })}
      </p>

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
          style={{ width: 80 }}
        />
        <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>{t('common.days')}</span>
      </div>

      <h4 className="pref-subhead">{t('prefs.reviews.ignoreTitle.title')}</h4>
      <textarea
        className="pref-template mono"
        value={titles}
        onChange={(e) => setTitles(e.target.value)}
        spellCheck={false}
        rows={6}
        placeholder={t('prefs.reviews.ignoreTitle.placeholder')}
      />

      <h4 className="pref-subhead" style={{ marginTop: 18 }}>{t('prefs.reviews.ignoreAuthor.title')}</h4>
      <textarea
        className="pref-template mono"
        value={authors}
        onChange={(e) => setAuthors(e.target.value)}
        spellCheck={false}
        rows={6}
        placeholder={t('prefs.reviews.ignoreAuthor.placeholder')}
      />

      <div className="pref-template-actions">
        <button className="btn ghost sm" onClick={reset}>{t('prefs.templates.resetDefaults')}</button>
        <span style={{ flex: 1 }} />
        <button className="btn primary sm" disabled={!dirty} onClick={() => void save()}>{t('common.save')}</button>
        {savedAt && !dirty && (
          <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('common.saved')}</span>
        )}
      </div>
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

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedAs(null);
    try {
      const result = await window.popbot.linear.test(apiKey.trim());
      if (!result.ok) {
        setError(result.error === 'auth'
          ? t('prefs.integ.linear.error.auth')
          : t('prefs.integ.linear.error.generic', { error: result.error }));
        return;
      }
      await onSave({
        apiKey: apiKey.trim(),
        teamKey: teamKey.trim(),
        projectId: projectId.trim() || undefined,
      });
      setSavedAs({ email: result.email, name: result.name });
    } finally {
      setSaving(false);
    }
  };

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
            onChange={(e) => setProjectId(e.target.value)}
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
            {error ? (
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
          <button
            className="btn primary sm"
            disabled={!apiKey.trim() || saving}
            onClick={() => void save()}
          >
            {saving ? t('prefs.integ.linear.verifying') : t('common.save')}
          </button>
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

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSavedAs(null);
    try {
      const result = await window.popbot.jira.test(draft());
      if (!result.ok) {
        setError(
          result.error === 'auth'
            ? t('prefs.integ.jira.error.auth')
            : t('prefs.integ.jira.error.generic', { error: result.error }),
        );
        return;
      }
      await onSave(draft());
      setSavedAs({ email: result.email, name: result.name });
    } catch (err) {
      setError(
        t('prefs.integ.jira.error.generic', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const ready = Boolean(baseUrl.trim() && email.trim() && apiToken.trim());

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
            onChange={(e) => setProjectKey(e.target.value)}
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
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">{t('common.status')}</div>
          <div className="pref-label-desc">
            {error ? (
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
          <button
            className="btn primary sm"
            disabled={!ready || saving}
            onClick={() => void save()}
          >
            {saving ? t('prefs.integ.jira.verifying') : t('common.save')}
          </button>
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

  const onSave = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.popbot.settings.set('sentry', {
        enabled,
        authToken: authToken.trim() || undefined,
        orgSlug: orgSlug.trim() || undefined,
        projectSlug: projectSlug.trim() || undefined,
        pollIntervalMs: Math.max(1, Math.min(60, pollMins)) * 60_000,
      } satisfies SentryUiSettings);
    } finally {
      setBusy(false);
    }
  };

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
            onClick={() => setEnabled((v) => !v)}
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
          <button className="btn primary sm" disabled={busy} onClick={() => void onSave()}>
            {busy ? t('common.saving') : t('common.save')}
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

  const onSave = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.popbot.settings.set('slack', {
        enabled,
        token: token.trim() || undefined,
        pollIntervalMs: Math.max(1, Math.min(10, pollMins)) * 60_000,
      } satisfies SlackUiSettings);
    } finally {
      setBusy(false);
    }
  };

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
            onClick={() => setEnabled((v) => !v)}
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
          <button className="btn primary sm" disabled={busy} onClick={() => void onSave()}>
            {busy ? t('common.saving') : t('common.save')}
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
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    void window.popbot.settings.get<NotificationsUiSettings>('notifications').then((s) => {
      if (s?.vips) setVipsText(s.vips.join('\n'));
      setCenterFly(s?.centerFly !== false);
      setLoaded(true);
    });
  }, []);

  const onSave = async (): Promise<void> => {
    setBusy(true);
    try {
      const vips = vipsText.split('\n').map((s) => s.trim()).filter(Boolean);
      await window.popbot.settings.set('notifications', {
        vips,
        centerFly,
      } satisfies NotificationsUiSettings);
      setSavedAt(Date.now());
      // Tell the live App to refetch the notifications prefs so the
      // toast placement / bell pulse reflect the new setting without
      // requiring a reload.
      globalThis.dispatchEvent(new CustomEvent('popbot:notifications-prefs-changed'));
    } finally {
      setBusy(false);
    }
  };

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
                const next = e.target.checked;
                setCenterFly(next);
                // Save + broadcast immediately so the toggle takes
                // effect without requiring a separate Save click.
                // The vips list comes along for the ride so we don't
                // overwrite it with stale defaults.
                const vips = vipsText.split('\n').map((s) => s.trim()).filter(Boolean);
                void window.popbot.settings.set('notifications', {
                  vips,
                  centerFly: next,
                } satisfies NotificationsUiSettings);
                globalThis.dispatchEvent(new CustomEvent('popbot:notifications-prefs-changed'));
              }}
            />
            <span>{t('prefs.notify.centerFly.label')}</span>
          </label>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-3)', maxWidth: 480 }}>
            {t('prefs.notify.centerFly.desc')}
          </p>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label" />
        <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {savedAt && (
            <span className="pill done">
              <i className="fa-solid fa-circle-check" /> {t('prefs.notify.savedPill')}
            </span>
          )}
          <button className="btn primary sm" disabled={busy} onClick={() => void onSave()}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
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

  // Merge core tools with user-added (non-core) rules so MCP / custom
  // tools the user has opinions on don't disappear from the list.
  const coreNames = new Set(CORE_TOOLS.map((tool) => tool.name));
  const customToolNames = rules.map((r) => r.tool).filter((name) => !coreNames.has(name));
  const renderRows: Array<{ name: string; description: string | null }> = [
    ...CORE_TOOLS.map((tool) => ({ name: tool.name, description: t(tool.descKey) })),
    ...customToolNames.map((name) => ({ name, description: null })),
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
                  {row.name}
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
                aria-label={t('prefs.permissions.toolDefaultAria', { tool: row.name })}
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
  // Perforce connection (collected on the connect step).
  p4Port: string;
  p4User: string;
  p4Depot: string;
  // Produced by the base-build step; baked into the p4 config on create.
  shadoBase: string;
  baseChangelist: number;
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
    shadoBase: '',
    baseChangelist: 0,
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
              {(r.scm ?? 'git') === 'perforce' ? (
                // Perforce has no default branch — keep the row's height so
                // the card doesn't resize.
                <div className="repo-card-row" aria-hidden>
                  <span className="repo-card-label">&nbsp;</span>
                  <span className="mono">&nbsp;</span>
                </div>
              ) : (
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

type WizardStep = 'repo' | 'mode' | 'connect' | 'preflight' | 'build' | 'slots' | 'init';

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
  // Perforce base-build sub-flow + live progress for the long operations.
  const [preflight, setPreflight] = useState<BasePreflightInfo | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildDone, setBuildDone] = useState(false);
  const [progress, setProgress] = useState<string>('');

  const isP4 = draft.scm === 'perforce';
  // Lock the modal-dismiss while a long, side-effecting op is mid-flight so a
  // stray scrim click can't abandon a running measure/build.
  const locked = busy || building || preflighting;

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

  // Git + perforce share the SAME slot-init tail (slots → init); they differ
  // only in setup: git picks a mode, perforce connects + builds a frozen base.
  const sequence: WizardStep[] = isP4
    ? ['repo', 'connect', 'preflight', 'build', 'slots', 'init']
    : draft.mode === 'slots'
      ? ['repo', 'mode', 'slots', 'init']
      : ['repo', 'mode'];
  const stepNum = sequence.indexOf(step) + 1;
  // The step whose Next submits create(): just before 'init', or the final
  // step when there's no init (git ephemeral ends at 'mode').
  const submitStep: WizardStep = sequence.includes('init') ? 'slots' : 'mode';

  const onPathChange = (newPath: string): void => {
    const derived = deriveRepoId(newPath);
    const next: NewRepoDraft = { ...draft, repoPath: newPath, scm: null };
    if (derived) {
      if (!idTouched) next.id = derived;
      if (!prefixTouched) next.slotPrefix = derived;
      if (!draft.shadoBase) next.shadoBase = derived;
    }
    onChange(next);
    if (!newPath.trim()) {
      setDetecting(false);
      return;
    }
    const seq = ++detectSeq.current;
    setDetecting(true);
    void window.popbot.repos
      .detectScm(newPath.trim())
      .then((scm) => {
        if (seq !== detectSeq.current) return; // a newer path won
        const upd: NewRepoDraft = { ...next, scm };
        if (scm === 'perforce') {
          const p4s = get<PerforceSettings>('perforce', {}) ?? {};
          if (!upd.p4Port && p4s.defaultPort) upd.p4Port = p4s.defaultPort;
          if (!upd.p4User && p4s.defaultUser) upd.p4User = p4s.defaultUser;
          if (!upd.shadoBase) upd.shadoBase = derived || upd.id;
        }
        onChange(upd);
      })
      .catch(() => {
        if (seq === detectSeq.current) onChange({ ...next, scm: null });
      })
      .finally(() => {
        if (seq === detectSeq.current) setDetecting(false);
      });
  };

  // Run the disk preflight when the user reaches that step (re-runs on retry).
  useEffect(() => {
    if (step !== 'preflight') return;
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
        : step === 'connect'
          ? draft.p4Port.trim().length > 0 &&
            draft.p4User.trim().length > 0 &&
            draft.p4Depot.trim().length > 0 &&
            draft.shadoBase.trim().length > 0
          : step === 'preflight'
            ? preflight?.ok === true
            : step === 'build'
              ? buildDone && draft.baseChangelist > 0
              : step === 'slots'
                ? draft.slotPrefix.trim().length > 0 && draft.slotCount >= 1
                : true;

  const runBuild = async (): Promise<void> => {
    setBuilding(true);
    setError(null);
    setProgress('');
    try {
      const res = await window.popbot.repos.buildBase({
        repoPath: draft.repoPath.trim(),
        repoId: draft.id.trim().toLowerCase(),
        baseName: draft.shadoBase.trim(),
        sizeGb: preflight?.sizeGb ?? 32,
        port: draft.p4Port.trim(),
        user: draft.p4User.trim(),
        depotPath: draft.p4Depot.trim(),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onChange({ ...draft, baseChangelist: res.baseChangelist });
      setBuildDone(true);
      setProgress('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBuilding(false);
    }
  };

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
              shadoBase: draft.shadoBase.trim(),
              baseChangelist: draft.baseChangelist,
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
    if (step === submitStep) {
      void submit();
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

  return (
    <div className="modal-scrim" onClick={locked ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 540, maxWidth: '92vw' }}>
        <div className="modal-head">
          <h3>
            {t('prefs.repos.wizard.title')}
            <span className="modal-step">
              {step === 'init'
                ? t('prefs.repos.wizard.initializingSlots')
                : step === 'build'
                  ? t('prefs.repos.wizard.buildingBase')
                  : t('prefs.repos.wizard.step', { step: stepNum })}
            </span>
          </h3>
          <button className="iconbtn" onClick={onCancel} disabled={locked} title={t('common.cancel')}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

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
                <span className="repo-detect-ok"><i className="fa-solid fa-code-branch" /> {t('prefs.repos.wizard.detect.git')}</span>
              ) : draft.scm === 'perforce' ? (
                <span className="repo-detect-ok"><P4Glyph style={{ color: '#4c00ff' }} /> {t('prefs.repos.wizard.detect.perforce')}</span>
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
        {step === 'connect' && (
          <div className="modal-body">
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
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">{t('prefs.repos.wizard.connect.baseName.title')}</div>
                <div className="pref-label-desc">{t('prefs.repos.wizard.connect.baseName.desc')}</div>
              </div>
              <div className="pref-control">
                <input className="pref-input mono narrow" placeholder="mygame" value={draft.shadoBase}
                       onChange={(e) => onChange({ ...draft, shadoBase: e.target.value })} style={{ width: 240 }} />
              </div>
            </div>
          </div>
        )}

        {/* Perforce: disk preflight — blocks when space is insufficient. */}
        {step === 'preflight' && (
          <div className="modal-body">
            <p className="pref-section-desc">{t('prefs.repos.wizard.preflight.intro')}</p>
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

        {/* Perforce: build the frozen base (elevated, long → live progress). */}
        {step === 'build' && (
          <div className="modal-body">
            <p className="pref-section-desc">{t('prefs.repos.wizard.build.intro', { gb: preflight ? fmtBytes(preflight.folderBytes) : '' })}</p>
            <div className="repo-card-row"><span className="repo-card-label">{t('prefs.repos.wizard.build.baseName')}</span><span className="mono">{draft.shadoBase}</span></div>
            {!buildDone ? (
              building ? (
                <p className="pref-progress"><i className="fa-solid fa-spinner fa-spin" /> {progress || t('prefs.repos.wizard.build.starting')}</p>
              ) : (
                <p style={{ marginTop: 12 }}>
                  <button className="btn primary" onClick={() => void runBuild()}>
                    <i className="fa-solid fa-hammer" />&nbsp;{t('prefs.repos.wizard.build.start')}
                  </button>
                </p>
              )
            ) : (
              <>
                <div className="pref-ok"><i className="fa-solid fa-circle-check" /> {t('prefs.repos.wizard.build.done')}</div>
                <div className="pref-row">
                  <div className="pref-label">
                    <div className="pref-label-title">{t('prefs.repos.wizard.build.changelist')}</div>
                    <div className="pref-label-desc">{t('prefs.repos.wizard.build.changelistDesc')}</div>
                  </div>
                  <div className="pref-control">
                    <input type="number" className="pref-input mono narrow" min={0} value={draft.baseChangelist}
                           onChange={(e) => onChange({ ...draft, baseChangelist: Math.max(0, Number(e.target.value) || 0) })}
                           style={{ width: 140 }} />
                  </div>
                </div>
              </>
            )}
          </div>
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

        {/* 'init' embeds its own foot via ConfigureSlotsPanel; the build action
            lives in the body, then Next advances. Footer is locked while a
            long, side-effecting op runs so the flow can't be abandoned mid-run. */}
        {step !== 'init' && (
          <div className="modal-foot">
            <button className="btn" onClick={onCancel} disabled={locked}>{t('common.cancel')}</button>
            <span style={{ flex: 1 }} />
            {stepNum > 1 && (
              <button className="btn" onClick={goBack} disabled={locked}>{t('common.back')}</button>
            )}
            <button className="btn primary" disabled={!canAdvance || locked} onClick={goNext}>
              {step === submitStep
                ? (busy ? t('prefs.repos.wizard.adding') : t('prefs.repos.addRepository'))
                : t('common.next')}
            </button>
          </div>
        )}
      </div>
    </div>
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
  });
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
          <div className="pref-row">
            <div className="pref-label"><div className="pref-label-title">{t('prefs.repos.card.defaultBase')}</div></div>
            <div className="pref-control">
              <input className="pref-input mono narrow" value={draft.defaultBase}
                     onChange={(e) => setDraft({ ...draft, defaultBase: e.target.value })} style={{ width: 200 }} />
            </div>
          </div>
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

  return (
    <div className="modal-scrim" onClick={onClose}>
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
    try {
      await window.popbot.repos.delete(repo.id);
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
          <p style={{ fontSize: 13, color: 'var(--fg-3)' }}>
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

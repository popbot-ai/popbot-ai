import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hotkey } from '../lib/hotkeys';
import linearIcon from '../assets/notif/linear.png';
import jiraIcon from '../assets/notif/jira.png';
import type { LinearProjectDto } from '@shared/linear';
import type { JiraSettings } from '@shared/ticketProvider';
import {
  ATTACHMENT_TTL_DAYS_DEFAULT,
  ATTACHMENT_TTL_DAYS_MAX,
  ATTACHMENT_TTL_DAYS_MIN,
  CLAUDE_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
  clampAttachmentTtlDays,
  type AttachmentsSettings,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type RepoRecord,
  type RepoWorktreeMode,
} from '@shared/persistence';
import { useSettings } from '../lib/useSettings';
import { ConfigureSlotsPanel } from './ConfigureSlotsPanel';
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
  label: string;
  icon: string;
}

// Only sections with a real component below are listed here. The
// "Coming soon" entries (general, appearance, agents, automation,
// windows, shortcuts, privacy, advanced) were removed because they
// confused first-time users into thinking the prefs were broken; we
// can put them back here as each one ships.
const SECTIONS: NavSection[] = [
  { id: 'integ', label: 'Integrations', icon: 'fa-plug' },
  { id: 'agents', label: 'Agents', icon: 'fa-robot' },
  { id: 'runtime', label: 'Runtime', icon: 'fa-microchip' },
  { id: 'repos', label: 'Repositories', icon: 'fa-code-fork' },
  { id: 'git', label: 'Source control', icon: 'fa-code-branch' },
  { id: 'apps', label: 'External apps', icon: 'fa-arrow-up-right-from-square' },
  { id: 'templates', label: 'Prompt templates', icon: 'fa-file-lines' },
  { id: 'reviews', label: 'Code reviews', icon: 'fa-code-pull-request' },
  { id: 'notify', label: 'Notifications', icon: 'fa-bell' },
  { id: 'permissions', label: 'Permissions', icon: 'fa-shield-halved' },
];

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

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="prefs" data-screen-label="Preferences">
        <div className="prefs-head">
          <h2><i className="fa-solid fa-gear" /> Preferences</h2>
          <input className="prefs-search" placeholder="Search preferences…" />
          <button className="iconbtn" onClick={onClose} style={{ width: 28, height: 28 }} title={`Close ${hotkey('W')}`}>
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
                <span>{s.label}</span>
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
          </div>
        </div>
        <div className="prefs-foot">
          <span className="prefs-foot-meta">PopBot · pre-alpha</span>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={onClose}>Done</button>
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

  if (loading) return <div className="pref-section"><h3>Agents</h3></div>;

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
      <h3>Agents</h3>
      <p className="pref-section-desc">
        Default effort levels for newly-created chats. Existing chats keep their
        own saved effort until you change them in the chat composer.
      </p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">New chats</div>
            <div className="pref-label-desc">
              Used by generic chats and ticket chats when the agent picker opens.
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
            <div className="pref-label-title">Code reviews</div>
            <div className="pref-label-desc">
              Used by PR review chats, re-review fallback chats, and review notifications.
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
              <span style={{ color: 'var(--fg-3)', fontSize: 11, alignSelf: 'center' }}>Saved.</span>
            )}
            <button className="btn primary sm" disabled={!dirty} onClick={() => void save()}>
              Save
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
          <option key={item} value={item}>{reasoningEffortLabel(item)}</option>
        ))}
      </select>
    </label>
  );
}

function PrefsAttachments(): JSX.Element {
  const { get, set, loading } = useSettings();
  const initial = get<AttachmentsSettings>('attachments', {}) ?? {};
  const savedDays = clampAttachmentTtlDays(initial.ttlDays ?? ATTACHMENT_TTL_DAYS_DEFAULT);
  const [days, setDays] = useState<number>(savedDays);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Sync once useSettings finishes loading — same pattern as PrefsApps:
  // the first render captures the default before the saved value lands.
  useEffect(() => { setDays(savedDays); }, [savedDays]);

  if (loading) return <div className="pref-section"><h3>Attachment retention</h3></div>;

  const dirty = days !== savedDays;

  return (
    <div className="pref-section">
      <h3>Attachment retention</h3>
      <p className="pref-section-desc">
        Files and images you attach to a chat are copied into PopBot's own
        storage so they keep opening from chat history even after the
        original moves. A startup sweep deletes copies older than this
        window to keep the folder from growing without bound.
      </p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">Keep attachments for</div>
            <div className="pref-label-desc">
              Default {ATTACHMENT_TTL_DAYS_DEFAULT} days (range {ATTACHMENT_TTL_DAYS_MIN}–{ATTACHMENT_TTL_DAYS_MAX}).
              Lower it to reclaim disk sooner; raise it to keep history longer.
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
            <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>days</span>
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
              Save
            </button>
            {savedAt && !dirty && (
              <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>Saved.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface SelectChoice { id: string; label: string; icon: ReactNode }

/** Issue trackers selectable as the ticket source. Only Linear ships
 *  today; Jira (roughed in at shared/ticketProvider.ts) slots in here. */
const TRACKERS: SelectChoice[] = [
  { id: 'linear', label: 'Linear', icon: <img src={linearIcon} alt="" className="tracker-dd-ico" /> },
  { id: 'jira', label: 'Jira', icon: <img src={jiraIcon} alt="" className="tracker-dd-ico" /> },
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

  if (loading) return <div className="pref-section"><h3>Ticket source</h3></div>;

  return (
    <>
      <div className="pref-section">
        {/* One line: the section label + the tracker selector. Always
            shown — picking a tracker is the model even with a single
            option (no "(None)"); more slot in as <option>s here. */}
        <div className="tracker-select-row">
          <h3 style={{ margin: 0 }}>Ticket source</h3>
          <IconSelect value={tracker} onChange={(v) => void set('ticketSource', v)} options={TRACKERS} />
        </div>
        <p className="pref-section-desc">
          The issue tracker that feeds the Tickets queue in Panel A, so you can
          spawn agents straight from your tracker.
        </p>
        {/* The selected tracker's config, grouped in its own box. Only the
            active tracker's form is shown; switching the selector swaps it. */}
        <div className="tracker-config">
          <div className="tracker-config-head">
            {(TRACKERS.find((t) => t.id === tracker) ?? TRACKERS[0]).icon}
            <span>{(TRACKERS.find((t) => t.id === tracker) ?? TRACKERS[0]).label}</span>
          </div>
          <div className="tracker-config-body">
            {tracker === 'jira' ? (
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
          <h3 style={{ margin: 0 }}>Game engine</h3>
          <IconSelect value={engine} onChange={(v) => void set('gameEngine', v)} options={ENGINES} />
        </div>
        <p className="pref-section-desc">
          The engine PopBot launches from a chat's worktree (the engine icon
          on each chat column).
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
  const { get, set, loading } = useSettings();
  const initial = get<GitSettings>('git', {}) ?? {};
  const [username, setUsername] = useState(initial.username ?? '');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Same sync-on-load fix as PrefsApps / UnityConfig. Without this,
  // useState captures defaults while useSettings is still loading and
  // a subsequent Save overwrites real persisted values with defaults.
  useEffect(() => { setUsername(initial.username ?? ''); }, [initial.username]);

  if (loading) return <div className="pref-section"><h3>Source control</h3></div>;

  return (
    <div className="pref-section">
      <h3>Source control</h3>
      <p className="pref-section-desc">
        Global git identity. Per-repository settings — path, base branch,
        slots, and color — live under <b>Repositories</b>.
      </p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">Branch username</div>
            <div className="pref-label-desc">
              New branches are named <span className="mono">&lt;username&gt;/&lt;ticket&gt;-&lt;slug&gt;</span>.
            </div>
          </div>
          <div className="pref-control">
            <input
              className="pref-input mono"
              placeholder="ben"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={{ width: 160 }}
            />
          </div>
        </div>
        <div className="pref-row">
          <div className="pref-label" />
          <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn primary sm"
              onClick={async () => {
                // Merge so we only edit the username and preserve any
                // legacy git fields still used as runtime fallbacks.
                await set('git', { ...initial, username: username.trim() });
                setSavedAt(Date.now());
              }}
            >
              Save
            </button>
            {savedAt && <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>Saved.</span>}
          </div>
        </div>
      </div>

      <h3 style={{ marginTop: 28 }}>Action templates</h3>
      <TemplatesGroup
        fields={GIT_ACTION_TEMPLATE_FIELDS}
        intro={
          <p className="pref-section-desc">
            Prompts the git panel sends to the chat agent when you click the
            big action button (or change base branch). Use{' '}
            <span className="mono">{'${name}'}</span> macros to inject context.
          </p>
        }
      />
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

  if (loading) return <div className="pref-section"><h3>External apps</h3></div>;

  const dirty =
    terminalApp !== (initial.terminalApp || 'iTerm') ||
    windowsShell !== (initial.windowsShell || 'powershell') ||
    editorApp !== (initial.editorApp || 'vscode') ||
    browserChromeProfile !== (initial.browserChromeProfile || '');

  return (
    <div className="pref-section">
      <h3>External apps</h3>
      <p className="pref-section-desc">
        The icon row on each chat column launches these apps pointed at the
        slot's worktree. Click to bring an existing window forward, or
        launch a fresh one.
      </p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">Terminal</div>
            <div className="pref-label-desc">Used for the terminal-icon launcher.</div>
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
              <div className="pref-label-title">Terminal shell (Windows)</div>
              <div className="pref-label-desc">
                Shell used by the in-app terminal panel. Applies to terminals
                opened after the change.
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
            <div className="pref-label-title">Code editor</div>
            <div className="pref-label-desc">
              Also used for clickable file links inside Edit tool rows.
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
            <div className="pref-label-title">Git client</div>
            <div className="pref-label-desc">
              Hardcoded to GitHub Desktop for now — picker lands when a
              teammate uses something else.
            </div>
          </div>
          <div className="pref-control" style={{ color: 'var(--fg-3)' }}>GitHub Desktop</div>
        </div>
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">Chrome profile for URLs</div>
            <div className="pref-label-desc">
              Pin URL opens to a specific Chrome profile so they always land
              in your work account, never your personal one. Use the Chrome
              profile <em>directory</em> name — find it at
              <span className="mono"> chrome://version</span> on the "Profile
              Path" line (the last path component, e.g. <span className="mono">Profile 1</span>,
              <span className="mono"> Default</span>, <span className="mono">Person 2</span>).
              Blank = OS default browser.
            </div>
          </div>
          <div className="pref-control" style={{ flex: 1, minWidth: 240 }}>
            <input
              className="pref-input mono"
              placeholder="(use OS default browser)"
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
              Save
            </button>
            {savedAt && !dirty && (
              <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>Saved.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function UnityConfig(): JSX.Element {
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

  if (loading) return <p className="pref-section-desc">Loading…</p>;

  const dirty =
    picked !== (initial.unityBinary ?? '') ||
    subpath !== (initial.unityProjectSubpath ?? '');

  return (
    <>
      <p className="pref-section-desc">
        Pick which installed Unity Editor version popbot launches when you
        click the Unity slot icon. Versions are scanned from{' '}
        <span className="mono">/Applications/Unity/Hub/Editor</span>.
      </p>
      <div className="pref-rows">
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">Editor version</div>
            <div className="pref-label-desc">
              {scanning
                ? 'Scanning…'
                : `${versions.length} installed`}{' '}
              ·{' '}
              <button
                className="btn-link"
                onClick={() => void refresh()}
                style={{ background: 'none', border: 0, color: 'var(--acc-hi)', cursor: 'pointer', padding: 0 }}
              >
                rescan
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
              <option value="">— Select a Unity version —</option>
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
                No Unity versions found under <span className="mono">/Applications/Unity/Hub/Editor</span>.
                Install via Unity Hub and click <b>rescan</b>.
              </div>
            </div>
          </div>
        )}
        <div className="pref-row">
          <div className="pref-label">
            <div className="pref-label-title">Custom binary path</div>
            <div className="pref-label-desc">Override the dropdown when Unity lives somewhere unusual.</div>
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
            <div className="pref-label-title">Project subpath</div>
            <div className="pref-label-desc">
              Path to the Unity project relative to the worktree root.
              Leave blank if the worktree root is itself the Unity
              project.
            </div>
          </div>
          <div className="pref-control" style={{ minWidth: 240 }}>
            <input
              className="pref-input mono"
              placeholder="e.g. unity-project (blank = worktree root)"
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
              Save
            </button>
            {savedAt && !dirty && (
              <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>Saved.</span>
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
  label: string;
  fallback: string;
  vars: ReadonlyArray<{ name: string; desc: string }>;
  rows: number;
}

/** Sent on chat creation. Lives under "Prompt templates". */
const CHAT_TEMPLATE_FIELDS: TemplateField[] = [
  {
    key: 'startTicket',
    label: 'Start ticket (sent on chat creation from Linear)',
    fallback: DEFAULT_START_TICKET_TEMPLATE,
    vars: TICKET_TEMPLATE_VARS,
    rows: 12,
  },
  {
    key: 'startCodeReview',
    label: 'Start code review (sent on chat creation from PR)',
    fallback: DEFAULT_START_CODE_REVIEW_TEMPLATE,
    vars: CODE_REVIEW_TEMPLATE_VARS,
    rows: 8,
  },
  {
    key: 'reReview',
    label: 'Re-review (sent when you click a RE-REVIEW chip on the incoming panel)',
    fallback: DEFAULT_RE_REVIEW_TEMPLATE,
    vars: CODE_REVIEW_TEMPLATE_VARS,
    rows: 10,
  },
];

/** Triggered from the git panel's action button. Lives under "Source control". */
const GIT_ACTION_TEMPLATE_FIELDS: TemplateField[] = [
  {
    key: 'commitAi',
    label: 'COMMIT (AI)',
    fallback: DEFAULT_COMMIT_AI_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 8,
  },
  {
    key: 'pushPr',
    label: 'PUSH PR (AI)',
    fallback: DEFAULT_PUSH_PR_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 10,
  },
  {
    key: 'pushDraftPr',
    label: 'PUSH DRAFT PR (AI)',
    fallback: DEFAULT_PUSH_DRAFT_PR_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 10,
  },
  {
    key: 'makePrReady',
    label: 'MARK PR READY (AI)',
    fallback: DEFAULT_MAKE_PR_READY_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 6,
  },
  {
    key: 'addressCr',
    label: 'ADDRESS CR (AI)',
    fallback: DEFAULT_ADDRESS_CR_TEMPLATE,
    vars: GIT_ACTION_TEMPLATE_VARS,
    rows: 10,
  },
  {
    key: 'rebaseBase',
    label: 'CHANGE BASE BRANCH (AI)',
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
          <h4 className="pref-subhead">{f.label}</h4>
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
        <button className="btn ghost sm" onClick={resetAll}>Reset to defaults</button>
        <span style={{ flex: 1 }} />
        <button
          className="btn primary sm"
          disabled={!dirty}
          onClick={() => void save()}
        >
          Save
        </button>
        {savedAt && !dirty && (
          <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>Saved.</span>
        )}
      </div>
    </>
  );
}

function PrefsTemplates(): JSX.Element {
  return (
    <div className="pref-section">
      <h3>Prompt templates</h3>
      <TemplatesGroup
        fields={CHAT_TEMPLATE_FIELDS}
        intro={
          <p className="pref-section-desc">
            These templates fire as the chat's first user message when you
            spawn a chat from a Linear ticket or a PR. Use{' '}
            <span className="mono">{'${name}'}</span> macros to inject context.
            Git-panel action templates live under{' '}
            <b>Source control → Action templates</b>.
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

  if (loading) return <div className="pref-section"><h3>Code reviews</h3></div>;

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
      <h3>Code reviews</h3>
      <p className="pref-section-desc">
        The Reviews tab pulls open PRs that either request you as a reviewer
        or have no reviews yet (and have an <span className="mono">ENG-####</span> tag in the title,
        unless you're explicitly named). PRs you've already reviewed are
        dropped automatically. Use the lists below to mute additional noise.
      </p>

      <h4 className="pref-subhead" style={{ marginTop: 18 }}>Search cache window</h4>
      <p className="pref-section-desc" style={{ marginBottom: 8 }}>
        The <strong>+ Add</strong> picker on the incoming panel fuzzy-matches against
        Linear issues + GitHub PRs updated in the last
        {' '}<strong>N days</strong>. Bigger window = more searchable, slightly
        slower refresh + more API budget. Tickets assigned to you are
        always included regardless of this cutoff.
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
        <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>days</span>
      </div>

      <h4 className="pref-subhead">Ignore by title (one substring per line, case-insensitive)</h4>
      <textarea
        className="pref-template mono"
        value={titles}
        onChange={(e) => setTitles(e.target.value)}
        spellCheck={false}
        rows={6}
        placeholder={'DO NOT SUBMIT\nCrowdin'}
      />

      <h4 className="pref-subhead" style={{ marginTop: 18 }}>Ignore by GitHub author (one login per line)</h4>
      <textarea
        className="pref-template mono"
        value={authors}
        onChange={(e) => setAuthors(e.target.value)}
        spellCheck={false}
        rows={6}
        placeholder={'crowdin-bot\nrenovate[bot]'}
      />

      <div className="pref-template-actions">
        <button className="btn ghost sm" onClick={reset}>Reset to defaults</button>
        <span style={{ flex: 1 }} />
        <button className="btn primary sm" disabled={!dirty} onClick={() => void save()}>Save</button>
        {savedAt && !dirty && (
          <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>Saved.</span>
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
        setError(result.error === 'auth' ? 'Linear rejected this API key.' : `Linear error: ${result.error}`);
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
          <div className="pref-label-title">Personal API key</div>
          <div className="pref-label-desc">
            Stored locally in this app's database.{' '}
            <a
              href="https://linear.app/settings/api"
              onClick={(e) => { e.preventDefault(); window.open('https://linear.app/settings/api', '_blank'); }}
              style={{ color: 'var(--acc)', cursor: 'pointer' }}
            >
              Get a key →
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
          <div className="pref-label-title">Team key</div>
          <div className="pref-label-desc">e.g. <span className="mono">ENG</span>. Filters issues + projects to one team.</div>
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
          <div className="pref-label-title">Project</div>
          <div className="pref-label-desc">
            Optional — narrow the ticket list to a single project.
            {projectsLoading && <span style={{ marginLeft: 6, color: 'var(--fg-3)' }}>Loading…</span>}
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
            <option value="">All projects</option>
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
          <div className="pref-label-title">Status</div>
          <div className="pref-label-desc">
            {error ? (
              <span className="pill err"><i className="fa-solid fa-circle-xmark" /> {error}</span>
            ) : savedAs ? (
              <span className="pill done">
                <i className="fa-solid fa-circle-check" /> Connected as {savedAs.email}
              </span>
            ) : wasConnected ? (
              <span className="pill done"><i className="fa-solid fa-circle-check" /> Connected</span>
            ) : (
              <span className="pill muted"><i className="fa-regular fa-circle" /> Not connected</span>
            )}
          </div>
        </div>
        <div className="pref-control" style={{ display: 'flex', gap: 8 }}>
          {wasConnected && (
            <button className="btn ghost sm" disabled={saving} onClick={() => void onDisconnect()}>
              Disconnect
            </button>
          )}
          <button
            className="btn primary sm"
            disabled={!apiKey.trim() || saving}
            onClick={() => void save()}
          >
            {saving ? 'Verifying…' : 'Save'}
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
      return;
    }
    let cancelled = false;
    setProjectsLoading(true);
    void window.popbot.jira
      .listProjects({ baseUrl: baseUrl.trim(), email: email.trim(), apiToken: apiToken.trim() })
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
            ? 'Jira rejected these credentials.'
            : `Jira error: ${result.error}`,
        );
        return;
      }
      await onSave(draft());
      setSavedAs({ email: result.email, name: result.name });
    } finally {
      setSaving(false);
    }
  };

  const ready = Boolean(baseUrl.trim() && email.trim() && apiToken.trim());

  return (
    <div className="pref-rows">
      <div className="pref-row">
        <div className="pref-label">
          <div className="pref-label-title">Site URL</div>
          <div className="pref-label-desc">
            Your Jira Cloud base URL, e.g. <span className="mono">https://your-domain.atlassian.net</span>.
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
          <div className="pref-label-title">Account email</div>
          <div className="pref-label-desc">The Atlassian account the API token belongs to.</div>
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
          <div className="pref-label-title">API token</div>
          <div className="pref-label-desc">
            Stored locally in this app's database.{' '}
            <a
              href="https://id.atlassian.com/manage-profile/security/api-tokens"
              onClick={(e) => {
                e.preventDefault();
                window.open('https://id.atlassian.com/manage-profile/security/api-tokens', '_blank');
              }}
              style={{ color: 'var(--acc)', cursor: 'pointer' }}
            >
              Get a token →
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
          <div className="pref-label-title">Project</div>
          <div className="pref-label-desc">
            Optional — narrow the ticket list to a single project.
            {projectsLoading && <span style={{ marginLeft: 6, color: 'var(--fg-3)' }}>Loading…</span>}
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
            <option value="">All projects</option>
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
          <div className="pref-label-title">JQL filter</div>
          <div className="pref-label-desc">
            Optional — extra JQL ANDed into the ticket queries, e.g.{' '}
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
          <div className="pref-label-title">Status</div>
          <div className="pref-label-desc">
            {error ? (
              <span className="pill err"><i className="fa-solid fa-circle-xmark" /> {error}</span>
            ) : savedAs ? (
              <span className="pill done">
                <i className="fa-solid fa-circle-check" /> Connected as {savedAs.email}
              </span>
            ) : wasConnected ? (
              <span className="pill done"><i className="fa-solid fa-circle-check" /> Connected</span>
            ) : (
              <span className="pill muted"><i className="fa-regular fa-circle" /> Not connected</span>
            )}
          </div>
        </div>
        <div className="pref-control" style={{ display: 'flex', gap: 8 }}>
          {wasConnected && (
            <button className="btn ghost sm" disabled={saving} onClick={() => void onDisconnect()}>
              Disconnect
            </button>
          )}
          <button
            className="btn primary sm"
            disabled={!ready || saving}
            onClick={() => void save()}
          >
            {saving ? 'Verifying…' : 'Save'}
          </button>
        </div>
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

  if (!loaded) return <div style={{ padding: 24, color: 'var(--fg-3)' }}>Loading…</div>;

  return (
    <div className="pref-section">
      <h3>Sentry</h3>
      <p className="pref-section-desc">
        Surfaces new unresolved Sentry issues as PopBot notifications. Token + org
        only — your messages and stack traces never leave your machine; PopBot reads
        the issue summaries via the Sentry REST API. Generate a token at{' '}
        <a href="https://sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noreferrer noopener">
          sentry.io → Auth Tokens
        </a>{' '}
        with scopes <code>event:read</code>, <code>project:read</code>, <code>org:read</code>.
      </p>

      <div className="pref-row">
        <div className="pref-label">Enabled</div>
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
            {enabled ? 'Polling on' : 'Off'}
          </span>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">Auth token</div>
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
        <div className="pref-label">Org slug</div>
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
        <div className="pref-label">Project slug</div>
        <div className="pref-control">
          <input
            className="input"
            placeholder="(optional — leave blank for all projects)"
            value={projectSlug}
            onChange={(e) => setProjectSlug(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">Poll interval</div>
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
          <span style={{ color: 'var(--fg-3)' }}>minutes</span>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">Status</div>
        <div className="pref-control">
          {testResult?.ok && (
            <span className="pill done">
              <i className="fa-solid fa-circle-check" /> Verified · {testResult.org}
            </span>
          )}
          {testResult?.ok === false && (
            <span className="pill err">
              <i className="fa-solid fa-circle-xmark" /> {testResult.reason}
            </span>
          )}
          {!testResult && (
            <span className="pill muted">
              <i className="fa-regular fa-circle" /> Not verified
            </span>
          )}
        </div>
        <div className="pref-control" style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn ghost sm"
            disabled={!authToken.trim() || !orgSlug.trim() || busy}
            onClick={() => void onTest()}
          >
            {busy ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn primary sm" disabled={busy} onClick={() => void onSave()}>
            {busy ? 'Saving…' : 'Save'}
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

  if (!loaded) return <div style={{ padding: 24, color: 'var(--fg-3)' }}>Loading…</div>;

  return (
    <div className="pref-section">
      <h3>Slack</h3>
      <p className="pref-section-desc">
        Surfaces unread DMs and channel @-mentions as PopBot notifications.
        Read-only — PopBot never posts on your behalf.
      </p>
      <p className="pref-section-desc" style={{ marginTop: -6, fontSize: 11 }}>
        To get a token: create a Slack app at{' '}
        <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer noopener">api.slack.com/apps</a>,
        add user-token scopes <code>channels:history</code>, <code>groups:history</code>,{' '}
        <code>im:history</code>, <code>mpim:history</code>, <code>users:read</code>,{' '}
        <code>search:read</code>, install to your workspace, then copy the User OAuth Token
        (starts with <code>xoxp-</code>).
      </p>

      <div className="pref-row">
        <div className="pref-label">Enabled</div>
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
            {enabled ? 'Polling on' : 'Off'}
          </span>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">User token</div>
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
        <div className="pref-label">Poll interval</div>
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
          <span style={{ color: 'var(--fg-3)' }}>minutes</span>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label">Status</div>
        <div className="pref-control">
          {testResult?.ok && (
            <span className="pill done">
              <i className="fa-solid fa-circle-check" /> Connected to {testResult.team} as {testResult.user}
            </span>
          )}
          {testResult?.ok === false && (
            <span className="pill err">
              <i className="fa-solid fa-circle-xmark" /> {testResult.reason}
            </span>
          )}
          {!testResult && (
            <span className="pill muted">
              <i className="fa-regular fa-circle" /> Not verified
            </span>
          )}
        </div>
        <div className="pref-control" style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn ghost sm"
            disabled={!token.trim() || busy}
            onClick={() => void onTest()}
          >
            {busy ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn primary sm" disabled={busy} onClick={() => void onSave()}>
            {busy ? 'Saving…' : 'Save'}
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

  if (!loaded) return <div style={{ padding: 24, color: 'var(--fg-3)' }}>Loading…</div>;

  return (
    <div className="pref-section">
      <h3>Notifications</h3>
      <p className="pref-section-desc">
        VIPs are people whose Slack DMs and channel mentions always get bumped
        to urgent priority + tagged with a VIP chip on the notification,
        regardless of message content. Names are matched case-insensitively as
        substrings of the Slack display name (so "York" matches "York Johnson"
        and "Yorktown Smith") — keep names specific to avoid false positives.
      </p>
      <div className="pref-row">
        <div className="pref-label">VIP names</div>
        <div className="pref-control" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <textarea
            className="input"
            placeholder={'One name per line, e.g.\nYork\nAmitt\nMatt Van'}
            value={vipsText}
            onChange={(e) => setVipsText(e.target.value)}
            rows={6}
            style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
            spellCheck={false}
          />
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">Toast placement</div>
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
            <span>Top-center, fly to bell on dismiss</span>
          </label>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-3)', maxWidth: 480 }}>
            On by default — toasts arrive at top-center, animate toward the bell
            icon when dismissed, and pulse the bell briefly so you can see
            where the notification went. Turn off if you'd rather have the
            classic top-right corner toasts. Takes effect immediately — no
            Save needed.
          </p>
        </div>
      </div>

      <div className="pref-row">
        <div className="pref-label" />
        <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {savedAt && (
            <span className="pill done">
              <i className="fa-solid fa-circle-check" /> Saved
            </span>
          )}
          <button className="btn primary sm" disabled={busy} onClick={() => void onSave()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* TEMPORARY: test buttons for the new-item flow. Each marks a
          handful of *real* items in the current queue as unseen so the
          NEW chips re-appear and the tab pip bumps. No fake data is
          injected. Remove this whole block once the flow has been
          validated end-to-end. */}
      <div className="pref-row" style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed var(--line-1)' }}>
        <div className="pref-label">Test new-item flow</div>
        <div className="pref-control" style={{ display: 'flex', gap: 8, flexDirection: 'column', alignItems: 'flex-start' }}>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-3)', maxWidth: 480 }}>
            Temporarily flags a few existing items in your real queue as NEW so
            you can verify the chip + tab pip behavior. Nothing is added,
            removed, or persisted server-side.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn ghost sm"
              onClick={() => globalThis.dispatchEvent(new CustomEvent('popbot:test-mark-unseen', { detail: { kind: 'tickets', count: 2 } }))}
            >
              <i className="fa-solid fa-flask" /> Flag 2 tickets as NEW
            </button>
            <button
              className="btn ghost sm"
              onClick={() => globalThis.dispatchEvent(new CustomEvent('popbot:test-mark-unseen', { detail: { kind: 'reviews', count: 2 } }))}
            >
              <i className="fa-solid fa-flask" /> Flag 2 PRs as NEW
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
const CORE_TOOLS: Array<{ name: string; description: string }> = [
  { name: 'Bash',         description: 'Run shell commands on your machine.' },
  { name: 'Read',         description: 'Read the contents of a file.' },
  { name: 'Write',        description: 'Create or overwrite a file.' },
  { name: 'Edit',         description: 'Modify the contents of a file.' },
  { name: 'NotebookEdit', description: 'Modify cells in a Jupyter notebook.' },
  { name: 'Grep',         description: 'Search inside files for text.' },
  { name: 'Glob',         description: 'Find files matching a name pattern.' },
  { name: 'WebFetch',     description: 'Fetch and read a remote URL.' },
  { name: 'WebSearch',    description: 'Run a web search for context.' },
  { name: 'TodoWrite',    description: "Update the agent's internal task list." },
  { name: 'Task',         description: 'Spawn a sub-agent to delegate work.' },
  { name: 'ExitPlanMode', description: 'Leave plan mode and present the plan.' },
];

type ToolState = 'ask' | 'allow' | 'deny';

function PrefsPermissions(): JSX.Element {
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
  const coreNames = new Set(CORE_TOOLS.map((t) => t.name));
  const customToolNames = rules.map((r) => r.tool).filter((name) => !coreNames.has(name));
  const renderRows: Array<{ name: string; description: string | null }> = [
    ...CORE_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    ...customToolNames.map((name) => ({ name, description: null })),
  ];

  if (!loaded) return <div style={{ padding: 24, color: 'var(--fg-3)' }}>Loading…</div>;

  const stateOf = (tool: string): ToolState => {
    const rule = rules.find((r) => r.tool === tool);
    if (!rule) return 'ask';
    return rule.action;
  };

  return (
    <div className="pref-section">
      <h3>Permissions</h3>
      <p className="pref-section-desc">
        Global default for each tool. <b>Ask</b> prompts the chat each time
        (the default). <b>Allow</b> auto-approves without prompting.
        <b> Deny</b> auto-rejects. Per-chat rules — set from the permission
        card via "Allow this chat" / "Deny this chat" — override these
        globals, so a single chat can lock down a tool you've otherwise
        allowed everywhere.
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
                aria-label={`${row.name} default`}
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
                    {s}
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
  };
}

/** Twelve-swatch color picker — replaces a freeform color input
 *  everywhere a repo accent is chosen. The fixed palette is what
 *  lets the rest of the app hardcode white text on accent buttons. */
function RepoColorSwatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  return (
    <div className="repo-swatches" role="radiogroup" aria-label="Repo color">
      {POPBOT_PALETTE.map((c) => {
        const selected = value.toLowerCase() === c.value.toLowerCase();
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={c.name}
            title={c.name}
            className={`repo-swatch ${selected ? 'selected' : ''}`}
            style={{ background: c.value }}
            onClick={() => onChange(c.value)}
          />
        );
      })}
    </div>
  );
}

function PrefsRepos({ onReposChanged }: { onReposChanged?: () => void }): JSX.Element {
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

  if (repos === null) return <div className="pref-section"><h3>Repositories</h3></div>;

  return (
    <div className="pref-section">
      <h3>Repositories</h3>
      <p className="pref-section-desc">
        Each chat lives in a repository. A repo's mode (slot pool vs.
        ephemeral worktrees) is set when it's created and can't be
        changed afterward — switching modes would orphan the worktrees
        of any chats already in flight.
      </p>
      {error && <div className="pref-error">{error}</div>}
      <div className="repo-list">
        {repos.map((r) => (
          <div key={r.id} className="repo-card" style={{ borderLeft: `4px solid ${r.color}` }}>
            <div className="repo-card-head">
              <span className="repo-card-id mono">{r.id}</span>
              <span className={`repo-card-mode mode-${r.mode}`}>
                {r.mode === 'ephemeral' ? 'ephemeral' : `slots × ${r.slotCount}`}
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => setEditing(r)}>Edit</button>
              <button className="btn sm danger" onClick={() => setDeleting(r)}>Delete…</button>
            </div>
            <div className="repo-card-body">
              <div className="repo-card-row">
                <span className="repo-card-label">Path</span>
                <span className="mono">{r.repoPath}</span>
              </div>
              <div className="repo-card-row">
                <span className="repo-card-label">Default base</span>
                <span className="mono">{r.defaultBase}</span>
              </div>
              {r.mode === 'slots' && (
                <div className="repo-card-row">
                  <span className="repo-card-label">Slot prefix</span>
                  <span className="mono">{r.slotPrefix}-N</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={() => setNewRepo(emptyDraft())}>
          <i className="fa-solid fa-plus" />&nbsp;Add Repository
        </button>
      </div>

      {newRepo && (
        <NewRepoWizard
          draft={newRepo}
          onChange={setNewRepo}
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

/** Linear, three-step wizard:
 *   1. Choose mode (with a clear explanation of the trade-off)
 *   2. Identity (id, path, color, default base)
 *   3. Slot config (slot prefix + count) — skipped for ephemeral mode
 *
 * Mode is set in step 1 and can't be revisited later because the rest
 * of the wizard depends on it (step 3 only renders for slots). */
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

function NewRepoWizard({
  draft,
  onChange,
  onCancel,
  onCreated,
}: {
  draft: NewRepoDraft;
  onChange: (d: NewRepoDraft) => void;
  onCancel: () => void;
  onCreated: () => void;
}): JSX.Element {
  // Steps: 1 mode → 2 identity → 3 slot config → 4 initialize slots.
  // Step 3 + step 4 are skipped for ephemeral repos (no slots).
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Created repo record — populated when the user completes step 3
  // (or step 2 for ephemeral). Drives step 4's ConfigureSlotsPanel.
  const [createdRepo, setCreatedRepo] = useState<RepoRecord | null>(null);
  // Track whether the user has explicitly typed in id / slot prefix
  // so we only auto-fill them from the path when they're still
  // untouched. Once edited, the user's choice wins permanently.
  const [idTouched, setIdTouched] = useState(false);
  const [prefixTouched, setPrefixTouched] = useState(false);

  const onPathChange = (newPath: string): void => {
    const next: NewRepoDraft = { ...draft, repoPath: newPath };
    const derived = deriveRepoId(newPath);
    if (derived) {
      if (!idTouched) next.id = derived;
      // Default the slot prefix to the derived repo id so worktrees
      // land at `<repoid>-N` (e.g. `ops-4`). Earlier this had a
      // length-≤8 cutoff that silently fell back to literal `slot` for
      // longer ids, which was confusing — the user can still shorten
      // it manually in step 3 if they want.
      if (!prefixTouched) next.slotPrefix = derived;
    }
    onChange(next);
  };

  const isEphemeral = draft.mode === 'ephemeral';
  // Ephemeral repos don't have a slot-init step, so the wizard ends at
  // step 2. Slot repos go all the way through step 4 (init progress).
  const lastStep: 1 | 2 | 3 | 4 = isEphemeral ? 2 : 4;
  const canAdvance =
    step === 1 ? !!draft.mode :
    step === 2 ? draft.id.trim().length > 0 && draft.repoPath.trim().length > 0 && draft.defaultBase.trim().length > 0 :
    /* step 3 */ draft.slotPrefix.trim().length > 0 && draft.slotCount >= 1;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.popbot.repos.create({
        id: draft.id.trim().toLowerCase(),
        repoPath: draft.repoPath.trim(),
        color: draft.color,
        slotPrefix: isEphemeral ? 'slot' : draft.slotPrefix.trim(),
        defaultBase: draft.defaultBase.trim(),
        slotCount: isEphemeral ? 1 : draft.slotCount,
        mode: draft.mode,
      });
      if (!res.ok) {
        setError(res.reason === 'duplicate-id'
          ? `A repo with id "${draft.id.trim()}" already exists.`
          : res.reason === 'invalid' ? res.message : 'Could not create repo.');
        return;
      }
      // Slot repo → advance to step 4 to run the slot init flow.
      // Ephemeral repo → there's no slot init, so close the wizard.
      if (isEphemeral) {
        onCreated();
      } else {
        setCreatedRepo(res.repo);
        setStep(4);
      }
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
          <h3>
            New repository
            <span className="modal-step">
              {step === 4 ? 'initializing slots' : `step ${step} of ${lastStep}`}
            </span>
          </h3>
          <button className="iconbtn" onClick={onCancel} title="Cancel">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        {step === 1 && (
          <div className="modal-body">
            <p className="pref-section-desc">
              Choose how PopBot manages worktrees for chats in this repo.
              You can't change this later.
            </p>
            <label className={`mode-card ${draft.mode === 'slots' ? 'selected' : ''}`}
                   onClick={() => onChange({ ...draft, mode: 'slots' })}>
              <div className="mode-card-head">
                <i className="fa-solid fa-layer-group mode-card-icon slots" />
                <strong>Slots</strong>
                <span className="mode-card-pill">keeps build caches warm across chats</span>
              </div>
              <p className="mode-card-lead">Permanent worktree slots reused by chats.</p>
              <p className="mode-card-desc">
                A fixed pool of N pre-allocated worktrees. Chats borrow a
                slot, work in it, then park back when closed. Each slot
                keeps its own build artifacts — Unity's <span className="mono">Library/</span>,
                <span className="mono"> node_modules/</span>, gradle/maven caches, etc.
                That means no multi-minute reimport or <span className="mono">npm install</span> every
                time you switch branches. Pick this whenever the per-branch
                setup cost is non-trivial.
              </p>
            </label>
            <label className={`mode-card ${draft.mode === 'ephemeral' ? 'selected' : ''}`}
                   onClick={() => onChange({ ...draft, mode: 'ephemeral' })}>
              <div className="mode-card-head">
                <i className="fa-solid fa-wind mode-card-icon ephemeral" />
                <strong>Ephemeral</strong>
                <span className="mode-card-pill">good for pure-code repos</span>
              </div>
              <p className="mode-card-lead">Temporary worktrees removed when a chat is closed.</p>
              <p className="mode-card-desc">
                Each chat gets its own worktree, created when the chat opens
                and removed when it closes. No pool, no parking branches.
                Best when there's no expensive per-branch cache to keep
                warm — pure-code repos, scripts, web apps with cheap installs.
              </p>
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="modal-body">
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">Repo path</div>
                <div className="pref-label-desc">Absolute path to the source clone. We'll auto-fill the id and slot prefix from the folder name (you can override).</div>
              </div>
              <div className="pref-control" style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                <input className="pref-input mono narrow" placeholder="/Users/you/code/myrepo" value={draft.repoPath}
                       onChange={(e) => onPathChange(e.target.value)} style={{ width: 260 }} />
                <button
                  type="button"
                  className="btn sm"
                  title="Browse for a folder"
                  onClick={async () => {
                    const picked = await window.popbot.files.pickDirectory({
                      title: 'Choose the source repository',
                      defaultPath: draft.repoPath || undefined,
                    });
                    if (picked) onPathChange(picked);
                  }}
                >
                  <i className="fa-solid fa-folder-open" />&nbsp;Browse…
                </button>
              </div>
            </div>
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">Short id</div>
                <div className="pref-label-desc">Lowercase, no spaces. Used in folder paths and branch prefixes. Permanent.</div>
              </div>
              <div className="pref-control">
                <input className="pref-input mono narrow" placeholder="app" value={draft.id}
                       onChange={(e) => { setIdTouched(true); onChange({ ...draft, id: e.target.value }); }}
                       style={{ width: 200 }} />
              </div>
            </div>
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">Default base branch</div>
                <div className="pref-label-desc">New chat branches fork from here.</div>
              </div>
              <div className="pref-control">
                <input className="pref-input mono narrow" value={draft.defaultBase}
                       onChange={(e) => onChange({ ...draft, defaultBase: e.target.value })} style={{ width: 200 }} />
              </div>
            </div>
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">Color</div>
                <div className="pref-label-desc">Tints this repo's slot pills + chat accents.</div>
              </div>
              <div className="pref-control">
                <RepoColorSwatches
                  value={draft.color}
                  onChange={(next) => onChange({ ...draft, color: next })}
                />
              </div>
            </div>
          </div>
        )}

        {step === 4 && createdRepo && (
          <div className="modal-body">
            <p className="pref-section-desc" style={{ marginTop: 0 }}>
              <span className="mono">{createdRepo.id}</span> is created. Now we'll
              initialize its <strong>{createdRepo.slotCount}</strong> slot worktree{createdRepo.slotCount === 1 ? '' : 's'}
              {' '}— each is a long-lived <span className="mono">git worktree</span> on its own
              parking branch, ready to host a chat.
            </p>
            <ConfigureSlotsPanel
              repo={createdRepo}
              currentCount={0}
              targetCount={createdRepo.slotCount}
              onDone={onCreated}
            />
          </div>
        )}

        {step === 3 && !isEphemeral && (
          <div className="modal-body">
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">Slot prefix</div>
                <div className="pref-label-desc">
                  Folder + parking-branch prefix. Worktrees become <span className="mono">{draft.slotPrefix}-N</span>.
                  Shorter is better — this prefix shows up in worktree paths,
                  parking branches, and the slot pill in the chat header, so a
                  long prefix wastes screen space everywhere.
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
                <div className="pref-label-title">Slot count</div>
                <div className="pref-label-desc">How many concurrent chats this repo supports. 1–64.</div>
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

        {error && <div className="pref-error" style={{ margin: '0 16px' }}>{error}</div>}

        {/* Step 4 (slot init) embeds its own foot via ConfigureSlotsPanel
            so the wizard chrome here is hidden. */}
        {step !== 4 && (() => {
          const lastInteractive: 1 | 2 | 3 = isEphemeral ? 2 : 3;
          const onNext = (): void => {
            if (step === lastInteractive) {
              void submit();
            } else {
              setStep((s) => (s === 1 ? 2 : 3));
            }
          };
          const onBack = (): void => setStep((s) => (s === 3 ? 2 : 1));
          const submitting = busy;
          return (
            <div className="modal-foot">
              <button className="btn" onClick={onCancel} disabled={submitting}>Cancel</button>
              <span style={{ flex: 1 }} />
              {step > 1 && (
                <button className="btn" onClick={onBack} disabled={submitting}>Back</button>
              )}
              <button className="btn primary" disabled={!canAdvance || submitting} onClick={onNext}>
                {step === lastInteractive
                  ? (submitting ? 'Adding…' : 'Add Repository')
                  : 'Next'}
              </button>
            </div>
          );
        })()}
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
  onCancel,
  onSaved,
}: {
  repo: RepoRecord;
  onCancel: () => void;
  onSaved: () => void;
}): JSX.Element {
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
        setError('Repo not found — was it deleted?');
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
          <h3>Edit <span className="mono">{repo.id}</span></h3>
          <button className="iconbtn" onClick={onCancel} title="Cancel">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-body">
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">Mode</div>
              <div className="pref-label-desc">Permanent. Delete + recreate the repo to switch modes.</div>
            </div>
            <div className="pref-control">
              <span className={`repo-card-mode mode-${repo.mode}`}>
                {repo.mode === 'ephemeral' ? 'ephemeral' : `slots × ${repo.slotCount}`}
              </span>
            </div>
          </div>
          {repo.mode === 'slots' && (
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">Slot prefix</div>
                <div className="pref-label-desc">Permanent — baked into folder paths and parking branches.</div>
              </div>
              <div className="pref-control">
                <span className="mono" style={{ color: 'var(--fg-2)' }}>{repo.slotPrefix}-N</span>
              </div>
            </div>
          )}
          <div className="pref-row">
            <div className="pref-label">
              <div className="pref-label-title">Repo path</div>
              <div className="pref-label-desc">Permanent. Delete + recreate to point at a different clone.</div>
            </div>
            <div className="pref-control" style={{ flex: 1 }}>
              <span className="mono" style={{ color: 'var(--fg-2)' }}>{repo.repoPath}</span>
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label"><div className="pref-label-title">Default base</div></div>
            <div className="pref-control">
              <input className="pref-input mono narrow" value={draft.defaultBase}
                     onChange={(e) => setDraft({ ...draft, defaultBase: e.target.value })} style={{ width: 200 }} />
            </div>
          </div>
          <div className="pref-row">
            <div className="pref-label"><div className="pref-label-title">Color</div></div>
            <div className="pref-control">
              <RepoColorSwatches
                value={draft.color}
                onChange={(next) => setDraft({ ...draft, color: next })}
              />
            </div>
          </div>
          {repo.mode === 'slots' && (
            <div className="pref-row">
              <div className="pref-label">
                <div className="pref-label-title">Slot count</div>
                <div className="pref-label-desc">
                  Pool size. Resizing creates or tears down worktrees one
                  at a time — refuses if any slot is held by an open chat.
                </div>
              </div>
              <div className="pref-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="mono" style={{ color: 'var(--fg-2)' }}>{repo.slotCount}</span>
                <button className="btn sm" onClick={() => setResizeOpen(true)}>Resize slots…</button>
              </div>
            </div>
          )}
        </div>
        {error && <div className="pref-error" style={{ margin: '0 16px' }}>{error}</div>}
        <div className="modal-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
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
  const [target, setTarget] = useState(repo.slotCount);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 540, maxWidth: "92vw" }}>
        <div className="modal-head">
          <h3>Resize slots <span className="modal-step mono">{repo.id}</span></h3>
          <button className="iconbtn" onClick={onClose} title="Cancel">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-body">
          {!confirmed ? (
            <>
              <div className="pref-row">
                <div className="pref-label">
                  <div className="pref-label-title">New slot count</div>
                  <div className="pref-label-desc">
                    Current: {repo.slotCount}. Increasing creates more
                    worktrees; decreasing tears down the highest-numbered
                    ones (and their parking branches).
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
            <button className="btn" onClick={onClose}>Cancel</button>
            <span style={{ flex: 1 }} />
            <button className="btn primary" disabled={target < 1} onClick={() => setConfirmed(true)}>
              Continue
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
            <i className="fa-solid fa-triangle-exclamation" />&nbsp;Delete repository
          </h3>
          <button className="iconbtn" onClick={onCancel} title="Cancel">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-body">
          <p>
            You're about to delete <strong className="mono">{repo.id}</strong>.
          </p>
          {chatCount !== null && chatCount > 0 && (
            <div className="pref-warn" style={{ marginBottom: 12 }}>
              <strong>{chatCount}</strong> chat{chatCount === 1 ? '' : 's'} {chatCount === 1 ? 'is' : 'are'} attached to this repo.
              Their conversation history is preserved in the database, but
              they'll be detached until a repo with the same id is added back.
            </div>
          )}
          <p style={{ fontSize: 13, color: 'var(--fg-2)' }}>
            <i className="fa-solid fa-info-circle" />&nbsp;
            <strong>Reversible:</strong> if you later create a new repo with the
            id <span className="mono">{repo.id}</span>, all detached chats will reattach
            automatically.
          </p>
          <p style={{ fontSize: 13, color: 'var(--fg-3)' }}>
            This won't touch the source clone at <span className="mono">{repo.repoPath}</span> or
            any chat branches in it. Slot worktrees on disk are left alone too —
            you can prune them by hand if you want a clean slate.
          </p>
          <div style={{ marginTop: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-2)', marginBottom: 4 }}>
              Type <span className="mono">{repo.id}</span> to confirm:
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
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <span style={{ flex: 1 }} />
          <button className="btn danger" disabled={!matches || busy} onClick={() => void submit()}>
            {busy ? 'Deleting…' : 'Delete repository'}
          </button>
        </div>
      </div>
    </div>
  );
}

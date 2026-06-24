import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitBaseBranches } from '@shared/git';
import type { RepoRecord } from '@shared/persistence';
import {
  AGENT_EFFORT_DEFAULTS_SETTING,
  AgentCreateControls,
  agentCreateConfigWithEffortDefaults,
  compactAgentCreateConfig,
  DEFAULT_AGENT_CREATE_CONFIG,
  type AgentCreateConfig,
  type AgentEffortDefaultsSettings,
} from './AgentCreateControls';

interface BaseBranchDialogProps {
  /** Sub-text under the title, e.g. "ENG-204 · Cooldown flicker".
   *  Ignored when {@link askSubject} is set — the user's typed subject
   *  becomes the title instead. */
  subtitle?: string;
  /** Last-used base branch (or git settings' defaultBase). Pre-selected. */
  initial?: string;
  /** Lock the dialog to a specific repo and skip the repo picker. Used
   *  by in-chat flows (e.g. GitPanel's rebase-base picker) where the
   *  chat already lives in a known repo and the picker would just be
   *  a footgun. New-chat flows omit this and get the picker. */
  lockedRepoId?: string;
  /** When set, the dialog asks the user for a chat subject + derives
   *  the branch name from it (`<username>/<slug>`). Used by the
   *  generic Cmd-K / "+" new-chat flow where there's no ticket/PR to
   *  source either from. The derived `subject` and `branch` come back
   *  in `onConfirm`. */
  askSubject?: boolean;
  /** Show a "No repo" option that creates a raw chat with no slot,
   *  worktree, branch, or base branch. Only used by generic new-chat
   *  creation; ticket/PR flows still require a real repo. */
  allowNoRepo?: boolean;
  /** Let repo-backed chats run from the repo root without allocating
   *  a slot/worktree. Used by generic lite chats that just need a
   *  normal project cwd. */
  allowRepoRoot?: boolean;
  /** Show an agent/model picker before creating the chat. */
  showAgentPicker?: boolean;
  onCancel: () => void;
  /** Returns the repo + base branch for repo-backed chats. Raw chats
   *  return null for both. Subject + derived branch only come back
   *  when {@link askSubject} is set. */
  onConfirm: (input: {
    repoId: string | null;
    baseBranch: string | null;
    subject?: string;
    branch?: string;
    workspaceMode?: 'slot' | 'repo-root';
    agentConfig?: AgentCreateConfig;
  }) => void;
}

const LAST_REPO_SETTING = 'chatCreate.lastRepoId';
const LAST_AGENT_SETTING = 'chatCreate.lastAgentConfig';
/** Most-recent-first list of previously-picked base branches; the top
 *  few surface at the top of the picker. */
const RECENT_BASE_BRANCHES_SETTING = 'chatCreate.recentBaseBranches';
const RECENTS_SHOWN = 3;

/** Sentinel `picked` value for the "Free Chat (no slot)" radio at the
 *  bottom of the branch list. Selecting it creates a slot-less chat that
 *  runs from the repo root (same as a CR chat) — no worktree, no branch —
 *  so the agent can talk about the project against the live checkout. */
const FREE_CHAT_VALUE = '__free_no_slot__';

/** Default base-branch selection, in priority order:
 *   1. The most recent previously-picked branch that still exists.
 *   2. The repo's configured default branch.
 *   3. `main`, if present.
 *   4. The first available branch.
 *  Returns empty string when the repo has no branches. */
function pickDefaultBase(repo: RepoRecord | null, branches: string[], recents: string[]): string {
  if (branches.length === 0) return '';
  const recent = recents.find((b) => branches.includes(b));
  if (recent) return recent;
  if (repo?.defaultBase && branches.includes(repo.defaultBase)) return repo.defaultBase;
  if (branches.includes('main')) return 'main';
  return branches[0];
}

/**
 * Modal that asks "which repo, and which base branch?" before chat
 * creation. Repo is picked first (last-used remembered in settings);
 * base branches re-fetch when the repo changes since they're per-clone.
 *
 * The picked repo + branch flow into `chats:create` as the chat's
 * `repoId` and `baseBranch`. The branch becomes both the worktree
 * fork point and the PR target later.
 */
/** Slugify a chat subject for branch-name derivation in the
 *  askSubject flow. Capped at 4 words — shorter than `ticketBranch`'s
 *  6 because there's no ticket id prefix to anchor identity, and the
 *  branch shows up everywhere (`gh pr list`, `git branch`, the chat
 *  header). */
function slugifySubject(subject: string, maxWords = 4): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, maxWords)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Searchable base-branch dropdown. Closed, it shows the current pick;
 *  open, it reveals a search box and the branch list with the user's
 *  recent picks (≤3) pinned at the top. */
function BaseBranchPicker({
  branches,
  recents,
  value,
  onChange,
  defaultBase,
  allowRepoRoot,
  freeChatValue,
}: {
  branches: string[];
  recents: string[];
  value: string;
  onChange: (b: string) => void;
  defaultBase?: string;
  allowRepoRoot?: boolean;
  freeChatValue: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      // Capture-phase so Escape closes the dropdown without also closing
      // the parent dialog.
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const isFree = value === freeChatValue;
  const label = isFree ? 'Free Chat (no slot)' : (value || 'Select base branch');
  const q = query.trim().toLowerCase();
  const matchesQ = (b: string): boolean => !q || b.toLowerCase().includes(q);
  const shownRecents = recents.filter((b) => branches.includes(b) && matchesQ(b)).slice(0, RECENTS_SHOWN);
  const recentSet = new Set(shownRecents);
  const others = branches.filter((b) => matchesQ(b) && !recentSet.has(b));
  const pick = (b: string): void => { onChange(b); setOpen(false); setQuery(''); };

  return (
    <div className="bb-picker" ref={ref}>
      <button
        type="button"
        className="bb-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`bb-picker-value${value ? '' : ' placeholder'}`}>{label}</span>
        <i className="fa-solid fa-chevron-down" />
      </button>
      {open && (
        <div className="bb-picker-pop" role="listbox">
          <input
            ref={inputRef}
            className="pref-input bb-picker-search"
            placeholder="Search branches…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="base-branch-list bb-picker-list">
            {branches.length === 0 && !allowRepoRoot && (
              <div style={{ padding: 8, color: 'var(--fg-3)', fontSize: 12 }}>No branches found.</div>
            )}
            {shownRecents.map((b) => (
              <button
                type="button"
                key={`recent-${b}`}
                className={`base-branch-row ${value === b ? 'selected' : ''}`}
                onClick={() => pick(b)}
              >
                <span className="base-branch-name">{b}</span>
                <span className="base-branch-tag">recent</span>
              </button>
            ))}
            {shownRecents.length > 0 && others.length > 0 && <div className="base-branch-divider" />}
            {others.map((b) => (
              <button
                type="button"
                key={b}
                className={`base-branch-row ${value === b ? 'selected' : ''}`}
                onClick={() => pick(b)}
              >
                <span className="base-branch-name">{b}</span>
                {b === defaultBase && <span className="base-branch-tag">default</span>}
              </button>
            ))}
            {allowRepoRoot && (!q || 'free chat repo root'.includes(q)) && (
              <button
                type="button"
                className={`base-branch-row ${isFree ? 'selected' : ''}`}
                onClick={() => pick(freeChatValue)}
              >
                <span className="base-branch-name">Free Chat (no slot)</span>
                <span className="base-branch-tag">repo root</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function BaseBranchDialog({
  subtitle,
  initial,
  lockedRepoId,
  askSubject,
  allowNoRepo,
  allowRepoRoot,
  showAgentPicker,
  onCancel,
  onConfirm,
}: BaseBranchDialogProps): JSX.Element {
  const [repos, setRepos] = useState<RepoRecord[] | null>(null);
  const [pickedRepoId, setPickedRepoId] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBaseBranches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>(initial ?? '');
  const [recentBases, setRecentBases] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  // A unique fallback name shown as the input's placeholder and used
  // verbatim when the user leaves the subject blank — so a chat always
  // has a valid, distinct name and creation is never silently blocked.
  const [defaultSubject] = useState(() => `new chat ${Math.random().toString(36).slice(2, 6)}`);
  const [username, setUsername] = useState<string>('pop');
  const [agentConfig, setAgentConfig] = useState<AgentCreateConfig>(DEFAULT_AGENT_CREATE_CONFIG);

  // Pull the configured git username so the derived-branch preview
  // matches what `ticketBranch` would have produced for a real ticket.
  // Falls back to 'pop' when not configured.
  useEffect(() => {
    if (!askSubject) return;
    // Auto-derived from gh/git (or the Source-control override) so branch
    // names read `you/<slug>` instead of `pop/<slug>` with no setup.
    void window.popbot.git.username().then((u) => { if (u) setUsername(u); });
  }, [askSubject]);

  useEffect(() => {
    if (!showAgentPicker) return;
    void Promise.all([
      window.popbot.settings.get<AgentCreateConfig>(LAST_AGENT_SETTING),
      window.popbot.settings.get<AgentEffortDefaultsSettings>(AGENT_EFFORT_DEFAULTS_SETTING),
    ]).then(([lastAgent, defaults]) => {
      setAgentConfig(agentCreateConfigWithEffortDefaults(lastAgent, defaults, 'general'));
    });
  }, [showAgentPicker]);

  // Blank subject falls back to the generated default, so name + branch
  // are always derivable.
  const effectiveSubject = subject.trim() || defaultSubject;
  const derivedSlug = slugifySubject(effectiveSubject);
  const derivedBranch = derivedSlug ? `${username}/${derivedSlug}` : '';
  const isRawChat = pickedRepoId === null && allowNoRepo === true;
  // "Free Chat (no slot)" radio is selected → run from the repo root with
  // no slot/worktree/branch (same as a CR chat).
  const isFreeChat = !isRawChat && pickedRepoId !== null && allowRepoRoot === true && picked === FREE_CHAT_VALUE;

  // Initial load: repos + (when not locked) the last-used repo id from
  // settings. Locked-repo callers skip the picker entirely; their repo
  // is the only choice.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await window.popbot.repos.list();
      if (cancelled) return;
      setRepos(list);
      if (lockedRepoId) {
        setPickedRepoId(lockedRepoId);
        return;
      }
      const lastUsed = (await window.popbot.settings.get<string>(LAST_REPO_SETTING)) ?? null;
      const startingRepo =
        (lastUsed && list.find((r) => r.id === lastUsed)?.id)
        ?? list[0]?.id
        ?? null;
      setPickedRepoId(startingRepo);
    })();
    return () => { cancelled = true; };
  }, [lockedRepoId, allowNoRepo]);

  // Re-fetch base branches whenever the picked repo changes.
  useEffect(() => {
    if (!pickedRepoId) {
      setBranches(null);
      setError(null);
      setPicked('');
      return;
    }
    let cancelled = false;
    setBranches(null);
    setError(null);
    void (async () => {
      const res = await window.popbot.git.listBaseBranches({ repoId: pickedRepoId });
      if (cancelled) return;
      if (!res.ok) { setError(res.reason); return; }
      setBranches(res.branches);
      const repo = repos?.find((r) => r.id === pickedRepoId) ?? null;
      const recents = (await window.popbot.settings.get<string[]>(RECENT_BASE_BRANCHES_SETTING)) ?? [];
      if (cancelled) return;
      setRecentBases(Array.isArray(recents) ? recents : []);
      // An explicit caller-supplied `initial` wins (e.g. GitPanel rebase);
      // otherwise fall back to recents → repo default → main → first.
      const next = initial && res.branches.branches.includes(initial)
        ? initial
        : pickDefaultBase(repo, res.branches.branches, Array.isArray(recents) ? recents : []);
      if (next) setPicked(next);
    })();
    return () => { cancelled = true; };
    // `initial`/recents only seed on first paint per branch list — once the
    // user explicitly picks something we don't want to keep clobbering it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedRepoId, repos]);

  const submit = (): void => {
    const chosenAgent = showAgentPicker ? compactAgentCreateConfig(agentConfig) : undefined;
    if (chosenAgent) void window.popbot.settings.set(LAST_AGENT_SETTING, chosenAgent);
    if (isRawChat) {
      onConfirm({
        repoId: null,
        baseBranch: null,
        ...(askSubject ? { subject: effectiveSubject } : {}),
        ...(chosenAgent ? { agentConfig: chosenAgent } : {}),
      });
      return;
    }
    if (!pickedRepoId) return;
    if (!isFreeChat && !picked) return;
    if (!lockedRepoId) void window.popbot.settings.set(LAST_REPO_SETTING, pickedRepoId);
    // Remember the picked base branch so it surfaces at the top of the
    // picker next time (most-recent first, capped).
    if (!isFreeChat && picked) {
      const nextRecents = [picked, ...recentBases.filter((b) => b !== picked)].slice(0, 8);
      void window.popbot.settings.set(RECENT_BASE_BRANCHES_SETTING, nextRecents);
    }
    onConfirm({
      repoId: pickedRepoId,
      baseBranch: isFreeChat ? null : picked,
      workspaceMode: isFreeChat ? 'repo-root' : 'slot',
      ...(askSubject
        ? {
            subject: effectiveSubject,
            ...(isFreeChat ? {} : { branch: derivedBranch }),
          }
        : {}),
      ...(chosenAgent ? { agentConfig: chosenAgent } : {}),
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
      // `picked` is FREE_CHAT_VALUE (truthy) when the free-chat radio is
      // selected, so the slot-branch condition already covers that case.
      else if (e.key === 'Enter' && (isRawChat || (picked && pickedRepoId))) submit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // submit closes over current state via the live binding below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, onConfirm, picked, pickedRepoId, derivedBranch, subject, isRawChat, isFreeChat]);

  const currentRepo = repos?.find((r) => r.id === pickedRepoId) ?? null;
  const allBranches = branches?.branches ?? [];

  // The subject is never blocking now — it falls back to a generated
  // default. A slot chat still needs a repo + a base branch picked.
  const noRepo = !isRawChat && !pickedRepoId;
  const noBranches = !isRawChat && !isFreeChat && branches != null && allBranches.length === 0;
  const noBranchPicked = !isRawChat && !isFreeChat && !noBranches && !picked;
  const branchesLoading = !isRawChat && !isFreeChat && branches == null && !error;
  const confirmDisabled = noRepo || noBranches || noBranchPicked || branchesLoading;
  // Plain-language reason shown beside a disabled Create button.
  const disabledReason = noRepo ? 'Pick a repository.'
    : branchesLoading ? 'Loading branches…'
      : noBranches ? 'This repo has no branches to base off — push one first.'
        : noBranchPicked ? 'Pick a base branch.'
          : '';

  return createPortal(
    <div className="confirm-scrim" onMouseDown={onCancel}>
      <div
        className="confirm-dialog base-branch-dialog"
        role="dialog"
        aria-label="Pick repo and base branch"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">New chat</div>
        {subtitle && !askSubject && <div className="base-branch-subtitle">{subtitle}</div>}
        <div className="confirm-body">
          {showAgentPicker && (
            <AgentCreateControls
              value={agentConfig}
              onChange={(next) => setAgentConfig(compactAgentCreateConfig(next))}
            />
          )}
          {askSubject && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>Subject <span style={{ opacity: 0.7 }}>(optional)</span></div>
              <input
                className="pref-input mono narrow"
                placeholder={defaultSubject}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={{ width: '100%' }}
                autoFocus
              />
              {derivedBranch && !isFreeChat && (
                <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4 }}>
                  Branch: <span className="mono">{derivedBranch}</span>
                </div>
              )}
            </div>
          )}
          {!repos && <div>Loading repos…</div>}
          {repos && repos.length === 0 && !allowNoRepo && (
            <div className="diff-overlay-status error">
              No repos configured. Add one in Preferences → Repositories.
            </div>
          )}
          {repos && (repos.length > 0 || allowNoRepo) && (
            <>
              {!lockedRepoId && (repos.length > 1 || allowNoRepo) && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>Repo</div>
                  <div className="base-branch-list">
                    {allowNoRepo && (
                      <label className={`base-branch-row ${isRawChat ? 'selected' : ''}`}>
                        <input
                          type="radio"
                          name="picked-repo"
                          value="__none__"
                          checked={isRawChat}
                          onChange={() => setPickedRepoId(null)}
                        />
                        <span className="base-branch-name mono">No repo</span>
                        <span className="base-branch-tag">raw chat</span>
                      </label>
                    )}
                    {repos.map((r) => (
                      <label key={r.id} className={`base-branch-row ${pickedRepoId === r.id ? 'selected' : ''}`}>
                        <input
                          type="radio"
                          name="picked-repo"
                          value={r.id}
                          checked={pickedRepoId === r.id}
                          onChange={() => setPickedRepoId(r.id)}
                        />
                        <span
                          className="base-branch-name mono"
                          style={{ borderLeft: `3px solid ${r.color}`, paddingLeft: 6 }}
                        >
                          {r.id}
                        </span>
                        <span className="base-branch-tag">
                          {r.mode === 'ephemeral' ? 'ephemeral' : `slots × ${r.slotCount}`}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {isRawChat ? (
                <div style={{ color: 'var(--fg-2)', fontSize: 12 }}>
                  Creates a raw chat with no worktree, slot, branch, or base branch.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>Base branch</div>
                  {!branches && !error && <div>Loading branches…</div>}
                  {error && <div className="diff-overlay-status error">Couldn't load branches: {error}</div>}
                  {branches && (
                    <BaseBranchPicker
                      branches={allBranches}
                      recents={recentBases}
                      value={picked}
                      onChange={setPicked}
                      defaultBase={currentRepo?.defaultBase}
                      allowRepoRoot={allowRepoRoot}
                      freeChatValue={FREE_CHAT_VALUE}
                    />
                  )}
                  {isFreeChat && (
                    <div style={{ color: 'var(--fg-2)', fontSize: 12, marginTop: 8 }}>
                      Runs in <span className="mono">{pickedRepoId}</span> from the repo root —
                      no slot, worktree, or branch.
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
        <div className="confirm-foot">
          {confirmDisabled && disabledReason && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', marginRight: 'auto' }}>{disabledReason}</span>
          )}
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={confirmDisabled}
            title={confirmDisabled ? disabledReason : undefined}
            autoFocus={!askSubject}
          >
            Create chat
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

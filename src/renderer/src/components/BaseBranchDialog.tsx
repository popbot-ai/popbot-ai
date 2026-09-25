import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitBaseBranches } from '@shared/git';
import type { HostRecord, RepoRecord } from '@shared/persistence';
import type { HostInfo } from '@shared/hostProtocol';
import { useTranslation } from '../lib/i18n';
import { P4Glyph } from './P4Glyph';
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
  /** Pre-derived branch / changelist name for flows that DON'T ask for a
   *  subject (ticket/PR), e.g. `bcooley/eng-204-…`. Shown — editable — so the
   *  user always sees the branch (git) or changelist (Perforce) name that will
   *  be created, and the (possibly edited) value comes back in `onConfirm`. */
  initialBranch?: string;
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
  /** Open Preferences at a section — offered when the Cloud chip is on
   *  but no Anthropic API key is set, so the fix is one click away. */
  onOpenPrefs?: (sectionId?: string) => void;
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
    /** The chat drives a Claude Code cloud session, whatever workspace
     *  it has: none (runs remotely), the repo root, or a slot / worktree
     *  whose branch is pushed for the cloud to clone. */
    cloud?: boolean;
    /** The chat runs on a host (Preferences ▸ Hosts): in one of its
     *  repositories — at the root, or in a worktree on `branch` forked
     *  from `baseBranch` — or in a scratch folder there. `repoId` is
     *  null then; nothing is made on this machine. */
    host?: { hostId: string; repoId: string | null; branch: string | null; baseBranch: string | null };
    agentConfig?: AgentCreateConfig;
  }) => void;
}

const LAST_REPO_SETTING = 'chatCreate.lastRepoId';
const LAST_AGENT_SETTING = 'chatCreate.lastAgentConfig';
/** The host the last chat was made on; empty for this computer. */
const LAST_HOST_SETTING = 'chatCreate.lastHostId';
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
  const { t } = useTranslation();
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
  const label = isFree ? t('branch.picker.freeChat') : (value || t('branch.picker.selectBase'));
  const q = query.trim().toLowerCase();
  const matchesQ = (b: string): boolean => !q || b.toLowerCase().includes(q);
  // Free-chat row haystack: its localized label + tag, plus the English
  // alias so the term works regardless of the active UI language.
  const freeChatHaystack =
    `${t('branch.picker.freeChat')} ${t('branch.picker.tagRepoRoot')} free chat repo root`.toLowerCase();
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
            placeholder={t('branch.picker.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="base-branch-list bb-picker-list">
            {branches.length === 0 && !allowRepoRoot && (
              <div style={{ padding: 8, color: 'var(--fg-3)', fontSize: 12 }}>{t('branch.picker.noBranches')}</div>
            )}
            {/* The two non-branch choices first, where they can't be missed. */}
            {allowRepoRoot && (!q || freeChatHaystack.includes(q)) && (
              <button
                type="button"
                className={`base-branch-row ${isFree ? 'selected' : ''}`}
                onClick={() => pick(freeChatValue)}
              >
                <span className="base-branch-name">{t('branch.picker.freeChat')}</span>
                <span className="base-branch-tag">{t('branch.picker.tagRepoRoot')}</span>
              </button>
            )}
            {allowRepoRoot && (shownRecents.length > 0 || others.length > 0) && <div className="base-branch-divider" />}
            {shownRecents.map((b) => (
              <button
                type="button"
                key={`recent-${b}`}
                className={`base-branch-row ${value === b ? 'selected' : ''}`}
                onClick={() => pick(b)}
              >
                <span className="base-branch-name">{b}</span>
                <span className="base-branch-tag">{t('branch.picker.tagRecent')}</span>
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
                {b === defaultBase && <span className="base-branch-tag">{t('branch.picker.tagDefault')}</span>}
              </button>
            ))}
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
  initialBranch,
  allowNoRepo,
  allowRepoRoot,
  showAgentPicker,
  onOpenPrefs,
  onCancel,
  onConfirm,
}: BaseBranchDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<RepoRecord[] | null>(null);
  const [pickedRepoId, setPickedRepoId] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBaseBranches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>(initial ?? '');
  const [recentBases, setRecentBases] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  // Editable branch / changelist name. Null = follow the derived value; once
  // the user types, their edit sticks. For Perforce this names the pending
  // changelist; for git it's the branch name.
  const [branchEdit, setBranchEdit] = useState<string | null>(null);
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
  // The name seed: derived-from-subject when we ask for one (generic flow),
  // else the caller's pre-derived ticket/PR branch.
  const seedBranch = askSubject ? derivedBranch : (initialBranch ?? '');
  // The branch / changelist name actually used: the user's edit if they typed
  // one, else the seed.
  const effectiveBranch = branchEdit && branchEdit.trim() ? branchEdit.trim() : seedBranch;
  // "Run on": this computer, or a host from Preferences ▸ Hosts. On a
  // host the workspace is one of ITS repositories — the root, or a
  // worktree on the chat's branch — or a scratch folder there; nothing
  // is made on this machine. Offered by the generic new-chat flow.
  const hostAllowed = showAgentPicker === true && allowNoRepo === true && !lockedRepoId;
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const host = hostAllowed ? hosts.find((h) => h.id === hostId) ?? null : null;
  const isHost = host !== null;
  const [hostInfo, setHostInfo] = useState<{ state: 'loading' | 'ok' | 'error'; info?: HostInfo; error?: string } | null>(null);
  const [hostRepoId, setHostRepoId] = useState<string | null>(null);
  const [hostBranches, setHostBranches] = useState<string[] | null>(null);
  const [hostBranchError, setHostBranchError] = useState<string | null>(null);
  const [hostPicked, setHostPicked] = useState<string>('');
  useEffect(() => {
    if (!hostAllowed) return;
    let cancelled = false;
    void (async () => {
      const [list, last] = await Promise.all([
        window.popbot.hosts.list(),
        window.popbot.settings.get<string>(LAST_HOST_SETTING),
      ]);
      if (cancelled) return;
      setHosts(list);
      if (last && list.some((h) => h.id === last)) setHostId(last);
    })();
    return () => { cancelled = true; };
  }, [hostAllowed]);
  // Ask the picked host what it has; start on its first repository.
  useEffect(() => {
    if (!host) {
      setHostInfo(null);
      setHostRepoId(null);
      return;
    }
    let cancelled = false;
    setHostInfo({ state: 'loading' });
    setHostRepoId(null);
    void window.popbot.hosts.probe(host.url, host.token).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setHostInfo({ state: 'error', error: r.error });
        return;
      }
      setHostInfo({ state: 'ok', info: r.info });
      setHostRepoId(r.info.repos[0]?.id ?? null);
    });
    return () => { cancelled = true; };
    // The host's id is what matters; its record does not change here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id]);
  const hostRepo = hostInfo?.info?.repos.find((r) => r.id === hostRepoId) ?? null;
  // Branches of the picked host repository: recents first, then the
  // repository's default, then main — as for a local repo.
  useEffect(() => {
    if (!host || !hostRepoId) {
      setHostBranches(null);
      setHostBranchError(null);
      setHostPicked('');
      return;
    }
    let cancelled = false;
    setHostBranches(null);
    setHostBranchError(null);
    void (async () => {
      const res = await window.popbot.hosts.branches(host.id, hostRepoId);
      if (cancelled) return;
      if (!res.ok) {
        setHostBranchError(res.error);
        return;
      }
      const stored = (await window.popbot.settings.get<string[]>(RECENT_BASE_BRANCHES_SETTING)) ?? [];
      if (cancelled) return;
      const recents = Array.isArray(stored) ? stored : [];
      setRecentBases(recents);
      setHostBranches(res.branches);
      const recent = recents.find((b) => res.branches.includes(b));
      const defaultBase = hostRepo?.defaultBase && res.branches.includes(hostRepo.defaultBase) ? hostRepo.defaultBase : '';
      setHostPicked(recent ?? (defaultBase || pickDefaultBase(null, res.branches, [])));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, hostRepoId]);
  // What still blocks Create on a host: its answer, then its branches.
  const hostNotReady = isHost && hostInfo?.state !== 'ok';
  const hostBranchesLoading = isHost && hostRepoId !== null && hostBranches === null && !hostBranchError;
  const hostNoBranchPicked = isHost && hostRepoId !== null && hostBranches !== null && !hostPicked;
  const hostBlocked = hostNotReady || hostBranchesLoading || hostNoBranchPicked || (isHost && !!hostBranchError);

  // On a host, "no repository" is its scratch folder.
  const isRawChat = isHost ? hostRepoId === null : (pickedRepoId === null && allowNoRepo === true);
  // "Free Chat (no slot)" radio is selected → run from the repo root with
  // no slot/worktree/branch (same as a CR chat).
  const isFreeChat = isHost
    ? hostRepoId !== null && hostPicked === FREE_CHAT_VALUE
    : !isRawChat && pickedRepoId !== null && allowRepoRoot === true && picked === FREE_CHAT_VALUE;
  // The Cloud toggle beside the agent picker: the chat drives a Claude
  // Code cloud session on top of whatever workspace is chosen here — no
  // repo (it just runs remotely), the repo root, or a slot / worktree
  // whose branch gets pushed for the cloud to clone. Offered by the
  // generic new-chat flow; Claude only (the toggle hides for Codex).
  const [cloud, setCloud] = useState(false);
  const cloudAllowed = allowRepoRoot === true && showAgentPicker === true && !isHost;
  const isCloud = cloudAllowed && cloud && agentConfig.agent !== 'codex';
  // Cloud chats run on an Anthropic API key; without one there is no
  // point creating the chat. Checked once the toggle is on.
  const [cloudKey, setCloudKey] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isCloud) return;
    let cancelled = false;
    void window.popbot.cloud.status().then((s) => { if (!cancelled) setCloudKey(s.apiKey !== null); });
    return () => { cancelled = true; };
  }, [isCloud]);
  const cloudNoKey = isCloud && cloudKey === false;
  // Pressing Create without a key is answered with an error, not a
  // greyed-out button: the reason and the way to fix it are spelled out.
  const [cloudError, setCloudError] = useState(false);
  useEffect(() => { if (!cloudNoKey) setCloudError(false); }, [cloudNoKey]);

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
    // Perforce has no branches — skip the fetch; the slot syncs to latest.
    if ((repos?.find((r) => r.id === pickedRepoId)?.scm ?? 'git') === 'perforce') {
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
    if (cloudNoKey) {
      setCloudError(true);
      return;
    }
    const chosenAgent = showAgentPicker ? compactAgentCreateConfig(agentConfig) : undefined;
    if (chosenAgent) void window.popbot.settings.set(LAST_AGENT_SETTING, chosenAgent);
    if (hostAllowed) void window.popbot.settings.set(LAST_HOST_SETTING, host?.id ?? '');
    if (isHost && host) {
      if (hostBlocked) return;
      const onBranch = hostRepoId !== null && !isFreeChat;
      if (onBranch && hostPicked) {
        const nextRecents = [hostPicked, ...recentBases.filter((b) => b !== hostPicked)].slice(0, 8);
        void window.popbot.settings.set(RECENT_BASE_BRANCHES_SETTING, nextRecents);
      }
      onConfirm({
        repoId: null,
        baseBranch: onBranch ? hostPicked : null,
        host: {
          hostId: host.id,
          repoId: hostRepoId,
          branch: onBranch && effectiveBranch ? effectiveBranch : null,
          baseBranch: onBranch ? hostPicked : null,
        },
        ...(askSubject ? { subject: effectiveSubject } : {}),
        ...(onBranch && effectiveBranch ? { branch: effectiveBranch } : {}),
        ...(chosenAgent ? { agentConfig: chosenAgent } : {}),
      });
      return;
    }
    if (isRawChat) {
      onConfirm({
        repoId: null,
        baseBranch: null,
        ...(isCloud ? { cloud: true } : {}),
        ...(askSubject ? { subject: effectiveSubject } : {}),
        ...(chosenAgent ? { agentConfig: chosenAgent } : {}),
      });
      return;
    }
    if (!pickedRepoId) return;
    if (!isFreeChat && !isPerforce && !picked) return;
    if (!lockedRepoId) void window.popbot.settings.set(LAST_REPO_SETTING, pickedRepoId);
    // Remember the picked base branch so it surfaces at the top of the
    // picker next time (most-recent first, capped). Perforce has no pick.
    if (!isFreeChat && !isPerforce && picked) {
      const nextRecents = [picked, ...recentBases.filter((b) => b !== picked)].slice(0, 8);
      void window.popbot.settings.set(RECENT_BASE_BRANCHES_SETTING, nextRecents);
    }
    onConfirm({
      repoId: pickedRepoId,
      // Perforce slots sync to latest — there's no base branch to fork from.
      baseBranch: isFreeChat ? null : isPerforce ? 'latest' : picked,
      workspaceMode: isFreeChat ? 'repo-root' : 'slot',
      ...(isCloud ? { cloud: true } : {}),
      ...(askSubject ? { subject: effectiveSubject } : {}),
      // Return the (possibly edited) branch/changelist name for any slot chat,
      // so a ticket/PR flow uses what the user saw + tweaked, not its own.
      ...(!isFreeChat && effectiveBranch ? { branch: effectiveBranch } : {}),
      ...(chosenAgent ? { agentConfig: chosenAgent } : {}),
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
      // `picked` is FREE_CHAT_VALUE (truthy) when the free-chat radio is
      // selected, so the slot-branch condition already covers that case.
      else if (e.key === 'Enter' && (isHost ? !hostBlocked : (isRawChat || ((picked || isPerforce) && pickedRepoId)))) submit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // submit closes over current state via the live binding below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, onConfirm, picked, pickedRepoId, derivedBranch, subject, isRawChat, isFreeChat, isCloud, isHost, hostBlocked, hostRepoId, hostPicked]);

  const currentRepo = repos?.find((r) => r.id === pickedRepoId) ?? null;
  const isPerforce = !isHost && (currentRepo?.scm ?? 'git') === 'perforce';
  const allBranches = branches?.branches ?? [];

  // The subject is never blocking now — it falls back to a generated
  // default. A git slot chat still needs a repo + a base branch picked;
  // Perforce has no branches (the slot syncs to latest), so those gates
  // don't apply.
  const noRepo = !isHost && !isRawChat && !pickedRepoId;
  const noBranches = !isHost && !isRawChat && !isFreeChat && !isPerforce && branches != null && allBranches.length === 0;
  const noBranchPicked = !isHost && !isRawChat && !isFreeChat && !isPerforce && !noBranches && !picked;
  const branchesLoading = !isHost && !isRawChat && !isFreeChat && !isPerforce && branches == null && !error;
  const confirmDisabled = noRepo || noBranches || noBranchPicked || branchesLoading || hostBlocked;
  // Plain-language reason shown beside a disabled Create button.
  const disabledReason = noRepo ? t('branch.dialog.disabled.pickRepo')
    : hostNotReady
      ? (hostInfo?.state === 'error'
        ? t('branch.dialog.hostUnreachable', { host: host?.name ?? '', error: hostInfo.error ?? '' })
        : t('branch.dialog.disabled.host', { host: host?.name ?? '' }))
      : (branchesLoading || hostBranchesLoading) ? t('branch.dialog.disabled.loadingBranches')
        : (noBranches || (isHost && !!hostBranchError)) ? t('branch.dialog.disabled.noBranches')
          : (noBranchPicked || hostNoBranchPicked) ? t('branch.dialog.disabled.pickBranch')
            : '';

  return createPortal(
    <div className="confirm-scrim" onMouseDown={onCancel}>
      <div
        className="confirm-dialog base-branch-dialog"
        role="dialog"
        aria-label={t('branch.dialog.ariaLabel')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">{t('branch.dialog.title')}</div>
        {subtitle && !askSubject && <div className="base-branch-subtitle">{subtitle}</div>}
        <div className="confirm-body">
          {showAgentPicker && (
            <>
              {/* Where the agent runs. Only shown once a host exists. */}
              {hostAllowed && hosts.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>{t('agent.runOn')}</div>
                  <select
                    className="pref-select"
                    aria-label={t('agent.runOn')}
                    value={host?.id ?? ''}
                    onChange={(e) => setHostId(e.currentTarget.value || null)}
                  >
                    <option value="">{t('agent.runOnLocal')}</option>
                    {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </select>
                </div>
              )}
              <AgentCreateControls
                value={agentConfig}
                onChange={(next) => setAgentConfig(compactAgentCreateConfig(next))}
                {...(cloudAllowed ? { cloud: { value: cloud, onChange: setCloud } } : {})}
              />
            </>
          )}
          {askSubject && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>{t('branch.dialog.subjectLabel')} <span style={{ opacity: 0.7 }}>{t('branch.dialog.subjectOptional')}</span></div>
              <input
                className="pref-input mono narrow"
                placeholder={defaultSubject}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={{ width: '100%' }}
                autoFocus
              />
            </div>
          )}
          {/* Always show the branch (git) / changelist (Perforce) name that
              will be created — derived from the subject above, or the ticket/PR
              branch — and let the user edit it. */}
          {!isRawChat && !isFreeChat && (askSubject || initialBranch) && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>
                {isPerforce ? t('branch.dialog.changelistName') : t('branch.dialog.branchName')}
              </div>
              <input
                className="pref-input mono narrow"
                value={effectiveBranch}
                onChange={(e) => setBranchEdit(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
          )}
          {isHost && host && (
            <>
              {hostInfo?.state === 'loading' && <div>{t('branch.dialog.hostLoading', { host: host.name })}</div>}
              {hostInfo?.state === 'error' && (
                <div className="diff-overlay-status error">
                  {t('branch.dialog.hostUnreachable', { host: host.name, error: hostInfo.error ?? '' })}
                </div>
              )}
              {hostInfo?.state === 'ok' && hostInfo.info && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>{t('branch.dialog.hostRepoLabel', { host: host.name })}</div>
                    <div className="base-branch-list">
                      <label className={`base-branch-row ${hostRepoId === null ? 'selected' : ''}`}>
                        <input
                          type="radio"
                          name="picked-host-repo"
                          value="__none__"
                          checked={hostRepoId === null}
                          onChange={() => setHostRepoId(null)}
                        />
                        <span className="base-branch-name mono">{t('branch.dialog.noRepoOption')}</span>
                        <span className="base-branch-tag">{t('branch.dialog.tagHostScratch')}</span>
                      </label>
                      {hostInfo.info.repos.map((r) => (
                        <label key={r.id} className={`base-branch-row ${hostRepoId === r.id ? 'selected' : ''}`}>
                          <input
                            type="radio"
                            name="picked-host-repo"
                            value={r.id}
                            checked={hostRepoId === r.id}
                            onChange={() => setHostRepoId(r.id)}
                          />
                          <span className="base-branch-name mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <i className="fa-solid fa-code-branch" style={{ color: 'var(--scm-git)' }} />
                            {r.id}
                          </span>
                          <span className="base-branch-tag" title={r.path}>{r.path}</span>
                        </label>
                      ))}
                    </div>
                    {hostInfo.info.repos.length === 0 && (
                      <div style={{ color: 'var(--fg-2)', fontSize: 12, marginTop: 6 }}>{t('branch.dialog.hostNoRepos', { host: host.name })}</div>
                    )}
                  </div>
                  {hostRepoId === null ? (
                    <div style={{ color: 'var(--fg-2)', fontSize: 12 }}>{t('branch.dialog.hostDescScratch', { host: host.name })}</div>
                  ) : (
                    <>
                      <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>{t('branch.dialog.baseBranchLabel')}</div>
                      <div style={{ minHeight: 34, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                        {!hostBranches && !hostBranchError && <div>{t('branch.dialog.disabled.loadingBranches')}</div>}
                        {hostBranchError && <div className="diff-overlay-status error">{t('branch.dialog.loadBranchesError', { error: hostBranchError })}</div>}
                        {hostBranches && (
                          <BaseBranchPicker
                            branches={hostBranches}
                            recents={recentBases}
                            value={hostPicked}
                            onChange={setHostPicked}
                            defaultBase={hostRepo?.defaultBase}
                            allowRepoRoot
                            freeChatValue={FREE_CHAT_VALUE}
                          />
                        )}
                      </div>
                      <div style={{ color: 'var(--fg-2)', fontSize: 12, marginTop: 8 }}>
                        {isFreeChat
                          ? t('branch.dialog.hostDescRoot', { host: host.name, repo: hostRepoId ?? '' })
                          : t('branch.dialog.hostDescSlot', { host: host.name, repo: hostRepoId ?? '' })}
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}
          {!isHost && !repos && <div>{t('branch.dialog.loadingRepos')}</div>}
          {!isHost && repos && repos.length === 0 && !allowNoRepo && (
            <div className="diff-overlay-status error">
              {t('branch.dialog.noReposConfigured')}
            </div>
          )}
          {!isHost && repos && (repos.length > 0 || allowNoRepo) && (
            <>
              {/* Show the repo selector whenever there's a repo to pick — even a
                  single one. Hiding it for exactly one repo (the old `> 1`)
                  auto-selected behind the scenes but rendered an empty-looking
                  step; a pre-selected 1-item list reads clearly. */}
              {!lockedRepoId && (repos.length >= 1 || allowNoRepo) && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>{t('branch.dialog.repoLabel')}</div>
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
                        <span className="base-branch-name mono">{t('branch.dialog.noRepoOption')}</span>
                        <span className="base-branch-tag">{t('branch.dialog.tagRawChat')}</span>
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
                          style={{ borderLeft: `3px solid ${r.color}`, paddingLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                        >
                          {(r.scm ?? 'git') === 'perforce' ? (
                            <P4Glyph style={{ color: 'var(--scm-perforce)' }} />
                          ) : (
                            <i className="fa-solid fa-code-branch" style={{ color: 'var(--scm-git)' }} />
                          )}
                          {r.id}
                        </span>
                        <span className="base-branch-tag">
                          {r.mode === 'ephemeral'
                            ? t('branch.dialog.tagEphemeral')
                            : t('branch.dialog.tagSlots', { count: r.slotCount })}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {isRawChat ? (
                <div style={{ color: 'var(--fg-2)', fontSize: 12 }}>
                  {t('branch.dialog.rawChatDesc')}
                </div>
              ) : isPerforce ? (
                <div style={{ color: 'var(--fg-2)', fontSize: 12 }}>
                  {t('branch.dialog.perforceLatest')}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>{t('branch.dialog.baseBranchLabel')}</div>
                  {/* Reserve the picker-trigger height (~33px) so swapping
                      between the "loading branches" line and the dropdown
                      doesn't resize the dialog. */}
                  <div style={{ minHeight: 34, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    {!branches && !error && <div>{t('branch.dialog.disabled.loadingBranches')}</div>}
                    {error && <div className="diff-overlay-status error">{t('branch.dialog.loadBranchesError', { error })}</div>}
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
                  </div>
                  {isFreeChat && (
                    <div style={{ color: 'var(--fg-2)', fontSize: 12, marginTop: 8 }}>
                      {t('branch.dialog.freeChatDesc', { repo: pickedRepoId ?? '' })}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
        {isCloud && (
          <div className="cloud-note">
            <i className="fa-solid fa-cloud" aria-hidden />
            <span>
              {isRawChat
                ? t('branch.dialog.cloudDescNoRepo')
                : isFreeChat
                  ? t('branch.dialog.cloudDescRoot', { repo: pickedRepoId ?? '' })
                  : t('branch.dialog.cloudDescSlot', { repo: pickedRepoId ?? '' })}
              {!isRawChat && <>{' '}{t('branch.dialog.cloudGithubNote')}</>}
              {cloudNoKey && (
                <>
                  {' '}<strong>{t('branch.dialog.cloudNoKey')}</strong>
                  {onOpenPrefs && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => { onOpenPrefs('agents'); onCancel(); }}
                      >
                        {t('app.noSlots.openPreferences')}
                      </button>
                    </>
                  )}
                </>
              )}
            </span>
          </div>
        )}
        <div className="confirm-foot">
          {confirmDisabled && disabledReason && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', marginRight: 'auto' }}>{disabledReason}</span>
          )}
          {cloudError && (
            <span style={{ fontSize: 11.5, color: '#e89696', marginRight: 'auto' }}>
              <i className="fa-solid fa-circle-exclamation" aria-hidden style={{ marginRight: 5 }} />
              {t('branch.dialog.cloudNoKey')}
              {onOpenPrefs && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => { onOpenPrefs('agents'); onCancel(); }}
                  >
                    {t('app.noSlots.openPreferences')}
                  </button>
                </>
              )}
            </span>
          )}
          <button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={confirmDisabled}
            title={confirmDisabled ? disabledReason : undefined}
            autoFocus={!askSubject}
          >
            {t('branch.dialog.createChat')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { useEffect, useState } from 'react';
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

/** Sentinel `picked` value for the "Free Chat (no slot)" radio at the
 *  bottom of the branch list. Selecting it creates a slot-less chat that
 *  runs from the repo root (same as a CR chat) — no worktree, no branch —
 *  so the agent can talk about the project against the live checkout. */
const FREE_CHAT_VALUE = '__free_no_slot__';

/** Picks the best base-branch default for a freshly-loaded repo:
 *   1. The repo's `defaultBase`, if it appears in the live list.
 *   2. `develop`, if present.
 *   3. The first release-candidate branch.
 *  Returns empty string when nothing is available — caller blocks
 *  the confirm button on that case. */
function pickDefaultBase(repo: RepoRecord | null, branches: GitBaseBranches | null, lastUsed?: string): string {
  if (!branches) return lastUsed ?? '';
  const choices = (branches.hasDevelop ? ['develop'] : []).concat(branches.releaseCandidates);
  if (lastUsed && choices.includes(lastUsed)) return lastUsed;
  if (repo?.defaultBase && choices.includes(repo.defaultBase)) return repo.defaultBase;
  if (branches.hasDevelop) return 'develop';
  return choices[0] ?? '';
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
  const [subject, setSubject] = useState('');
  const [username, setUsername] = useState<string>('pop');
  const [agentConfig, setAgentConfig] = useState<AgentCreateConfig>(DEFAULT_AGENT_CREATE_CONFIG);

  // Pull the configured git username so the derived-branch preview
  // matches what `ticketBranch` would have produced for a real ticket.
  // Falls back to 'pop' when not configured.
  useEffect(() => {
    if (!askSubject) return;
    void window.popbot.settings.get<{ username?: string }>('git').then((g) => {
      if (g?.username?.trim()) setUsername(g.username.trim());
    });
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

  const derivedSlug = slugifySubject(subject);
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
    void window.popbot.git.listBaseBranches({ repoId: pickedRepoId }).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setBranches(res.branches);
        const repo = repos?.find((r) => r.id === pickedRepoId) ?? null;
        const next = pickDefaultBase(repo, res.branches, initial);
        if (next) setPicked(next);
      } else {
        setError(res.reason);
      }
    });
    return () => { cancelled = true; };
    // `initial` only seeds on first paint per branch list — once the
    // user explicitly picks something we don't want to keep clobbering it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedRepoId, repos]);

  const submit = (): void => {
    const chosenAgent = showAgentPicker ? compactAgentCreateConfig(agentConfig) : undefined;
    if (chosenAgent) void window.popbot.settings.set(LAST_AGENT_SETTING, chosenAgent);
    if (isRawChat) {
      if (askSubject && !subject.trim()) return;
      onConfirm({
        repoId: null,
        baseBranch: null,
        ...(askSubject ? { subject: subject.trim() } : {}),
        ...(chosenAgent ? { agentConfig: chosenAgent } : {}),
      });
      return;
    }
    if (!pickedRepoId) return;
    if (askSubject && !subject.trim()) return;
    if (!isFreeChat && !picked) return;
    if (!isFreeChat && askSubject && !derivedBranch) return;
    if (!lockedRepoId) void window.popbot.settings.set(LAST_REPO_SETTING, pickedRepoId);
    onConfirm({
      repoId: pickedRepoId,
      baseBranch: isFreeChat ? null : picked,
      workspaceMode: isFreeChat ? 'repo-root' : 'slot',
      ...(askSubject
        ? {
            subject: subject.trim(),
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

  const choices: string[] = branches
    ? (branches.hasDevelop ? ['develop'] : []).concat(branches.releaseCandidates)
    : [];

  // Free chat needs only a repo (+ subject); a slot chat additionally needs
  // a base branch picked and a derivable branch name.
  const subjectMissing = askSubject && !subject.trim();
  const branchInvalid =
    !isRawChat && !isFreeChat
    && (!picked || choices.length === 0 || (askSubject && !derivedBranch));
  const confirmDisabled =
    subjectMissing || (!isRawChat && !pickedRepoId) || branchInvalid;

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
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 }}>Subject</div>
              <input
                className="pref-input mono narrow"
                placeholder="What's this chat about?"
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
                  {branches && choices.length === 0 && !allowRepoRoot && (
                    <div>No base branches found in this repo.</div>
                  )}
                  {(choices.length > 0 || allowRepoRoot) && (
                    <div className="base-branch-list">
                      {choices.map((b) => (
                        <label key={b} className={`base-branch-row ${picked === b ? 'selected' : ''}`}>
                          <input
                            type="radio"
                            name="base-branch"
                            value={b}
                            checked={picked === b}
                            onChange={() => setPicked(b)}
                          />
                          <span className="base-branch-name">{b}</span>
                          {b === 'develop' && <span className="base-branch-tag">default</span>}
                        </label>
                      ))}
                      {/* Free Chat sits at the bottom of the branch list: no
                          slot, no worktree, no branch — runs from the repo
                          root like a CR chat so project Q&A can proceed. */}
                      {allowRepoRoot && (
                        <label className={`base-branch-row ${isFreeChat ? 'selected' : ''}`}>
                          <input
                            type="radio"
                            name="base-branch"
                            value={FREE_CHAT_VALUE}
                            checked={isFreeChat}
                            onChange={() => setPicked(FREE_CHAT_VALUE)}
                          />
                          <span className="base-branch-name">Free Chat (no slot)</span>
                          <span className="base-branch-tag">repo root</span>
                        </label>
                      )}
                    </div>
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
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={confirmDisabled}
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

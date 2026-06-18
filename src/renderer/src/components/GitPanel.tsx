import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  GitFileChange,
  GitFileStatus,
  GitPrInfo,
  GitScope,
  GitStatusResult,
} from '@shared/git';
import { useGitStatus } from '../lib/useGitStatus';
import { ConfirmDialog } from './ConfirmDialog';
import { BaseBranchDialog } from './BaseBranchDialog';
import {
  DEFAULT_ADDRESS_CR_TEMPLATE,
  DEFAULT_COMMIT_AI_TEMPLATE,
  DEFAULT_MAKE_PR_READY_TEMPLATE,
  DEFAULT_PUSH_DRAFT_PR_TEMPLATE,
  DEFAULT_PUSH_PR_TEMPLATE,
  DEFAULT_REBASE_BASE_TEMPLATE,
  expandTemplate,
} from '../lib/templates';

interface GitPanelProps {
  /** Chat whose worktree drives this panel; null hides the contents. */
  chatId: string | null;
  /** Display name for the empty state (e.g. when no chat is focused). */
  chatName?: string;
  /** Linear ticket id for prompt template substitution (may be null). */
  chatTicket?: string | null;
  /** Slot number, surfaced as `${slot}` in templates. */
  chatSlot?: number | null;
  /** Repo this chat lives in — locks the BaseBranchDialog to it so the
   *  rebase-base picker can't accidentally suggest a branch from a
   *  different clone. */
  chatRepoId?: string | null;
  onClose: () => void;
  /** Path of the file currently shown in the persistent diff overlay. */
  diffPath: string | null;
  /** Open or refresh the diff overlay with a new file. */
  onOpenDiff: (scope: GitScope, path: string) => void;
  /** Close the diff overlay (used when scope changes / panel closes). */
  onCloseDiff: () => void;
}

interface StatusMeta {
  icon: string;
  color: string;
  abbr: string;
  label: string;
}
const STATUS_META: Record<GitFileStatus, StatusMeta> = {
  modified:  { icon: 'fa-pen',                  color: '#4f8bff', abbr: 'M', label: 'Modified' },
  added:     { icon: 'fa-plus',                 color: '#3fb27f', abbr: 'A', label: 'Added' },
  deleted:   { icon: 'fa-trash',                color: '#dc5858', abbr: 'D', label: 'Deleted' },
  renamed:   { icon: 'fa-right-left',           color: '#d6a13b', abbr: 'R', label: 'Renamed' },
  untracked: { icon: 'fa-circle-plus',          color: '#3fb27f', abbr: '?', label: 'Untracked' },
  conflict:  { icon: 'fa-triangle-exclamation', color: '#dc5858', abbr: 'C', label: 'Conflict' },
};

interface ContextMenu {
  x: number;
  y: number;
  paths: string[];
}

function relTime(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

type Mode = 'commit' | 'commitAi' | 'pushPr' | 'pushDraftPr' | 'makePrReady' | 'addressCr';

interface ModeMeta {
  /** Big-button label. */
  label: string;
  /** Small-pill label (the mode picker row). */
  short: string;
  icon: string;
  /** True when clicking the action sends a templated prompt to the
   *  agent. False = manual git op (only plain commit). */
  isAi: boolean;
  /** What mode to flip to after a successful action. */
  next: Mode;
}

const MODE_META: Record<Mode, ModeMeta> = {
  commit:      { label: 'COMMIT',             short: 'COMMIT',      icon: 'fa-check',             isAi: false, next: 'commit' },
  commitAi:    { label: 'COMMIT (AI)',        short: 'COMMIT (AI)', icon: 'fa-wand-magic-sparkles', isAi: true,  next: 'commitAi' },
  pushPr:      { label: 'PUSH PR (AI)',       short: 'PUSH PR (AI)', icon: 'fa-code-pull-request', isAi: true,  next: 'addressCr' },
  pushDraftPr: { label: 'PUSH DRAFT PR (AI)', short: 'DRAFT (AI)',  icon: 'fa-code-pull-request', isAi: true,  next: 'makePrReady' },
  makePrReady: { label: 'MARK PR READY (AI)', short: 'READY (AI)',  icon: 'fa-circle-check',      isAi: true,  next: 'addressCr' },
  addressCr:   { label: 'ADDRESS CR (AI)',    short: 'CR (AI)',     icon: 'fa-comments',          isAi: true,  next: 'addressCr' },
};

/** Default mode based on PR state. */
function modeForPr(pr: GitPrInfo | null): Mode {
  if (!pr) return 'pushPr';
  if (pr.state !== 'OPEN') return 'pushPr';
  return pr.isDraft ? 'makePrReady' : 'addressCr';
}

interface TemplatesBlob {
  commitAi?: string;
  pushPr?: string;
  pushDraftPr?: string;
  makePrReady?: string;
  addressCr?: string;
  rebaseBase?: string;
}

const TEMPLATE_FOR_MODE: Record<Exclude<Mode, 'commit'>, { key: keyof TemplatesBlob; fallback: string }> = {
  commitAi:    { key: 'commitAi',    fallback: DEFAULT_COMMIT_AI_TEMPLATE },
  pushPr:      { key: 'pushPr',      fallback: DEFAULT_PUSH_PR_TEMPLATE },
  pushDraftPr: { key: 'pushDraftPr', fallback: DEFAULT_PUSH_DRAFT_PR_TEMPLATE },
  makePrReady: { key: 'makePrReady', fallback: DEFAULT_MAKE_PR_READY_TEMPLATE },
  addressCr:   { key: 'addressCr',   fallback: DEFAULT_ADDRESS_CR_TEMPLATE },
};

export function GitPanel({
  chatId,
  chatName,
  chatTicket,
  chatSlot,
  chatRepoId,
  onClose,
  diffPath,
  onOpenDiff,
  onCloseDiff,
}: GitPanelProps): JSX.Element {
  const [scope, setScope] = useState<GitScope>({ kind: 'wip' });
  const { data, refresh } = useGitStatus(chatId);

  const [historyFiles, setHistoryFiles] = useState<GitFileChange[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const [commitMsg, setCommitMsg] = useState('');
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [confirm, setConfirm] = useState<{ paths: string[] } | null>(null);

  // Action mode + supporting state. Mode auto-advances after success;
  // user can override via the mode-pill row above the action button.
  const [mode, setMode] = useState<Mode>('commit');
  const [baseBranch, setBaseBranch] = useState<string>('develop');
  const [pr, setPr] = useState<GitPrInfo | null>(null);
  const [pickingBranch, setPickingBranch] = useState(false);

  // Load base branch + PR info when chat changes; seed mode from PR.
  useEffect(() => {
    if (!chatId) {
      setBaseBranch('develop');
      setPr(null);
      setMode('commit');
      return;
    }
    let cancelled = false;
    void window.popbot.settings.get<Record<string, string>>('git.baseBranchByChat').then((blob) => {
      if (cancelled) return;
      setBaseBranch(blob?.[chatId]?.trim() || 'develop');
    });
    void window.popbot.git.detectPr(chatId).then((res) => {
      if (cancelled) return;
      const detected = res.ok ? res.pr : null;
      setPr(detected);
      setMode(modeForPr(detected));
    });
    return () => { cancelled = true; };
  }, [chatId]);

  // Pixel-based section heights. During drag we mutate `style.flexBasis`
  // on the section refs directly to avoid a React re-render per pixel
  // (the file list / commits list re-renders cascade); state is only
  // committed on mouseup.
  const [commitsPx, setCommitsPx] = useState(96);
  // Footer needs room for: base-branch row, mode pills, textarea (with
  // the prompt preview which can be 6-10 lines), big action button.
  const [commitFootPx, setCommitFootPx] = useState(240);
  const commitsRef = useRef<HTMLDivElement | null>(null);
  const commitFootRef = useRef<HTMLDivElement | null>(null);

  // Reset everything when the focused chat changes.
  useEffect(() => {
    setScope({ kind: 'wip' });
    setHistoryFiles(null);
    setChecked(new Set());
    setSelected(new Set());
    setAnchor(null);
    setCommitMsg('');
    onCloseDiff();
    // onCloseDiff is stable enough — ignoring to avoid loop on every parent render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Switching scope invalidates whatever file the diff was showing.
  useEffect(() => {
    onCloseDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.kind, scope.kind === 'commit' ? scope.sha : '']);

  // Load file list for the selected commit.
  useEffect(() => {
    if (!chatId || scope.kind === 'wip') {
      setHistoryFiles(null);
      setHistoryError(null);
      return;
    }
    let cancelled = false;
    void window.popbot.git.filesInCommit({ chatId, sha: scope.sha }).then((res) => {
      if (cancelled) return;
      if (res.ok) { setHistoryFiles(res.files); setHistoryError(null); }
      else { setHistoryFiles([]); setHistoryError(res.error); }
    });
    return () => { cancelled = true; };
  }, [chatId, scope]);

  const wipFiles = useMemo(() => (data?.ok ? data.files : []), [data]);
  // Drop dangling paths after a successful commit so we don't keep
  // ghost selections / checks around.
  useEffect(() => {
    if (scope.kind !== 'wip') return;
    const present = new Set(wipFiles.map((f) => f.path));
    setChecked((s) => filterSet(s, present));
    setSelected((s) => filterSet(s, present));
  }, [wipFiles, scope.kind]);

  // Close any open context menu on outside click / scroll.
  useEffect(() => {
    if (!menu) return;
    const onAny = (): void => setMenu(null);
    document.addEventListener('mousedown', onAny);
    document.addEventListener('scroll', onAny, true);
    return () => {
      document.removeEventListener('mousedown', onAny);
      document.removeEventListener('scroll', onAny, true);
    };
  }, [menu]);

  // Vertical splitter drag — writes flexBasis directly to the target
  // ref on every move (no React render), commits to state on mouseup.
  // `direction='down'` means dragging down grows the tracked section.
  const startVerticalDrag = (
    current: number,
    setter: (n: number) => void,
    target: React.RefObject<HTMLDivElement>,
    direction: 'down' | 'up',
    minPx = 48,
    maxPx = 800,
  ) => (e: React.MouseEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startVal = current;
    let last = startVal;
    const move = (ev: MouseEvent): void => {
      const dy = ev.clientY - startY;
      const delta = direction === 'down' ? dy : -dy;
      last = clamp(startVal + delta, minPx, maxPx);
      const node = target.current;
      if (node) node.style.flexBasis = `${last}px`;
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setter(last);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const isWip = scope.kind === 'wip';
  const files: GitFileChange[] = isWip ? wipFiles : (historyFiles ?? []);
  const allChecked = files.length > 0 && files.every((f) => checked.has(f.path));
  const anyChecked = files.some((f) => checked.has(f.path));

  const updateSelection = (path: string, ev: React.MouseEvent): void => {
    if (ev.shiftKey && anchor) {
      const a = files.findIndex((f) => f.path === anchor);
      const b = files.findIndex((f) => f.path === path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(files.slice(lo, hi + 1).map((f) => f.path)));
        return;
      }
    }
    if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(selected);
      if (next.has(path)) next.delete(path); else next.add(path);
      setSelected(next);
      setAnchor(path);
      return;
    }
    setSelected(new Set([path]));
    setAnchor(path);
  };

  const handleRowClick = (file: GitFileChange, ev: React.MouseEvent): void => {
    updateSelection(file.path, ev);
    if (!ev.metaKey && !ev.ctrlKey && !ev.shiftKey) onOpenDiff(scope, file.path);
  };

  const toggleChecked = (path: string): void => {
    const next = new Set(checked);
    if (next.has(path)) next.delete(path); else next.add(path);
    setChecked(next);
  };

  const toggleAllChecked = (): void => {
    if (allChecked) setChecked(new Set());
    else setChecked(new Set(files.map((f) => f.path)));
  };

  const onContextMenu = (file: GitFileChange, ev: React.MouseEvent): void => {
    ev.preventDefault();
    let paths: string[];
    if (selected.has(file.path)) {
      paths = [...selected];
    } else {
      paths = [file.path];
      setSelected(new Set(paths));
      setAnchor(file.path);
    }
    setMenu({ x: ev.clientX, y: ev.clientY, paths });
  };

  const askRevert = (paths: string[]): void => {
    setMenu(null);
    if (paths.length === 0) return;
    setConfirm({ paths });
  };

  const doRevert = async (paths: string[]): Promise<void> => {
    setConfirm(null);
    if (!chatId) return;
    const res = await window.popbot.git.revert({ chatId, paths });
    if (!res.ok) {
      // eslint-disable-next-line no-alert
      alert(`Revert failed:\n\n${res.error}`);
    }
    setSelected(new Set());
    refresh();
  };

  const doCommit = async (): Promise<void> => {
    if (!chatId) return;
    const paths = [...checked];
    if (paths.length === 0 || !commitMsg.trim()) return;
    const res = await window.popbot.git.commit({ chatId, message: commitMsg, paths });
    if (!res.ok) {
      // eslint-disable-next-line no-alert
      alert(`Commit failed:\n\n${res.error}`);
      return;
    }
    setCommitMsg('');
    setChecked(new Set());
    setSelected(new Set());
    refresh();
  };

  const status: GitStatusResult | null = data?.ok ? data : null;
  const commitsHeight = clamp(commitsPx, 48, 600);
  const footerHeight = isWip ? clamp(commitFootPx, 60, 600) : 0;
  const branchName = status?.branch ?? '';

  /** Build the substitution map for git-action templates. */
  const promptVars = (): Record<string, unknown> => ({
    branch: branchName,
    baseBranch,
    ticket: chatTicket ?? '',
    slot: chatSlot ?? '',
    prnum: pr?.number ?? '',
    prurl: pr?.url ?? '',
  });

  /** Render the active mode's prompt against the user's templates
   *  (or the bundled defaults). Returns null for COMMIT mode. */
  const buildModePrompt = async (m: Mode): Promise<string | null> => {
    if (m === 'commit') return null;
    const cfg = TEMPLATE_FOR_MODE[m];
    const blob = await window.popbot.settings.get<TemplatesBlob>('templates');
    const tmpl = (blob?.[cfg.key] ?? cfg.fallback).trim();
    return expandTemplate(tmpl, promptVars());
  };

  /** Run the active mode. For COMMIT, commits checked files. For AI
   *  modes, sends the rendered template to the chat as a user message
   *  and auto-advances to the next mode. */
  const runAction = async (): Promise<void> => {
    if (!chatId) return;
    if (mode === 'commit') {
      await doCommit();
      return;
    }
    const text = await buildModePrompt(mode);
    if (!text) return;
    try {
      await window.popbot.agent.send({ chatId, text });
      setMode(MODE_META[mode].next);
      // PR detection may have changed (new PR pushed, draft → ready,
      // etc.). Refresh after a short delay so the AI has a moment.
      setTimeout(() => {
        if (!chatId) return;
        void window.popbot.git.detectPr(chatId).then((res) => {
          if (res.ok) setPr(res.pr);
        });
      }, 8000);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Couldn't send prompt:\n\n${(err as Error).message}`);
    }
  };

  /** Persist + apply a base-branch change. Triggers an AI rebase
   *  prompt when the branch actually changed. */
  const onPickBaseBranch = async (next: string): Promise<void> => {
    setPickingBranch(false);
    if (!chatId || !next || next === baseBranch) return;
    const oldBase = baseBranch;
    setBaseBranch(next);
    const blob = (await window.popbot.settings.get<Record<string, string>>('git.baseBranchByChat')) ?? {};
    blob[chatId] = next;
    await window.popbot.settings.set('git.baseBranchByChat', blob);
    // Build + send the rebase prompt.
    const tBlob = await window.popbot.settings.get<TemplatesBlob>('templates');
    const tmpl = (tBlob?.rebaseBase ?? DEFAULT_REBASE_BASE_TEMPLATE).trim();
    const text = expandTemplate(tmpl, { ...promptVars(), oldBase });
    try { await window.popbot.agent.send({ chatId, text }); }
    catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Couldn't send rebase prompt:\n\n${(err as Error).message}`);
    }
  };

  // Live-rendered prompt preview for the textarea (AI modes only).
  const [previewText, setPreviewText] = useState('');
  useEffect(() => {
    if (mode === 'commit') { setPreviewText(''); return; }
    let cancelled = false;
    void buildModePrompt(mode).then((t) => { if (!cancelled && t != null) setPreviewText(t); });
    return () => { cancelled = true; };
    // The vars used inside buildModePrompt are static refs to current
    // closure state — listing them all would re-render on every poll
    // without changing output meaningfully. Recompute when the inputs
    // that actually matter shift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, chatId, baseBranch, pr?.number, branchName]);

  return (
    <div className="git-panel" data-screen-label="Git Panel">
      <div className="git-panel-head">
        <div className="git-panel-title">
          <i className="fa-solid fa-code-branch" />
          <span className="git-branch" title={status?.branch ?? ''}>
            {status?.branch ?? (chatId ? '—' : 'No chat focused')}
          </span>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="git-ab">
              {status.ahead > 0 && <span title="Ahead"><i className="fa-solid fa-arrow-up" />{status.ahead}</span>}
              {status.behind > 0 && <span title="Behind"><i className="fa-solid fa-arrow-down" />{status.behind}</span>}
            </span>
          )}
        </div>
        <div className="git-panel-actions">
          <button
            className="iconbtn"
            title="Refresh"
            onClick={refresh}
            disabled={!chatId}
          >
            <i className="fa-solid fa-arrows-rotate" />
          </button>
          <button className="iconbtn" title="Close panel" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
      </div>

      {!chatId && (
        <div className="git-panel-empty">Focus a chat to see its git status.</div>
      )}

      {chatId && data && !data.ok && (
        <div className="git-panel-empty">
          {data.reason === 'no-worktree'
            ? 'This chat has no slot worktree yet.'
            : `Not a git repo: ${data.error ?? ''}`}
        </div>
      )}

      {chatId && (
        <div className="git-panel-body">
          {/* Commits list — fixed pixel height, drag to resize. */}
          <div
            ref={commitsRef}
            className="git-commits"
            style={{ flex: `0 0 ${commitsHeight}px` }}
          >
            <div
              className={`git-commit-row ${isWip ? 'active' : ''}`}
              onClick={() => setScope({ kind: 'wip' })}
            >
              <i className="fa-regular fa-pen-to-square git-commit-icon" />
              <span className="git-commit-subject">Uncommitted changes</span>
              {status && (
                <span className="git-commit-meta">
                  {status.files.length} file{status.files.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {(status?.recentCommits ?? []).map((c) => (
              <div
                key={c.sha}
                className={`git-commit-row ${!isWip && scope.sha === c.sha ? 'active' : ''}`}
                onClick={() => setScope({ kind: 'commit', sha: c.sha })}
                title={`${c.shortSha} · ${c.author}\n${c.subject}`}
              >
                <span className="git-commit-sha">{c.shortSha}</span>
                <span className="git-commit-subject">{c.subject}</span>
                <span className="git-commit-meta">{relTime(c.date)}</span>
              </div>
            ))}
            {chatId && status && status.recentCommits.length === 0 && (
              <div className="git-empty-line">No commits on this branch yet.</div>
            )}
          </div>

          <div
            className="git-splitter"
            onMouseDown={startVerticalDrag(commitsPx, setCommitsPx, commitsRef, 'down')}
            title="Drag to resize"
          />

          {/* Files list — fills remaining vertical space. */}
          <div className="git-files">
            <div className="git-files-toolbar">
              {isWip ? (
                <>
                  <label className="git-checkbox-label" title={allChecked ? 'Uncheck all' : 'Check all'}>
                    <input
                      type="checkbox"
                      className="git-row-check"
                      checked={allChecked}
                      onChange={toggleAllChecked}
                      ref={(el) => { if (el) el.indeterminate = !allChecked && anyChecked; }}
                    />
                    <span>{checked.size} of {files.length} for commit</span>
                  </label>
                  {selected.size > 0 && (
                    <button
                      className="git-mini-action danger"
                      title="Revert selected files"
                      onClick={() => askRevert([...selected])}
                    >
                      <i className="fa-solid fa-rotate-left" /> Revert {selected.size}
                    </button>
                  )}
                </>
              ) : (
                <span className="git-files-readonly">
                  Read-only · {files.length} file{files.length === 1 ? '' : 's'}
                  {historyError && ` · ${historyError}`}
                </span>
              )}
            </div>
            <div className="git-files-body">
              {files.map((f) => {
                const meta = STATUS_META[f.status];
                const isSelected = selected.has(f.path);
                const isChecked = checked.has(f.path);
                const isOpen = diffPath === f.path;
                return (
                  <div
                    key={f.path}
                    className={`git-file-row ${isSelected ? 'selected' : ''} ${isOpen ? 'open' : ''}`}
                    onClick={(e) => handleRowClick(f, e)}
                    onContextMenu={(e) => onContextMenu(f, e)}
                    title={`${meta.label}${f.oldPath ? ` (was ${f.oldPath})` : ''}`}
                  >
                    {isWip ? (
                      <input
                        type="checkbox"
                        className="git-row-check"
                        checked={isChecked}
                        onChange={() => toggleChecked(f.path)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="git-row-check-spacer" />
                    )}
                    <i
                      className={`fa-solid ${meta.icon} git-file-icon`}
                      style={{ color: meta.color }}
                    />
                    <span className="git-file-path">{f.path}</span>
                    <span className="git-file-status" style={{ color: meta.color }}>
                      {meta.abbr}
                    </span>
                  </div>
                );
              })}
              {files.length === 0 && !historyError && (
                <div className="git-empty-line">
                  {isWip ? 'No uncommitted changes.' : 'No files in this commit.'}
                </div>
              )}
            </div>
          </div>

          {/* Splitter + action footer (WIP only). */}
          {isWip && (
            <>
              <div
                className="git-splitter"
                onMouseDown={startVerticalDrag(commitFootPx, setCommitFootPx, commitFootRef, 'up')}
                title="Drag to resize"
              />
              <div
                ref={commitFootRef}
                className="git-commit-foot"
                style={{ flex: `0 0 ${footerHeight}px` }}
              >
                {/* Base branch + Open PR row */}
                <div className="git-base-row">
                  <span className="git-base-label" title="PR target / fork-point branch">→</span>
                  <span className="git-base-name" title="Base branch (PR target)">{baseBranch}</span>
                  <button
                    className="btn ghost sm git-base-change"
                    onClick={() => setPickingBranch(true)}
                    title="Change base branch and ask the AI to rebase / cherry-pick"
                  >
                    Change
                  </button>
                  {/* The PR link previously rendered here moved to the
                      runtime-strip PR chip in the chat header — that's
                      now the single, consistent place to jump to the
                      web page from anywhere in the chat UI. */}
                </div>

                {/* Mode picker pills */}
                <div className="git-mode-row">
                  {(Object.keys(MODE_META) as Mode[]).map((m) => (
                    <button
                      key={m}
                      className={`git-mode-pill ${mode === m ? 'active' : ''}`}
                      onClick={() => setMode(m)}
                      title={MODE_META[m].label}
                    >
                      {MODE_META[m].short}
                    </button>
                  ))}
                </div>

                {/* Textarea: commit message OR prompt preview (read-only) */}
                <textarea
                  className={`git-commit-msg ${mode === 'commit' ? '' : 'preview'}`}
                  placeholder={
                    mode === 'commit'
                      ? (anyChecked ? 'Commit message…' : 'Check files to commit')
                      : 'Prompt preview'
                  }
                  value={mode === 'commit' ? commitMsg : previewText}
                  onChange={(e) => mode === 'commit' && setCommitMsg(e.target.value)}
                  readOnly={mode !== 'commit'}
                  disabled={mode === 'commit' && !anyChecked}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void runAction();
                  }}
                />

                {/* The single action button. */}
                <button
                  className="btn primary git-action-btn"
                  disabled={
                    mode === 'commit'
                      ? !anyChecked || !commitMsg.trim()
                      : !chatId
                  }
                  onClick={() => void runAction()}
                  title={`${MODE_META[mode].label} (⌘↵)`}
                >
                  <i className={`fa-solid ${MODE_META[mode].icon}`} />
                  &nbsp;{MODE_META[mode].label}
                  {mode === 'commit' && checked.size > 0 && ` (${checked.size})`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {pickingBranch && (
        <BaseBranchDialog
          subtitle="Change base branch — the AI will rebase / cherry-pick onto it."
          initial={baseBranch}
          lockedRepoId={chatRepoId ?? undefined}
          onCancel={() => setPickingBranch(false)}
          onConfirm={({ baseBranch: b }) => {
            if (b) void onPickBaseBranch(b);
          }}
        />
      )}

      {menu && (
        <div
          className="git-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="git-menu-item"
            onClick={() => {
              const p = menu.paths[0];
              if (p) onOpenDiff(scope, p);
              setMenu(null);
            }}
            disabled={menu.paths.length !== 1}
          >
            <i className="fa-solid fa-eye" /> View diff
          </button>
          {isWip && (
            <button
              className="git-menu-item danger"
              onClick={() => askRevert(menu.paths)}
            >
              <i className="fa-solid fa-rotate-left" />
              Revert {menu.paths.length} file{menu.paths.length === 1 ? '' : 's'}…
            </button>
          )}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title="Revert files"
          message={
            confirm.paths.length === 1
              ? `Discard local changes to "${confirm.paths[0]}"? This cannot be undone.`
              : `Discard local changes to ${confirm.paths.length} files? This cannot be undone.`
          }
          confirmLabel="Revert"
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doRevert(confirm.paths)}
        />
      )}

      {chatId && chatName && (
        <div className="git-panel-foot-hint" title={chatName}>{chatName}</div>
      )}
    </div>
  );
}

function filterSet(s: Set<string>, present: Set<string>): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const x of s) {
    if (present.has(x)) next.add(x);
    else changed = true;
  }
  return changed ? next : s;
}

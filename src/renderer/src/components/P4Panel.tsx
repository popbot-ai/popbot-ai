/**
 * Perforce source-control panel — the `nativeClientUi` for `scm: 'perforce'`
 * repos. Three stacked sections (the user's design):
 *
 *   - top:    latest submitted changes (read-only history)
 *   - middle: current changes = `p4 opened`, capped + "N of M" footer; the
 *             working area — select → diff, revert, submit
 *   - bottom: the shelf (shelved changelists)
 *
 * Reuses the SCM IPC (`window.popbot.git.*`), which routes to the Perforce
 * provider for a P4 repo. There is no reconcile: the slot file-watcher keeps
 * `p4 opened` honest, so this panel just renders provider output.
 */
import { useEffect, useRef, useState } from 'react';
import type { GitFileChange, GitFileStatus } from '@shared/git';
import { useGitStatus } from '../lib/useGitStatus';
import { useTranslation } from '../lib/i18n';
import { P4Glyph } from './P4Glyph';
import type { SourceControlPanelProps } from './SourceControlPanel';

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

const STATUS_ICON: Record<GitFileStatus, { icon: string; color: string; abbr: string }> = {
  modified: { icon: 'fa-pen', color: 'var(--warn, #d8a657)', abbr: 'M' },
  added: { icon: 'fa-plus', color: 'var(--ok, #6fae5e)', abbr: 'A' },
  deleted: { icon: 'fa-minus', color: 'var(--danger, #d05656)', abbr: 'D' },
  renamed: { icon: 'fa-arrow-right-arrow-left', color: 'var(--accent, #6b7cff)', abbr: 'R' },
  untracked: { icon: 'fa-question', color: 'var(--fg-3, #888)', abbr: '?' },
  conflict: { icon: 'fa-triangle-exclamation', color: 'var(--danger, #d05656)', abbr: '!' },
};

export function P4Panel({ chatId, chatName, diffPath, onOpenDiff }: SourceControlPanelProps): JSX.Element {
  const { t } = useTranslation();
  const { data, refresh } = useGitStatus(chatId);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Live progress while a huge changed-file set is opened into the changelist.
  const [openProgress, setOpenProgress] = useState('');
  useEffect(() => window.popbot.repos.onP4OpenProgress(setOpenProgress), []);

  // Splitter-driven heights for the top (commits) + bottom (shelf) sections;
  // the middle "current changes" section flexes to fill the rest. flexBasis is
  // written to the ref directly during drag (no per-pixel re-render).
  const [commitsPx, setCommitsPx] = useState(120);
  const [shelfPx, setShelfPx] = useState(100);
  const [submitPx, setSubmitPx] = useState(110);
  const commitsRef = useRef<HTMLDivElement | null>(null);
  const shelfRef = useRef<HTMLDivElement | null>(null);
  const submitRef = useRef<HTMLDivElement | null>(null);
  // Checked shelves (by change number) + shift-range anchors for both lists.
  const [shelfChecked, setShelfChecked] = useState<Set<string>>(new Set());
  const fileAnchor = useRef<number | null>(null);
  const shelfAnchor = useRef<number | null>(null);
  const shiftRef = useRef(false); // last checkbox mousedown's shiftKey
  const startVerticalDrag =
    (current: number, setter: (n: number) => void, target: React.RefObject<HTMLDivElement>, direction: 'down' | 'up') =>
    (e: React.MouseEvent): void => {
      e.preventDefault();
      const startY = e.clientY;
      let last = current;
      const move = (ev: MouseEvent): void => {
        const dy = ev.clientY - startY;
        last = clamp(current + (direction === 'down' ? dy : -dy), 40, 600);
        if (target.current) target.current.style.flexBasis = `${last}px`;
      };
      const up = (): void => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        setter(last);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };

  const ok = data?.ok ? data : null;
  // Surface a failed status load explicitly rather than rendering as an empty
  // (clean) workspace, which would hide real errors.
  const statusError = data && !data.ok ? (data.error ?? data.reason) : null;
  const files: GitFileChange[] = ok?.files ?? [];
  const commits = ok?.recentCommits ?? [];
  const shelves = ok?.shelves ?? [];
  const truncatedFrom = ok?.truncatedFrom;

  if (!chatId) {
    return <div className="p4-panel p4-empty">{t('p4.empty')}</div>;
  }

  const toggle = (path: string): void =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  // Shift-click checks the whole range between the previous click and this one.
  const toggleFileAt = (idx: number, shift: boolean): void => {
    if (shift && fileAnchor.current !== null) {
      const lo = Math.min(fileAnchor.current, idx);
      const hi = Math.max(fileAnchor.current, idx);
      setChecked((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i += 1) if (files[i]) next.add(files[i].path);
        return next;
      });
    } else {
      toggle(files[idx].path);
      fileAnchor.current = idx;
    }
  };

  const toggleShelfAt = (idx: number, shift: boolean): void => {
    const setAt = (lo: number, hi: number): void =>
      setShelfChecked((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i += 1) if (shelves[i]) next.add(String(shelves[i].change));
        return next;
      });
    if (shift && shelfAnchor.current !== null) {
      setAt(Math.min(shelfAnchor.current, idx), Math.max(shelfAnchor.current, idx));
    } else {
      const change = String(shelves[idx].change);
      setShelfChecked((prev) => {
        const next = new Set(prev);
        next.has(change) ? next.delete(change) : next.add(change);
        return next;
      });
      shelfAnchor.current = idx;
    }
  };

  const shelve = async (): Promise<void> => {
    const paths = [...checked].filter((p) => files.some((f) => f.path === p));
    if (!paths.length || busy) return;
    setBusy(true);
    setActionError(null);
    const res = await window.popbot.git.shelve({ chatId, paths, message: desc.trim() || undefined });
    setBusy(false);
    if (res.ok) {
      setChecked(new Set());
      refresh();
    } else {
      setActionError(res.error || 'Shelve failed');
    }
  };

  const unshelve = async (): Promise<void> => {
    const changes = [...shelfChecked];
    if (!changes.length || busy) return;
    setBusy(true);
    setActionError(null);
    const res = await window.popbot.git.unshelve({ chatId, changes });
    setBusy(false);
    if (res.ok) {
      setShelfChecked(new Set());
      refresh();
    } else {
      setActionError(res.error || 'Unshelve failed');
    }
  };

  // Header select-all / none toggles (the indeterminate state is set on the
  // DOM node via a ref callback since React has no `indeterminate` prop).
  const allFilesChecked = files.length > 0 && files.every((f) => checked.has(f.path));
  const someFilesChecked = files.some((f) => checked.has(f.path));
  const toggleAllFiles = (): void => {
    setChecked(allFilesChecked ? new Set() : new Set(files.map((f) => f.path)));
    fileAnchor.current = null;
  };
  const allShelvesChecked = shelves.length > 0 && shelves.every((s) => shelfChecked.has(String(s.change)));
  const someShelvesChecked = shelves.some((s) => shelfChecked.has(String(s.change)));
  const toggleAllShelves = (): void => {
    setShelfChecked(allShelvesChecked ? new Set() : new Set(shelves.map((s) => String(s.change))));
    shelfAnchor.current = null;
  };

  const submit = async (): Promise<void> => {
    const paths = [...checked].filter((p) => files.some((f) => f.path === p));
    if (!paths.length || !desc.trim() || busy) return;
    setBusy(true);
    setActionError(null);
    const res = await window.popbot.git.commit({ chatId, message: desc, paths });
    setBusy(false);
    if (res.ok) {
      setChecked(new Set());
      setDesc('');
      refresh();
    } else {
      setActionError(res.error || 'Submit failed');
    }
  };

  const revert = async (paths: string[]): Promise<void> => {
    if (!paths.length || busy) return;
    setBusy(true);
    setActionError(null);
    const res = await window.popbot.git.revert({ chatId, paths });
    setBusy(false);
    if (res.ok) {
      setChecked((prev) => {
        const next = new Set(prev);
        paths.forEach((p) => next.delete(p));
        return next;
      });
      refresh();
    } else {
      setActionError(res.error || 'Revert failed');
    }
  };

  return (
    <div className="p4-panel">
      {/* SCM tag + the chat's changelist name (its branch analog). */}
      <div className="git-panel-head">
        <div className="git-panel-title">
          <span className="repo-card-scm scm-perforce" title={t('prefs.repos.scm.perforce')}>
            <P4Glyph /> {t('prefs.repos.scm.perforce')}
          </span>
          <span className="git-branch" title={ok?.branch ?? ''}>{ok?.branch ?? '—'}</span>
        </div>
        {ok?.client && (
          <div className="p4-workspace mono" title={t('p4.workspace.title', { client: ok.client })}>
            <i className="fa-solid fa-desktop" />&nbsp;{ok.client}
          </div>
        )}
      </div>
      {openProgress && (
        <div className="pref-progress" style={{ margin: '4px 10px' }}>
          <i className="fa-solid fa-spinner fa-spin" /> {openProgress}
        </div>
      )}
      {(actionError || statusError) && (
        <div className="p4-error" role="alert">{actionError ?? statusError}</div>
      )}
      {/* top — recent submitted changes */}
      <div className="p4-section p4-commits" ref={commitsRef} style={{ flex: `0 0 ${commitsPx}px` }}>
        <div className="p4-section-head">{t('p4.commits.title')}</div>
        <div className="p4-section-body">
          {commits.length === 0 && <div className="git-empty-line">{t('p4.commits.empty')}</div>}
          {commits.map((c) => (
            <div key={c.sha} className="p4-commit-row" title={c.subject}>
              <span className="p4-change">@{c.shortSha}</span>
              <span className="p4-commit-subject">{c.subject}</span>
              <span className="p4-commit-author">{c.author}</span>
            </div>
          ))}
        </div>
      </div>

      <div
        className="git-splitter"
        onMouseDown={startVerticalDrag(commitsPx, setCommitsPx, commitsRef, 'down')}
        title={t('common.dragToResize')}
      />
      {/* middle — current changes (p4 opened) */}
      <div className="p4-section p4-changes">
        <div className="p4-section-head">
          <span className="p4-head-all">
            {files.length > 0 && (
              <input
                type="checkbox"
                className="git-row-check"
                ref={(el) => { if (el) el.indeterminate = someFilesChecked && !allFilesChecked; }}
                checked={allFilesChecked}
                onChange={toggleAllFiles}
                title={t('p4.selectAll')}
              />
            )}
            {t('p4.changes.title')}
          </span>
          {files.length > 0 && (
            <span className="p4-head-actions">
              <button
                className="git-mini-action"
                disabled={checked.size === 0 || busy}
                onClick={() => void shelve()}
                title={t('p4.shelveChecked')}
              >
                <i className="fa-solid fa-box-archive" /> {t('p4.shelve')}
              </button>
              <button
                className="git-mini-action danger"
                disabled={checked.size === 0 || busy}
                onClick={() => revert([...checked])}
                title={t('p4.revert')}
              >
                <i className="fa-solid fa-rotate-left" /> {t('p4.revert')}
              </button>
            </span>
          )}
        </div>
        <div className="p4-section-body">
          {files.length === 0 && <div className="git-empty-line">{t('p4.changes.empty')}</div>}
          {files.map((f, idx) => {
            const meta = STATUS_ICON[f.status];
            return (
              <div
                key={f.path}
                className={`git-file-row ${diffPath === f.path ? 'open' : ''}`}
                onClick={() => onOpenDiff({ kind: 'wip' }, f.path)}
              >
                <input
                  type="checkbox"
                  className="git-row-check"
                  checked={checked.has(f.path)}
                  onMouseDown={(e) => { shiftRef.current = e.shiftKey; }}
                  onChange={() => toggleFileAt(idx, shiftRef.current)}
                  onClick={(e) => e.stopPropagation()}
                />
                <i className={`fa-solid ${meta.icon} git-file-icon`} style={{ color: meta.color }} />
                <span className="git-file-path">{f.path}</span>
                <span className="git-file-status" style={{ color: meta.color }}>{meta.abbr}</span>
              </div>
            );
          })}
          {truncatedFrom != null && (
            <div className="git-empty-line git-files-truncated">
              {t('git.files.truncated', { shown: files.length, total: truncatedFrom })}
            </div>
          )}
        </div>
        <div
          className="git-splitter"
          onMouseDown={startVerticalDrag(submitPx, setSubmitPx, submitRef, 'up')}
          title={t('common.dragToResize')}
        />
        <div className="p4-submit" ref={submitRef} style={{ flex: `0 0 ${submitPx}px` }}>
          {ok?.client && (
            <div className="p4-workspace mono" title={t('p4.workspace.title', { client: ok.client })}>
              <i className="fa-solid fa-desktop" />&nbsp;{ok.client}
            </div>
          )}
          <textarea
            className="p4-submit-msg"
            placeholder={t('p4.submitPlaceholder')}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={2}
          />
          <button
            className="btn primary sm"
            disabled={checked.size === 0 || !desc.trim() || busy}
            onClick={submit}
          >
            {t('p4.submit', { count: checked.size })}
          </button>
        </div>
      </div>

      <div
        className="git-splitter"
        onMouseDown={startVerticalDrag(shelfPx, setShelfPx, shelfRef, 'up')}
        title={t('common.dragToResize')}
      />
      {/* bottom — shelf */}
      <div className="p4-section p4-shelf" ref={shelfRef} style={{ flex: `0 0 ${shelfPx}px` }}>
        <div className="p4-section-head">
          <span className="p4-head-all">
            {shelves.length > 0 && (
              <input
                type="checkbox"
                className="git-row-check"
                ref={(el) => { if (el) el.indeterminate = someShelvesChecked && !allShelvesChecked; }}
                checked={allShelvesChecked}
                onChange={toggleAllShelves}
                title={t('p4.selectAll')}
              />
            )}
            {t('p4.shelf.title')}
          </span>
          {shelves.length > 0 && (
            <span className="p4-head-actions">
              <button
                className="git-mini-action"
                disabled={shelfChecked.size === 0 || busy}
                onClick={() => void unshelve()}
                title={t('p4.unshelveChecked')}
              >
                <i className="fa-solid fa-box-open" /> {t('p4.unshelve')}
              </button>
            </span>
          )}
        </div>
        <div className="p4-section-body">
          {shelves.length === 0 && <div className="git-empty-line">{t('p4.shelf.empty')}</div>}
          {shelves.map((s, idx) => (
            <div key={s.change} className="p4-shelf-row" title={s.description}>
              <input
                type="checkbox"
                className="git-row-check"
                checked={shelfChecked.has(String(s.change))}
                onMouseDown={(e) => { shiftRef.current = e.shiftKey; }}
                onChange={() => toggleShelfAt(idx, shiftRef.current)}
                onClick={(e) => e.stopPropagation()}
              />
              <i className="fa-solid fa-box-archive git-file-icon" />
              <span className="p4-change">@{s.change}</span>
              <span className="p4-commit-subject">{s.description}</span>
            </div>
          ))}
        </div>
      </div>

      {chatName && <div className="p4-foot">{chatName}</div>}
    </div>
  );
}

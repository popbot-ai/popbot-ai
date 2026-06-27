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
  const commitsRef = useRef<HTMLDivElement | null>(null);
  const shelfRef = useRef<HTMLDivElement | null>(null);
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
          {t('p4.changes.title')}
          {files.length > 0 && (
            <button
              className="git-mini-action danger"
              disabled={checked.size === 0 || busy}
              onClick={() => revert([...checked])}
              title={t('p4.revert')}
            >
              <i className="fa-solid fa-rotate-left" /> {t('p4.revert')}
            </button>
          )}
        </div>
        <div className="p4-section-body">
          {files.length === 0 && <div className="git-empty-line">{t('p4.changes.empty')}</div>}
          {files.map((f) => {
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
                  onChange={() => toggle(f.path)}
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
        <div className="p4-submit">
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
        <div className="p4-section-head">{t('p4.shelf.title')}</div>
        <div className="p4-section-body">
          {shelves.length === 0 && <div className="git-empty-line">{t('p4.shelf.empty')}</div>}
          {shelves.map((s) => (
            <div key={s.change} className="p4-shelf-row" title={s.description}>
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

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
import { isP4AuthError } from '@shared/perforce';
import { useGitStatus } from '../lib/useGitStatus';
import { useTranslation } from '../lib/i18n';
import type { MessageKey } from '@shared/i18n';
import {
  expandTemplate,
  DEFAULT_P4_CODE_REVIEW_TEMPLATE,
  DEFAULT_RUN_TESTS_TEMPLATE,
  DEFAULT_P4_REVIEW_COMMIT_TEMPLATE,
} from '../lib/templates';
import { P4Glyph } from './P4Glyph';
import type { SourceControlPanelProps } from './SourceControlPanel';

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Footer modes, mirroring the git panel: a manual `submit` plus AI actions
 *  that send a templated prompt to the chat agent (which does the real
 *  p4 / Helix Swarm work). */
type P4Mode = 'submit' | 'cr' | 'tests' | 'reviewCommit';

interface P4ModeMeta {
  labelKey: MessageKey; // full label (big button)
  shortKey: MessageKey; // compact label (mode pill)
  icon: string;
  isAi: boolean;
}

const P4_MODE_META: Record<P4Mode, P4ModeMeta> = {
  submit:       { labelKey: 'p4.mode.submit.label',       shortKey: 'p4.mode.submit.short',       icon: 'fa-check',               isAi: false },
  cr:           { labelKey: 'p4.mode.cr.label',           shortKey: 'p4.mode.cr.short',           icon: 'fa-code-pull-request',   isAi: true  },
  tests:        { labelKey: 'p4.mode.tests.label',        shortKey: 'p4.mode.tests.short',        icon: 'fa-flask',               isAi: true  },
  reviewCommit: { labelKey: 'p4.mode.reviewCommit.label', shortKey: 'p4.mode.reviewCommit.short', icon: 'fa-wand-magic-sparkles', isAi: true  },
};

interface P4TemplatesBlob {
  p4CodeReview?: string;
  runTests?: string;
  p4ReviewCommit?: string;
}

const P4_TEMPLATE_FOR_MODE: Record<Exclude<P4Mode, 'submit'>, { key: keyof P4TemplatesBlob; fallback: string }> = {
  cr:           { key: 'p4CodeReview',   fallback: DEFAULT_P4_CODE_REVIEW_TEMPLATE },
  tests:        { key: 'runTests',       fallback: DEFAULT_RUN_TESTS_TEMPLATE },
  reviewCommit: { key: 'p4ReviewCommit', fallback: DEFAULT_P4_REVIEW_COMMIT_TEMPLATE },
};

type MenuItem =
  | 'sep'
  | { label: string; icon: string; disabled?: boolean; danger?: boolean; onClick: () => void };

/** Section-header overflow ("hamburger") menu. Holds the actions that operate
 *  on the checkbox-selected rows so the bar doesn't overflow with buttons. */
function ActionMenu({ items, title, up }: { items: MenuItem[]; title: string; up?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div className="p4-menu" ref={ref}>
      <button className="git-mini-action" onClick={() => setOpen((o) => !o)} title={title} aria-haspopup="menu">
        <i className="fa-solid fa-bars" />
      </button>
      {open && (
        <div className={`p4-menu-pop${up ? ' up' : ''}`} role="menu">
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="p4-menu-sep" />
            ) : (
              <button
                key={i}
                className={`p4-menu-item${it.danger ? ' danger' : ''}`}
                disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick(); }}
              >
                <i className={`fa-solid ${it.icon}`} /> {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_ICON: Record<GitFileStatus, { icon: string; color: string; abbr: string }> = {
  modified: { icon: 'fa-pen', color: 'var(--warn, #d8a657)', abbr: 'M' },
  added: { icon: 'fa-plus', color: 'var(--ok, #6fae5e)', abbr: 'A' },
  deleted: { icon: 'fa-minus', color: 'var(--danger, #d05656)', abbr: 'D' },
  renamed: { icon: 'fa-arrow-right-arrow-left', color: 'var(--accent, #6b7cff)', abbr: 'R' },
  untracked: { icon: 'fa-question', color: 'var(--fg-3, #888)', abbr: '?' },
  conflict: { icon: 'fa-triangle-exclamation', color: 'var(--danger, #d05656)', abbr: '!' },
};

// Shelf rows are files, but the selection set is flat strings — key a shelved
// file by its changelist + path. The changelist is numeric, so the FIRST space
// is always the delimiter even when the depot path itself contains spaces.
const SHELF_KEY_SEP = ' ';
const shelfFileKey = (f: { change: string; path: string }): string =>
  `${f.change}${SHELF_KEY_SEP}${f.path}`;

/** Group checked shelf-file keys back into `{ change, paths }` items for the
 *  unshelve/delete IPC (one item per source changelist). */
function groupShelfSelection(keys: Iterable<string>): { change: string; paths: string[] }[] {
  const byChange = new Map<string, string[]>();
  for (const key of keys) {
    const sep = key.indexOf(SHELF_KEY_SEP);
    const change = key.slice(0, sep);
    const path = key.slice(sep + 1);
    const list = byChange.get(change);
    if (list) list.push(path);
    else byChange.set(change, [path]);
  }
  return [...byChange].map(([change, paths]) => ({ change, paths }));
}

export function P4Panel({ chatId, chatName, diffPath, onOpenDiff }: SourceControlPanelProps): JSX.Element {
  const { t } = useTranslation();
  const { data, refresh } = useGitStatus(chatId);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Confirmation prompt for destructive actions (revert / delete shelf).
  const [confirmAction, setConfirmAction] = useState<
    { title: string; body: string; label: string; run: () => void } | null
  >(null);
  // In-app Perforce login (shown when an op fails with an auth error).
  const [loginPassword, setLoginPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  // Footer mode (manual submit vs an AI action) + the live prompt preview.
  const [mode, setMode] = useState<P4Mode>('submit');
  const [previewText, setPreviewText] = useState('');
  // Live progress while a huge changed-file set is opened into the changelist.
  const [openProgress, setOpenProgress] = useState('');
  useEffect(() => window.popbot.repos.onP4OpenProgress(setOpenProgress), []);

  /** Render the active AI mode's prompt against the user's templates (or the
   *  bundled defaults). Returns null for the manual `submit` mode. */
  const buildModePrompt = async (m: P4Mode): Promise<string | null> => {
    if (m === 'submit') return null;
    const cfg = P4_TEMPLATE_FOR_MODE[m];
    const blob = await window.popbot.settings.get<P4TemplatesBlob>('templates');
    const tmpl = (blob?.[cfg.key] ?? cfg.fallback).trim();
    const st = data?.ok ? data : null;
    return expandTemplate(tmpl, { changelist: st?.branch ?? '', client: st?.client ?? '' });
  };

  // Live-rendered prompt preview for the footer textarea (AI modes only).
  const previewBranch = data?.ok ? data.branch : '';
  const previewClient = data?.ok ? data.client : '';
  useEffect(() => {
    if (mode === 'submit') { setPreviewText(''); return; }
    let cancelled = false;
    void buildModePrompt(mode).then((tx) => { if (!cancelled && tx != null) setPreviewText(tx); });
    return () => { cancelled = true; };
    // buildModePrompt closes over the current vars; recompute when the inputs
    // that actually change the output shift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, chatId, previewBranch, previewClient]);

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
  // An expired/missing p4 ticket → show the login prompt instead of a raw error.
  const needsLogin = isP4AuthError(statusError) || isP4AuthError(actionError);
  const files: GitFileChange[] = ok?.files ?? [];
  const commits = ok?.recentCommits ?? [];
  const shelves = ok?.shelves ?? [];
  // The shelf section lists FILES (flattened across shelves), not changelists.
  // The selection set holds per-file keys; actions group them back by CL.
  const shelvedFiles = shelves.flatMap((s) => s.files);
  const truncatedFrom = ok?.truncatedFrom;

  if (!chatId) {
    return <div className="p4-panel p4-empty">{t('p4.empty')}</div>;
  }

  const doLogin = async (): Promise<void> => {
    if (!loginPassword.trim() || loginBusy) return;
    setLoginBusy(true); // immediate feedback; stays busy through the reload below
    setLoginError(null);
    try {
      const res = await window.popbot.git.p4Login({ chatId, password: loginPassword });
      if (res.ok) {
        setLoginPassword('');
        setActionError(null);
        // Await the status reload so the button keeps spinning until the panel
        // actually updates (and the modal closes) — no idle gap mid-flow.
        await refresh();
      } else {
        setLoginError(res.error || 'Login failed');
      }
    } finally {
      setLoginBusy(false);
    }
  };

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
        for (let i = lo; i <= hi; i += 1) if (shelvedFiles[i]) next.add(shelfFileKey(shelvedFiles[i]));
        return next;
      });
    if (shift && shelfAnchor.current !== null) {
      setAt(Math.min(shelfAnchor.current, idx), Math.max(shelfAnchor.current, idx));
    } else {
      const key = shelfFileKey(shelvedFiles[idx]);
      setShelfChecked((prev) => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
      });
      shelfAnchor.current = idx;
    }
  };

  const doShelve = async (keepWorking: boolean): Promise<void> => {
    const paths = [...checked].filter((p) => files.some((f) => f.path === p));
    if (!paths.length || busy) return;
    setBusy(true);
    setActionError(null);
    // Default the shelf label to the file name(s) so the shelf row is
    // recognizable (vs the generic "popbot shelf"). The typed changelist
    // description wins if present.
    const first = paths[0].split('/').pop() ?? paths[0];
    const shelfLabel = desc.trim() || (paths.length === 1 ? first : `${first} +${paths.length - 1}`);
    const res = await window.popbot.git.shelve({ chatId, paths, message: shelfLabel, keepWorking });
    if (res.ok) {
      setChecked(new Set());
      await refresh(); // keep the overlay up until the panel reflects the change
    } else {
      setActionError(res.error || 'Shelve failed');
    }
    setBusy(false);
  };

  const deleteFromShelf = async (): Promise<void> => {
    const items = groupShelfSelection(shelfChecked);
    if (!items.length || busy) return;
    setBusy(true);
    setActionError(null);
    const res = await window.popbot.git.deleteShelf({ chatId, items });
    if (res.ok) {
      setShelfChecked(new Set());
      await refresh(); // keep the overlay up until the panel reflects the change
    } else {
      setActionError(res.error || 'Delete failed');
    }
    setBusy(false);
  };


  const unshelve = async (): Promise<void> => {
    const items = groupShelfSelection(shelfChecked);
    if (!items.length || busy) return;
    setBusy(true);
    setActionError(null);
    const res = await window.popbot.git.unshelve({ chatId, items });
    if (res.ok) {
      setShelfChecked(new Set());
      await refresh(); // keep the overlay up until the panel reflects the change
    } else {
      setActionError(res.error || 'Unshelve failed');
    }
    setBusy(false);
  };

  // Header select-all / none toggles (the indeterminate state is set on the
  // DOM node via a ref callback since React has no `indeterminate` prop).
  const allFilesChecked = files.length > 0 && files.every((f) => checked.has(f.path));
  const someFilesChecked = files.some((f) => checked.has(f.path));
  const toggleAllFiles = (): void => {
    setChecked(allFilesChecked ? new Set() : new Set(files.map((f) => f.path)));
    fileAnchor.current = null;
  };
  const allShelvesChecked = shelvedFiles.length > 0 && shelvedFiles.every((f) => shelfChecked.has(shelfFileKey(f)));
  const someShelvesChecked = shelvedFiles.some((f) => shelfChecked.has(shelfFileKey(f)));
  const toggleAllShelves = (): void => {
    setShelfChecked(allShelvesChecked ? new Set() : new Set(shelvedFiles.map((f) => shelfFileKey(f))));
    shelfAnchor.current = null;
  };

  // A Perforce submit submits the whole pending changelist, not a checkbox
  // subset — so it operates on every open file regardless of what's checked.
  const submit = async (): Promise<void> => {
    const paths = files.map((f) => f.path);
    if (!paths.length || !desc.trim() || busy) return;
    setBusy(true);
    setActionError(null);
    const res = await window.popbot.git.commit({ chatId, message: desc, paths });
    if (res.ok) {
      setChecked(new Set());
      setDesc('');
      await refresh(); // keep the overlay up until the panel reflects the change
    } else {
      setActionError(res.error || 'Submit failed');
    }
    setBusy(false);
  };

  /** Run the active footer mode: manual submit, or send the rendered AI
   *  prompt to the chat agent as a user message. */
  const runAction = async (): Promise<void> => {
    if (mode === 'submit') { await submit(); return; }
    if (busy) return;
    setBusy(true); // immediate feedback BEFORE building the prompt (reads settings)
    setActionError(null);
    try {
      const text = await buildModePrompt(mode);
      if (!text) return;
      await window.popbot.agent.send({ chatId, text });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revert = async (paths: string[]): Promise<void> => {
    if (!paths.length || busy) return;
    setBusy(true);
    setActionError(null);
    const res = await window.popbot.git.revert({ chatId, paths });
    if (res.ok) {
      setChecked((prev) => {
        const next = new Set(prev);
        paths.forEach((p) => next.delete(p));
        return next;
      });
      await refresh(); // keep the overlay up until the panel reflects the change
    } else {
      setActionError(res.error || 'Revert failed');
    }
    setBusy(false);
  };

  return (
    <div className="p4-panel">
      {/* Unmissable centered "washing machine" overlay for any in-flight op. */}
      {busy && (
        <div className="p4-busy-overlay" aria-hidden="true">
          <div className="p4-washer" />
        </div>
      )}
      {/* Single row: SCM badge + changelist (#number + name). The workspace
          name sits on the right of the RECENT CHANGES bar below. */}
      <div className="p4-head">
        <span className="repo-card-scm scm-perforce" title={t('prefs.repos.scm.perforce')}>
          <P4Glyph /> {t('prefs.repos.scm.perforce')}
        </span>
        {ok?.changeNumber && <span className="p4-head-clnum">@{ok.changeNumber}</span>}
        <span className="p4-head-clname" title={ok?.branch ?? ''}>{ok?.branch ?? '—'}</span>
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
        <div className="p4-section-head">
          <span>{t('p4.commits.title')}</span>
          {ok?.client && (
            <span className="p4-head-ws mono" title={t('p4.workspace.title', { client: ok.client })}>
              <i className="fa-solid fa-desktop" />&nbsp;{ok.client}
            </span>
          )}
        </div>
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
            <ActionMenu
              title={t('p4.menu.changesActions')}
              items={[
                { label: t('p4.menu.copyToShelf'), icon: 'fa-copy', disabled: checked.size === 0 || busy, onClick: () => void doShelve(true) },
                { label: t('p4.menu.moveToShelf'), icon: 'fa-box-archive', disabled: checked.size === 0 || busy, onClick: () => void doShelve(false) },
                'sep',
                { label: t('p4.revert'), icon: 'fa-rotate-left', danger: true, disabled: checked.size === 0 || busy, onClick: () => setConfirmAction({ title: t('p4.revert'), body: t('p4.confirm.revertBody', { count: checked.size }), label: t('p4.revert'), run: () => revert([...checked]) }) },
              ]}
            />
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
          {/* Mode picker pills */}
          <div className="git-mode-row">
            {(Object.keys(P4_MODE_META) as P4Mode[]).map((m) => (
              <button
                key={m}
                className={`git-mode-pill ${mode === m ? 'active' : ''}`}
                onClick={() => setMode(m)}
                title={t(P4_MODE_META[m].labelKey)}
              >
                {t(P4_MODE_META[m].shortKey)}
              </button>
            ))}
          </div>

          {/* Textarea: changelist description (submit) OR prompt preview (AI) */}
          <textarea
            className={`p4-submit-msg ${mode === 'submit' ? '' : 'preview'}`}
            placeholder={mode === 'submit' ? t('p4.submitPlaceholder') : t('p4.promptPreviewPlaceholder')}
            value={mode === 'submit' ? desc : previewText}
            onChange={(e) => mode === 'submit' && setDesc(e.target.value)}
            readOnly={mode !== 'submit'}
            rows={2}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void runAction();
            }}
          />

          {/* Single action button — centered label, no file count (a submit
              always takes the whole changelist). */}
          <button
            className="btn primary git-action-btn"
            disabled={
              mode === 'submit' ? files.length === 0 || !desc.trim() || busy : busy
            }
            onClick={() => void runAction()}
            title={t(P4_MODE_META[mode].labelKey)}
          >
            <i className={`fa-solid ${busy ? 'fa-circle-notch fa-spin' : P4_MODE_META[mode].icon}`} />
            &nbsp;{t(P4_MODE_META[mode].labelKey)}
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
            {shelvedFiles.length > 0 && (
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
          {shelvedFiles.length > 0 && (
            <ActionMenu
              title={t('p4.menu.shelfActions')}
              up
              items={[
                { label: t('p4.menu.returnToChangelist'), icon: 'fa-box-open', disabled: shelfChecked.size === 0 || busy, onClick: () => void unshelve() },
                'sep',
                { label: t('p4.menu.deleteFromShelf'), icon: 'fa-trash-can', danger: true, disabled: shelfChecked.size === 0 || busy, onClick: () => setConfirmAction({ title: t('p4.menu.deleteFromShelf'), body: t('p4.confirm.deleteShelfBody', { count: shelfChecked.size }), label: t('p4.menu.deleteFromShelf'), run: () => deleteFromShelf() }) },
              ]}
            />
          )}
        </div>
        <div className="p4-section-body">
          {shelvedFiles.length === 0 && <div className="git-empty-line">{t('p4.shelf.empty')}</div>}
          {shelvedFiles.map((f, idx) => {
            const meta = STATUS_ICON[f.status];
            const key = shelfFileKey(f);
            return (
              <div key={key} className="p4-shelf-row" title={`@${f.change}  ${f.path}`}>
                <input
                  type="checkbox"
                  className="git-row-check"
                  checked={shelfChecked.has(key)}
                  onMouseDown={(e) => { shiftRef.current = e.shiftKey; }}
                  onChange={() => toggleShelfAt(idx, shiftRef.current)}
                  onClick={(e) => e.stopPropagation()}
                />
                <i className={`fa-solid ${meta.icon} git-file-icon`} style={{ color: meta.color }} />
                <span className="git-file-path">{f.path}</span>
                <span className="git-file-status" style={{ color: meta.color }}>{meta.abbr}</span>
              </div>
            );
          })}
        </div>
      </div>

      {chatName && <div className="p4-foot">{chatName}</div>}

      {needsLogin && (
        <>
          <div className="scrim" />
          <div className="modal" data-screen-label="Modal · p4-login">
            <div className="modal-head">
              <h2>{t('p4.login.title')}</h2>
            </div>
            <div className="modal-body">
              <p>{t('p4.login.body')}</p>
              <input
                type="password"
                className="pref-input mono"
                style={{ width: '100%' }}
                value={loginPassword}
                placeholder={t('p4.login.placeholder')}
                autoFocus
                onChange={(e) => setLoginPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void doLogin(); }}
              />
              {loginError && <div className="p4-error" role="alert">{loginError}</div>}
            </div>
            <div className="modal-foot">
              <button
                className="btn primary"
                disabled={!loginPassword.trim() || loginBusy}
                onClick={() => void doLogin()}
              >
                {loginBusy ? (
                  <>
                    <i className="fa-solid fa-circle-notch fa-spin" />&nbsp;{t('p4.login.busy')}
                  </>
                ) : (
                  t('p4.login.button')
                )}
              </button>
            </div>
          </div>
        </>
      )}

      {confirmAction && (
        <>
          <div className="scrim" onClick={() => setConfirmAction(null)} />
          <div className="modal" data-screen-label="Modal · p4-confirm">
            <div className="modal-head">
              <h2>{confirmAction.title}</h2>
            </div>
            <div className="modal-body">{confirmAction.body}</div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmAction(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const run = confirmAction.run;
                  setConfirmAction(null);
                  run();
                }}
              >
                {confirmAction.label}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

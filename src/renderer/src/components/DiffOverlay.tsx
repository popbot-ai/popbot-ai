import { useEffect, useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import type { GitDiffResultOrErr, GitScope } from '@shared/git';

interface DiffOverlayProps {
  chatId: string;
  scope: GitScope;
  path: string;
  onClose: () => void;
}

/**
 * Persistent file-diff overlay rendered inside `.workspace`. Stays
 * mounted across file changes so the viewer's scroll position +
 * settings persist; the parent updates `path`/`scope` to swap
 * contents.
 *
 * Closing is the parent's job — the backdrop element it adds outside
 * this overlay is what catches "click in the chat area" closes. Inside
 * the overlay, clicks stop propagation so they don't reach the
 * backdrop.
 */
export function DiffOverlay({ chatId, scope, path, onClose }: DiffOverlayProps): JSX.Element {
  const [data, setData] = useState<GitDiffResultOrErr | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    void window.popbot.git.diff({ chatId, scope, path }).then((res) => {
      if (!cancelled) setData(res);
    });
    return () => { cancelled = true; };
  }, [chatId, scope, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="diff-overlay"
      role="dialog"
      aria-label={`Diff for ${path}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="diff-overlay-head">
        <span className="diff-overlay-scope">
          {scope.kind === 'wip' ? 'Uncommitted' : scope.sha.slice(0, 7)}
        </span>
        <span className="diff-overlay-path" title={path}>{path}</span>
        <button className="diff-overlay-close" onClick={onClose} title="Close (Esc)">
          <i className="fa-solid fa-xmark" />
        </button>
      </div>
      <div className="diff-overlay-body">
        {!data && <div className="diff-overlay-status">Loading diff…</div>}
        {data && !data.ok && (
          <div className="diff-overlay-status error">Error: {data.error}</div>
        )}
        {data?.ok && data.isBinary && (
          <div className="diff-overlay-status">Binary file — diff not shown.</div>
        )}
        {data?.ok && !data.isBinary && (
          <ReactDiffViewer
            oldValue={data.oldText}
            newValue={data.newText}
            splitView={false}
            useDarkTheme
            hideLineNumbers={false}
            compareMethod={DiffMethod.WORDS_WITH_SPACE}
            showDiffOnly={true}
            extraLinesSurroundingDiff={3}
            styles={DIFF_OVERLAY_STYLES}
          />
        )}
      </div>
    </div>
  );
}

const DIFF_OVERLAY_STYLES = {
  variables: {
    dark: {
      diffViewerBackground: 'transparent',
      diffViewerColor: 'var(--fg-1)',
      addedBackground: 'rgba(63, 178, 127, 0.10)',
      addedColor: 'var(--fg-1)',
      removedBackground: 'rgba(220, 88, 88, 0.10)',
      removedColor: 'var(--fg-1)',
      wordAddedBackground: 'rgba(63, 178, 127, 0.32)',
      wordRemovedBackground: 'rgba(220, 88, 88, 0.32)',
      gutterBackground: 'transparent',
      gutterColor: 'var(--fg-3)',
      addedGutterBackground: 'rgba(63, 178, 127, 0.10)',
      removedGutterBackground: 'rgba(220, 88, 88, 0.10)',
      codeFoldBackground: 'transparent',
      codeFoldGutterBackground: 'transparent',
      codeFoldContentColor: 'var(--fg-3)',
      emptyLineBackground: 'transparent',
    },
  },
} as const;

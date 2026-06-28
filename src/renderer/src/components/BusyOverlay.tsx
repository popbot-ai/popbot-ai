import { useTranslation } from '../lib/i18n';

interface BusyOverlayProps {
  message: string;
  detail?: string;
  /** Render as a failure (error icon + Dismiss/Copy) instead of a spinner.
   *  When set, the overlay stays up until the user dismisses it — slow-op
   *  errors must be readable, not flash by. */
  error?: boolean;
  onDismiss?: () => void;
}

/**
 * Modal-style "working on it" indicator. Shown over the whole window
 * during slow main-side operations (git worktree add + checkout, etc).
 *
 * Normally has no buttons — it's a "please wait," and the caller un-renders
 * it when their async work finishes. In {@link BusyOverlayProps.error} mode it
 * becomes a dismissible error so a failure (e.g. a Perforce slot init) is
 * readable and copyable instead of vanishing.
 */
export function BusyOverlay({ message, detail, error, onDismiss }: BusyOverlayProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <div className="scrim" />
      <div className={`busy-overlay${error ? ' busy-error' : ''}`} data-screen-label="Busy">
        {error ? (
          <i
            className="fa-solid fa-triangle-exclamation busy-spinner"
            style={{ color: 'var(--danger, #d05656)' }}
          />
        ) : (
          <div className="busy-washer" />
        )}
        <div className="busy-msg">{message}</div>
        {detail && <div className="busy-detail mono">{detail}</div>}
        {error && onDismiss && (
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
            {detail && (
              <button
                className="btn ghost"
                onClick={() => void navigator.clipboard.writeText(detail)}
              >
                {t('busy.copyError')}
              </button>
            )}
            <button className="btn primary" onClick={onDismiss}>
              {t('busy.dismiss')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

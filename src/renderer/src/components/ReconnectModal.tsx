import { useTranslation } from '../lib/i18n';

export type ReconnectStatus = 'prompt' | 'working' | 'error';

interface ReconnectModalProps {
  /** Display names of the slot repos whose VHDX clones a reboot detached. */
  repos: string[];
  status: ReconnectStatus;
  /** Live status line shown under the washing-machine bar while working. */
  progress?: string;
  /** Failure text (from the elevated remount) shown in the error state. */
  error?: string;
  onReconnect: () => void;
  onLater: () => void;
  onDismiss: () => void;
}

/**
 * Center modal that drives the post-reboot slot reconnect.
 *
 * Replaces the old top banner, which a Windows title-bar overlay could obscure.
 * Three states:
 *  - `prompt`  — explains what happened + a Reconnect button. The single UAC
 *                only fires on the user's click (so it's clearly their action).
 *  - `working` — an indeterminate "washing machine" bar + progress text, since
 *                the elevated batch is opaque and can run for a minute. No
 *                buttons: an in-flight elevated remount can't be cancelled.
 *  - `error`   — the failure, copyable, with Try again / Dismiss.
 *
 * Windows-only in practice: VHDX slots don't exist on mac/linux, so the caller
 * never has disconnected repos to show here.
 */
export function ReconnectModal({
  repos,
  status,
  progress,
  error,
  onReconnect,
  onLater,
  onDismiss,
}: ReconnectModalProps): JSX.Element {
  const { t } = useTranslation();
  const repoList = repos.join(', ');
  return (
    <>
      <div className="scrim" />
      <div className="busy-overlay reconnect-modal" data-screen-label="Reconnect workspaces">
        {status === 'error' ? (
          <i
            className="fa-solid fa-triangle-exclamation busy-spinner"
            style={{ color: 'var(--danger, #d05656)' }}
          />
        ) : status === 'working' ? (
          <i className="fa-solid fa-plug-circle-bolt busy-spinner" style={{ color: 'var(--acc-hi)' }} />
        ) : (
          <i
            className="fa-solid fa-plug-circle-exclamation busy-spinner"
            style={{ color: 'var(--st-wait, #d8a657)' }}
          />
        )}

        <div className="busy-msg">
          {status === 'error' ? t('app.reconnect.failed') : t('app.reconnect.title')}
        </div>

        {status === 'working' ? (
          <>
            <div className="washer-track">
              <div className="washer-fill" />
            </div>
            <div className="busy-detail">{progress || t('app.reconnect.working')}</div>
          </>
        ) : status === 'error' ? (
          <>
            {error && <div className="busy-detail mono">{error}</div>}
            <div className="reconnect-actions">
              {error && (
                <button
                  className="btn ghost"
                  onClick={() => void navigator.clipboard.writeText(error)}
                >
                  {t('busy.copyError')}
                </button>
              )}
              <button className="btn ghost" onClick={onDismiss}>
                {t('busy.dismiss')}
              </button>
              <button className="btn primary" onClick={onReconnect}>
                {t('common.retry')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="busy-detail reconnect-body">
              {t('app.reconnect.message', { repos: repoList })}
            </div>
            <div className="reconnect-actions">
              <button className="btn ghost" onClick={onLater}>
                {t('app.reconnect.later')}
              </button>
              <button className="btn primary" onClick={onReconnect}>
                {t('app.reconnect.button')}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

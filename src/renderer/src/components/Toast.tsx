import { useEffect } from 'react';
import { useTranslation } from '../lib/i18n';

interface ToastProps {
  message: string;
  detail?: string;
  /** Click handler for the body (e.g. jump to chat). Optional. */
  onClick?: () => void;
  onDismiss: () => void;
  /** Auto-dismiss after this many ms. Default 6s. */
  ttlMs?: number;
}

/**
 * Bottom-right transient notification. Used for new-review alerts —
 * keep the API tiny so we can re-use it for other notifications later.
 */
export function Toast({ message, detail, onClick, onDismiss, ttlMs = 6000 }: ToastProps): JSX.Element {
  const { t } = useTranslation();
  useEffect(() => {
    const t = setTimeout(onDismiss, ttlMs);
    return () => clearTimeout(t);
  }, [ttlMs, onDismiss]);

  return (
    <div className="legacy-toast" role="status" aria-live="polite">
      <div
        className={`toast-body ${onClick ? 'clickable' : ''}`}
        onClick={onClick}
      >
        <div className="legacy-toast-message">{message}</div>
        {detail && <div className="legacy-toast-detail">{detail}</div>}
      </div>
      <button
        className="legacy-toast-close"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        title={t('common.dismiss')}
      >
        <i className="fa-solid fa-xmark" />
      </button>
    </div>
  );
}

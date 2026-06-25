import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../lib/i18n';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Small modal used to gate destructive operations from the git panel
 * (revert N files, etc.). Esc + backdrop click cancel; Enter confirms.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const { t } = useTranslation();
  // Fall back to localized defaults when the caller doesn't pass labels.
  const confirmText = confirmLabel ?? t('common.confirm');
  const cancelText = cancelLabel ?? t('common.cancel');
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);

  return createPortal(
    <div className="confirm-scrim" onMouseDown={onCancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">{title}</div>
        <div className="confirm-body">{message}</div>
        <div className="confirm-foot">
          <button className="btn ghost" onClick={onCancel}>{cancelText}</button>
          <button
            className={`btn ${destructive ? 'danger' : 'primary'}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { useState } from 'react';
import { useTranslation } from '../lib/i18n';

interface P4LoginModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a ticket is successfully minted. */
  onSuccess: () => void;
}

/**
 * Ambient Perforce login prompt — shown at startup and before Add-Repository
 * folder detection when `git.p4LoginStatus()` reports an expired session. Mints
 * a ticket via the machine's `p4 set` connection (no repo/chat context needed),
 * so the server-side folder probes stop reading a real workspace as "not
 * Perforce". The password transits only the login call's stdin; never stored.
 */
export function P4LoginModal({ open, onClose, onSuccess }: P4LoginModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const doLogin = async (): Promise<void> => {
    if (!password.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await window.popbot.git.p4LoginAmbient({ password });
    setBusy(false);
    if (res.ok) {
      setPassword('');
      onSuccess();
    } else {
      setError(res.error || 'Perforce login failed');
    }
  };

  const close = (): void => {
    setPassword('');
    setError(null);
    onClose();
  };

  return (
    <>
      <div className="scrim" onMouseDown={close} />
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
            value={password}
            placeholder={t('p4.login.placeholder')}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doLogin();
            }}
          />
          {error && <div className="p4-error" role="alert">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={close}>{t('common.cancel')}</button>
          <button className="btn primary" disabled={!password.trim() || busy} onClick={() => void doLogin()}>
            {busy ? (
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
  );
}

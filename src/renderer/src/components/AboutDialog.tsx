import { useEffect, useState } from 'react';
import type { UpdateCheckResult } from '@shared/updates';
import { useTranslation } from '../lib/i18n';
import popbotIcon from '../assets/popbot-icon.png';

const REPO_URL = 'https://github.com/popbot-ai/popbot-ai';

interface AboutDialogProps {
  onClose: () => void;
}

const openExternal = (url: string) => (e: React.MouseEvent): void => {
  e.preventDefault();
  window.open(url, '_blank');
};

/**
 * About PopBot — shows the running version and an on-demand update check
 * against the public GitHub releases. Reached from Help ▸ About PopBot
 * (Windows/Linux) or the native app menu (macOS). Auto-checks on open.
 */
export function AboutDialog({ onClose }: AboutDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  const runCheck = (): void => {
    setChecking(true);
    setResult(null);
    void window.popbot.updates
      .check()
      .then((r) => setResult(r))
      .catch((err: unknown) => {
        // IPC invoke can reject (renderer/main desync, unexpected main
        // error). Surface a friendly message instead of leaving the
        // dialog stuck on "Checking…" forever.
        setResult({
          current: version,
          latest: null,
          updateAvailable: false,
          htmlUrl: null,
          name: null,
          error: err instanceof Error ? err.message : 'Update check failed. Please try again.',
        });
      })
      .finally(() => setChecking(false));
  };

  useEffect(() => {
    void window.popbot.app.getVersion().then(setVersion);
    runCheck();
    // Mount-only: auto-check once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal about-modal" data-screen-label="Modal · about">
        <div className="modal-head about-head">
          <img className="about-icon" src={popbotIcon} alt="PopBot" draggable={false} />
          <div>
            <h2>PopBot</h2>
            <div className="sub">{version ? t('about.version', { version }) : t('about.versionUnknown')}</div>
          </div>
        </div>
        <div className="modal-body about-body">
          <div className="about-update">
            {checking && (
              <span className="muted"><i className="fa-solid fa-circle-notch fa-spin" /> {t('about.checking')}</span>
            )}
            {!checking && result?.error && <span className="muted">{result.error}</span>}
            {!checking && result && !result.error && !result.updateAvailable && (
              <span className="about-ok"><i className="fa-solid fa-circle-check" /> {t('about.upToDate')}</span>
            )}
            {!checking && result?.updateAvailable && (
              <span className="about-upd">
                <i className="fa-solid fa-circle-arrow-up" /> {t('about.updateAvailable')} <b>{result.latest}</b>
                {result.htmlUrl && (
                  <> — <a href={result.htmlUrl} onClick={openExternal(result.htmlUrl)}>{t('about.download')}</a></>
                )}
              </span>
            )}
          </div>
          <div className="about-links">
            <a href={REPO_URL} onClick={openExternal(REPO_URL)}>{t('about.github')}</a>
            <span className="dot">·</span>
            <a href={`${REPO_URL}/blob/main/docs/GUIDE.md`} onClick={openExternal(`${REPO_URL}/blob/main/docs/GUIDE.md`)}>
              {t('about.documentation')}
            </a>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={runCheck} disabled={checking}>
            {checking ? t('about.checkingShort') : t('about.checkBtn')}
          </button>
          <button className="btn primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </>
  );
}

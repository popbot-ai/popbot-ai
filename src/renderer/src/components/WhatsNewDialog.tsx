import { useTranslation } from '../lib/i18n';
import popbotIcon from '../assets/popbot-icon.png';

interface WhatsNewDialogProps {
  version: string;
  onClose: () => void;
}

/**
 * "What's new" popup, shown once per app version on first launch after an
 * update (App.tsx compares `app.getVersion()` against the
 * `whatsNew.lastSeenVersion` setting).
 *
 * The feature copy lives in i18n under stable keys (`whatsNew.f1.*`,
 * `whatsNew.f2.*`) — each release, update those strings in every locale
 * with the one or two headline features; the dialog itself stays put.
 */
export function WhatsNewDialog({ version, onClose }: WhatsNewDialogProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal about-modal whatsnew-modal" data-screen-label="Modal · whats-new">
        <div className="modal-head about-head">
          <img className="about-icon" src={popbotIcon} alt="PopBot" draggable={false} />
          <div>
            <h2>{t('whatsNew.title')}</h2>
            <div className="sub">{t('about.version', { version })}</div>
          </div>
        </div>
        <div className="modal-body about-body">
          <div className="whatsnew-feature">
            <h3><i className="fa-solid fa-wand-magic-sparkles" aria-hidden /> {t('whatsNew.f1.h')}</h3>
            <p>{t('whatsNew.f1.p')}</p>
          </div>
          <div className="whatsnew-feature">
            <h3><i className="fa-solid fa-bolt" aria-hidden /> {t('whatsNew.f2.h')}</h3>
            <p>{t('whatsNew.f2.p')}</p>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose} autoFocus>{t('whatsNew.gotIt')}</button>
        </div>
      </div>
    </>
  );
}

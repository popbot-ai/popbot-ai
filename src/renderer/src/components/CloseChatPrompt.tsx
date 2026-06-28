import { useEffect, useState } from 'react';
import type { ClosePrepResult } from '@shared/ipc';
import type { SourceControlProviderId } from '@shared/sourceControl';
import { useTranslation } from '../lib/i18n';

interface CloseChatPromptProps {
  chatId: string;
  branch: string | null;
  slotId: number | null;
  /** Drives SCM-aware wording (branch vs changelist, stash vs shelve).
   *  Perforce gets its own strings; anything else uses git's. */
  scm: SourceControlProviderId | null;
  onCancel: () => void;
  onClose: (opts: { stash: boolean }) => void;
}

/**
 * Pre-close confirmation. Always shown when the chat has a worktree;
 * adapts its body to clean vs dirty state. Clean → "park slot" only
 * (single button). Dirty → stash / discard / cancel.
 */
export function CloseChatPrompt({
  chatId,
  branch,
  slotId,
  scm,
  onCancel,
  onClose,
}: CloseChatPromptProps): JSX.Element {
  const { t } = useTranslation();
  const [prep, setPrep] = useState<ClosePrepResult | null>(null);
  const p4 = scm === 'perforce';

  useEffect(() => {
    void window.popbot.chats.closePrep(chatId).then(setPrep);
  }, [chatId]);

  return (
    <>
      <div className="scrim" onClick={onCancel} />
      <div className="modal" data-screen-label="Modal · close-chat">
        <div className="modal-head">
          <h2>
            {t(p4 ? 'close.title.perforce' : 'close.title', {
              branch: branch ?? t('common.noBranch'),
            })}
          </h2>
          <div className="sub">
            {slotId != null && t('close.parkSub', { slotId })}
          </div>
        </div>
        <div className="modal-body">
          {prep === null && <div>{t('close.checking')}</div>}
          {prep !== null && !prep.hasWorktree && (
            <>{t('close.noWorktree')}</>
          )}
          {prep !== null && prep.hasWorktree && !prep.dirty && (
            <>{t(p4 ? 'close.clean.perforce' : 'close.clean')}</>
          )}
          {prep !== null && prep.hasWorktree && prep.dirty && (
            <>
              <p>{t(p4 ? 'close.stashPrompt.perforce' : 'close.stashPrompt')}</p>
              <pre className="dirty-files">
                {prep.files.map((f) => f).join('\n')}
              </pre>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
          {prep?.dirty ? (
            <>
              <button className="btn danger" onClick={() => onClose({ stash: false })}>
                {t('close.discardClose')}
              </button>
              <button className="btn primary" onClick={() => onClose({ stash: true })}>
                {t(p4 ? 'close.stashClose.perforce' : 'close.stashClose')}
              </button>
            </>
          ) : (
            <button className="btn primary" disabled={prep === null} onClick={() => onClose({ stash: false })}>
              {t('close.closeChat')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

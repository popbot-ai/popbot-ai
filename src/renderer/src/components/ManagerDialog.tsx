/**
 * Make manager: tick the live chats this chat manages. A manager can
 * message and send files to its workers — interrupting them — and they
 * can write back to its inbox; no other chats can message each other at
 * all (src/main/mailbox/). Live chats only: open ones, and closed ones
 * whose agent is still up on its host or in the cloud. Each tick applies
 * at once.
 */
import type { ChatRecord } from '@shared/persistence';
import { chatShortName } from '@shared/chatNames';
import { useTranslation } from '../lib/i18n';

export function ManagerDialog({
  chat,
  candidates,
  selected,
  onChange,
  onClose,
}: {
  chat: ChatRecord;
  /** The live chats it could manage (not itself, not bots). */
  candidates: ChatRecord[];
  selected: string[];
  onChange: (workers: string[]) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const toggle = (id: string, on: boolean): void => {
    onChange(on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id));
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal manager-dialog" data-screen-label="Modal · make manager">
        <div className="modal-head">
          <h2>{t('chat.manager.title', { name: chatShortName(chat.name) })}</h2>
          <div className="sub">{t('chat.manager.sub')}</div>
        </div>
        <div className="modal-body">
          {candidates.length === 0 ? (
            <p className="manager-empty">{t('chat.manager.none')}</p>
          ) : (
            <ul className="manager-list">
              {candidates.map((c) => {
                const short = chatShortName(c.name);
                return (
                  <li key={c.id}>
                    <label>
                      <input type="checkbox" checked={selected.includes(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                      <span className="manager-name">{short}</span>
                      {short !== c.name && <span className="manager-full" title={c.name}>{c.name}</span>}
                      {c.host && <span className="manager-where"><i className="fa-solid fa-server" aria-hidden /> {c.host.hostName}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>{t('common.done')}</button>
        </div>
      </div>
    </>
  );
}

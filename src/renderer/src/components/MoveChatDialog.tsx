/**
 * Move a chat to another machine — this computer or a PopBot host. Pick
 * where; its conversation, branch and uncommitted changes go with it
 * (src/main/ipc/moveChat.ts). Where there is no repository of the same
 * name, it asks before moving the chat without one.
 */
import { useEffect, useState } from 'react';
import type { ChatRecord, HostRecord } from '@shared/persistence';
import type { MoveChatTarget } from '@shared/ipc';
import { useTranslation } from '../lib/i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { IconSelect } from './IconSelect';

const LOCAL = 'local';

interface Place {
  id: string;
  label: string;
  reachable: boolean;
}

export function MoveChatDialog({ chat, onClose }: { chat: ChatRecord; onClose: () => void }): JSX.Element {
  const { t } = useTranslation();
  const here = chat.host?.hostId ?? LOCAL;
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [pick, setPick] = useState('');
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ repo: string; from: string; to: string; branch: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.popbot.hosts.list().then(async (hosts: HostRecord[]) => {
      const probed = await Promise.all(hosts.map(async (h) => {
        const res = await window.popbot.hosts.probe(h.url, h.token).catch(() => ({ ok: false as const }));
        return { id: h.id, label: h.name, reachable: res.ok };
      }));
      if (cancelled) return;
      const all: Place[] = [{ id: LOCAL, label: t('chat.move.local'), reachable: true }, ...probed].filter((p) => p.id !== here);
      setPlaces(all);
      setPick(all.find((p) => p.reachable)?.id ?? '');
    });
    return () => { cancelled = true; };
  }, [here, t]);

  const target = (): MoveChatTarget => (pick === LOCAL ? { kind: 'local' } : { kind: 'host', hostId: pick });

  const move = async (withoutRepo = false): Promise<void> => {
    if (!pick) return;
    setMoving(true);
    setError(null);
    const res = await window.popbot.chatMove.move(chat.id, target(), { withoutRepo });
    setMoving(false);
    if (res.ok) {
      onClose();
      return;
    }
    if (res.reason === 'no-matching-repo') {
      setAsk({ repo: res.repo, from: res.from, to: res.to, branch: res.branch });
      return;
    }
    setError(res.error);
  };

  const from = chat.host?.hostName ?? t('chat.move.local');
  // The checkout it leaves is closed: what git ignores there does not move.
  const hasCheckout = chat.host ? chat.host.kind === 'worktree' : !!chat.worktreePath;
  return (
    <>
      <div className="scrim" onClick={() => { if (!moving) onClose(); }} />
      <div className="modal move-chat" data-screen-label="Modal · move chat">
        <div className="modal-head">
          <h2>{t('chat.move.title', { name: chat.name })}</h2>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{t('chat.move.from')}</label>
            <span className="bot-form-static">{from}</span>
          </div>
          <div className="field">
            <label>{t('chat.move.to')}</label>
            {places === null ? (
              <span className="bot-form-static muted">{t('common.loading')}</span>
            ) : places.length === 0 ? (
              <span className="bot-form-static muted">{t('chat.move.nowhere')}</span>
            ) : (
              <IconSelect
                block
                value={pick}
                onChange={setPick}
                options={places.map((p) => ({
                  id: p.id,
                  label: p.label,
                  icon: <i className={`fa-solid ${p.id === LOCAL ? 'fa-laptop' : 'fa-server'} tracker-dd-ico-fa${p.id === LOCAL ? '' : ' host-ico'}${p.reachable ? '' : ' off'}`} />,
                  ...(p.reachable ? {} : { detail: t('bots.hostOff'), disabled: true }),
                }))}
              />
            )}
          </div>
          <p className="move-chat-explain">{t('chat.move.explain')}</p>
          {hasCheckout && (
            <p className="move-chat-warn">
              <i className="fa-solid fa-triangle-exclamation" aria-hidden="true" /> {t('chat.move.ignoredWarning', { from: chat.host?.hostName ?? t('chat.move.localInline') })}
            </p>
          )}
          {moving && <p className="move-chat-status"><i className="fa-solid fa-spinner fa-spin" /> {t('chat.move.moving')}</p>}
          {error && <p className="move-chat-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={moving}>{t('common.cancel')}</button>
          <button className="btn primary" onClick={() => void move()} disabled={moving || !pick}>
            {t('chat.move.button')}
          </button>
        </div>
      </div>
      {ask && (
        <ConfirmDialog
          title={t('chat.move.noRepoTitle', { repo: ask.repo, to: ask.to })}
          message={ask.branch
            ? t('chat.move.noRepoBranch', { to: ask.to, from: ask.from, branch: ask.branch })
            : t('chat.move.noRepo', { to: ask.to })}
          confirmLabel={t('chat.move.withoutRepo')}
          onCancel={() => setAsk(null)}
          onConfirm={() => { setAsk(null); void move(true); }}
        />
      )}
    </>
  );
}

/**
 * The ☰ menu of a bot's chat column: what a person does to a bot —
 * edit it, wake it, pause or resume it, reset it, kill it — in place of
 * the items that belong to ordinary chats (fork, restart, compact, the
 * chat's settings). The bot itself lives on its host; this asks there.
 */
import { useEffect, useState } from 'react';
import type { BotHostListing } from '@shared/ipc';
import type { HostBotInfo } from '@shared/hostProtocol';
import type { ChatRecord } from '@shared/persistence';
import { useTranslation } from '../lib/i18n';
import { BotForm } from './BotForm';
import { ConfirmDialog } from './ConfirmDialog';

type Found = { hosts: BotHostListing[]; hostId: string; reachable: boolean; bot: HostBotInfo } | null;

/** The bot behind a bot chat, as its host last reported it. */
function useBot(chat: ChatRecord, refreshKey: unknown): Found {
  const [found, setFound] = useState<Found>(null);
  const hostId = chat.host?.hostId ?? '';
  const botId = chat.host?.botId ?? '';
  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    void window.popbot.bots.list(false).then((hosts) => {
      if (cancelled) return;
      const listing = hosts.find((h) => h.hostId === hostId);
      const bot = listing?.bots.find((b) => b.id === botId);
      setFound(listing && bot ? { hosts, hostId, reachable: listing.reachable, bot } : null);
    });
    return () => { cancelled = true; };
  }, [hostId, botId, refreshKey]);
  return found;
}

/** The menu's items. `onPick` closes the menu; dialogs open in BotChatDialogs. */
export function BotChatMenuItems({ chat, open, onPick, onDialog, onError }: {
  chat: ChatRecord;
  /** The menu is showing — re-read the bot each time it opens. */
  open: boolean;
  onPick: () => void;
  onDialog: (d: 'edit' | 'kill') => void;
  onError: (message: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const found = useBot(chat, open);
  const ready = !!found?.reachable;
  const act = (action: 'wake' | 'pause' | 'resume' | 'reset'): void => {
    onPick();
    if (!found) return;
    void window.popbot.bots.action(found.hostId, found.bot.id, action).then((res) => {
      if (!res.ok) onError(res.error);
    });
  };
  const paused = found?.bot.state === 'paused';
  return (
    <>
      <button type="button" className="chat-menu-item" role="menuitem" disabled={!ready} onClick={() => { onPick(); onDialog('edit'); }}>
        <i className="fa-solid fa-pen" aria-hidden="true" />
        {t('bots.menu.edit')}
      </button>
      <button type="button" className="chat-menu-item" role="menuitem" disabled={!ready || paused} onClick={() => act('wake')}>
        <i className="fa-solid fa-bolt" aria-hidden="true" />
        {t('bots.menu.wake')}
      </button>
      <button type="button" className="chat-menu-item" role="menuitem" disabled={!ready} onClick={() => act(paused ? 'resume' : 'pause')}>
        <i className={`fa-solid ${paused ? 'fa-play' : 'fa-pause'}`} aria-hidden="true" />
        {paused ? t('bots.menu.resume') : t('bots.menu.pause')}
      </button>
      <button type="button" className="chat-menu-item" role="menuitem" disabled={!ready} title={t('bots.menu.resetTooltip')} onClick={() => act('reset')}>
        <i className="fa-solid fa-rotate-right" aria-hidden="true" />
        {t('bots.menu.reset')}
      </button>
      <div className="chat-menu-sep" />
      <button type="button" className="chat-menu-item danger" role="menuitem" disabled={!ready} onClick={() => { onPick(); onDialog('kill'); }}>
        <i className="fa-solid fa-skull" aria-hidden="true" />
        {t('bots.menu.kill')}
      </button>
      {found && !found.reachable && <div className="chat-menu-note">{t('bots.hostOffMenu')}</div>}
    </>
  );
}

/** Editing and killing open outside the menu, which has closed by then. */
export function BotChatDialogs({ chat, dialog, onClose, onError }: {
  chat: ChatRecord;
  dialog: 'edit' | 'kill' | null;
  onClose: () => void;
  onError: (message: string) => void;
}): JSX.Element | null {
  const { t } = useTranslation();
  const found = useBot(chat, dialog);
  if (!dialog || !found) return null;
  if (dialog === 'edit') {
    return (
      <BotForm
        hosts={found.hosts}
        editing={{ hostId: found.hostId, bot: found.bot }}
        onClose={onClose}
        onSaved={() => undefined}
      />
    );
  }
  return (
    <ConfirmDialog
      title={t('bots.killTitle', { name: found.bot.name })}
      message={t('bots.killConfirm', { name: found.bot.name })}
      confirmLabel={t('bots.menu.kill')}
      destructive
      onCancel={onClose}
      onConfirm={() => {
        onClose();
        void window.popbot.bots.kill(found.hostId, found.bot.id).then((res) => {
          if (!res.ok) onError(res.error);
        });
      }}
    />
  );
}

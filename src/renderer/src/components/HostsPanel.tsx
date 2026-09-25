/**
 * The Hosts tab: where chats run. This computer first, then every host
 * from Preferences ▸ Hosts — each with its repositories' slot pools (a
 * pip per slot, filled by the chat that holds it) and, for a host, the
 * chats that live there. A held slot or a chat row focuses the chat.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ChatRecord } from '@shared/persistence';
import { useTranslation } from '../lib/i18n';
import { Tooltip } from './Tooltip';
import { colAccentStyle } from '../lib/repoColor';

interface SlotView {
  slotId: number;
  chatId: string | null;
  chatName: string | null;
  branch: string | null;
}

interface PoolView {
  repoId: string;
  prefix: string;
  count: number;
  mode: 'slots' | 'ephemeral';
  color?: string;
  slots: SlotView[];
}

interface HostView {
  id: string;
  name: string;
  local: boolean;
  state: 'ok' | 'error' | 'local';
  error?: string;
  version?: string;
  pools: PoolView[];
  /** Open chats on this host (empty for this computer: the chat list has them). */
  chats: ChatRecord[];
  openCount: number;
}

const REFRESH_MS = 30_000;

export function HostsPanel({
  version,
  onFocusChat,
  onOpenPrefs,
}: {
  version: number;
  onFocusChat: (chatId: string) => void;
  onOpenPrefs?: (section?: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [views, setViews] = useState<HostView[] | null>(null);

  const load = useCallback(async (): Promise<HostView[]> => {
    const [chats, repos, hosts] = await Promise.all([
      window.popbot.chats.list(),
      window.popbot.repos.list(),
      window.popbot.hosts.list(),
    ]);
    const localPools: PoolView[] = repos
      .filter((r) => r.mode === 'slots' && r.slotCount > 0)
      .map((r) => {
        const slots: SlotView[] = [];
        for (let slotId = 1; slotId <= r.slotCount; slotId += 1) {
          const holder = chats.find((c) => !c.host && c.repoId === r.id && c.slotId === slotId) ?? null;
          slots.push({ slotId, chatId: holder?.id ?? null, chatName: holder?.name ?? null, branch: holder?.branch ?? null });
        }
        return { repoId: r.id, prefix: r.slotPrefix, count: r.slotCount, mode: 'slots', color: r.color, slots };
      });
    const local: HostView = {
      id: 'local',
      name: t('hosts.tab.local'),
      local: true,
      state: 'local',
      pools: localPools,
      chats: [],
      openCount: chats.filter((c) => !c.host && !c.cloud).length,
    };
    const remote = await Promise.all(hosts.map(async (h): Promise<HostView> => {
      const mine = chats.filter((c) => c.host?.hostId === h.id);
      const probe = await window.popbot.hosts.probe(h.url, h.token);
      if (!probe.ok) {
        return { id: h.id, name: h.name, local: false, state: 'error', error: probe.error, pools: [], chats: mine, openCount: mine.length };
      }
      const pools = await Promise.all(probe.info.repos.map(async (r): Promise<PoolView> => {
        const res = await window.popbot.hosts.slots(h.id, r.id);
        const slots: SlotView[] = res.ok
          ? res.slots.slots.map((sl) => ({
              slotId: sl.slotId,
              chatId: sl.chatId,
              chatName: sl.chatId ? (chats.find((c) => c.id === sl.chatId)?.name ?? sl.chatId) : null,
              branch: sl.branch,
            }))
          : [];
        return { repoId: r.id, prefix: r.slotPrefix, count: r.slotCount, mode: r.mode, slots };
      }));
      return { id: h.id, name: h.name, local: false, state: 'ok', version: probe.info.version, pools, chats: mine, openCount: mine.length };
    }));
    return [local, ...remote];
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    const run = (): void => {
      void load().then((v) => { if (!cancelled) setViews(v); }).catch(() => undefined);
    };
    run();
    const timer = setInterval(run, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [load, version]);

  if (!views) return <div className="row-empty"><p>{t('hosts.tab.loading')}</p></div>;

  return (
    <div className="hosts-panel">
      {views.map((h) => (
        <section key={h.id} className="hosts-host">
          <header className="hosts-host-head">
            <i className={`fa-solid ${h.local ? 'fa-laptop' : 'fa-server'}`} aria-hidden />
            <span className="hosts-host-name">{h.name}</span>
            {h.state === 'ok' && <span className="hosts-host-meta">{t('hosts.tab.meta', { version: h.version ?? '' })}</span>}
            {h.state === 'error' && (
              <span className="hosts-host-meta error" title={h.error}>{t('hosts.tab.unreachable')}</span>
            )}
            <span className="hosts-host-meta" style={{ marginLeft: 'auto' }}>{t('hosts.tab.openChats', { count: h.openCount })}</span>
          </header>
          {h.state !== 'error' && h.pools.length === 0 && (
            <div className="hosts-empty">{t('hosts.tab.noPools')}</div>
          )}
          {h.pools.map((pool) => {
            const letter = (pool.prefix[0] ?? 'S').toUpperCase();
            return (
              <div key={pool.repoId} className="hosts-pool" style={pool.color ? colAccentStyle(pool.color) : undefined}>
                <span className="hosts-pool-repo mono">{pool.repoId}</span>
                {pool.mode === 'ephemeral' ? (
                  <span className="hosts-pool-tag">{t('hosts.tab.ephemeral')}</span>
                ) : pool.count === 0 ? (
                  <span className="hosts-pool-tag">{t('hosts.tab.noSlots')}</span>
                ) : (
                  <span className="slot-strip-group">
                    {pool.slots.map((sl) => {
                      const occupied = sl.chatId != null;
                      const tip = (
                        <div className="tip-slot">
                          <div className="tip-slot-head">
                            <span className="mono">{pool.prefix}-{sl.slotId}</span>
                            <span className="tip-slot-repo"> · {pool.repoId}</span>
                          </div>
                          {occupied
                            ? <div className="tip-slot-chat">{sl.chatName}{sl.branch ? <span className="mono"> · {sl.branch}</span> : null}</div>
                            : <div className="tip-slot-state">{t('slots.strip.free')}</div>}
                        </div>
                      );
                      return (
                        <Tooltip key={sl.slotId} content={tip}>
                          <button
                            type="button"
                            className={`slot-pip ${occupied ? 'occupied' : 'empty'}`}
                            onClick={() => occupied && sl.chatId && onFocusChat(sl.chatId)}
                            disabled={!occupied}
                            aria-label={occupied
                              ? t('slots.strip.occupiedAria', { repo: pool.repoId, slotId: sl.slotId, chatName: sl.chatName ?? '' })
                              : t('slots.strip.freeAria', { repo: pool.repoId, slotId: sl.slotId })}
                          >{letter}{sl.slotId}</button>
                        </Tooltip>
                      );
                    })}
                  </span>
                )}
              </div>
            );
          })}
          {!h.local && h.chats.length > 0 && (
            <ul className="hosts-chats">
              {h.chats.map((c) => (
                <li key={c.id}>
                  <button type="button" className="hosts-chat" onClick={() => onFocusChat(c.id)}>
                    <span className={`hosts-chat-dot st-${c.status}`} aria-hidden />
                    <span className="hosts-chat-name">{c.name}</span>
                    {c.host?.slotId != null && (
                      <span className="hosts-chat-slot mono">{`${c.host.slotPrefix ?? c.host.repoId ?? 'slot'}-${c.host.slotId}`}</span>
                    )}
                    {c.host?.kind === 'root' && c.host.repoId && (
                      <span className="hosts-chat-slot mono">{c.host.repoId}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!h.local && h.state !== 'error' && h.chats.length === 0 && (
            <div className="hosts-empty">{t('hosts.tab.noChats')}</div>
          )}
        </section>
      ))}
      {views.length === 1 && (
        <div className="hosts-empty" style={{ padding: '10px 12px' }}>
          {t('hosts.tab.noHosts')}{' '}
          {onOpenPrefs && (
            <button type="button" className="btn-link" onClick={() => onOpenPrefs('hosts')}>
              {t('app.noSlots.openPreferences')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

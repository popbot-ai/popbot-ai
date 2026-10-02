/**
 * The Bots tab: every host's bots. A bot runs on its host whatever this
 * app is doing — clicking one opens its chat as a column, closing the
 * column only hides it. Pausing, waking and killing are on the row's
 * right-click menu; the pull requests a bot is watching show under it.
 */
import { useCallback, useEffect, useState } from 'react';
import type { BotHostListing } from '@shared/ipc';
import type { HostBotInfo } from '@shared/hostProtocol';
import { useTranslation } from '../lib/i18n';
import { BotForm } from './BotForm';
import { ConfirmDialog } from './ConfirmDialog';

/** How often the list asks again while it is showing. */
const POLL_MS = 15_000;

interface BotsListProps {
  /** Show the bot's chat as a column. */
  onOpen: (hostId: string, botId: string) => void;
  focusedChatId: string;
}

interface Menu {
  x: number;
  y: number;
  hostId: string;
  bot: HostBotInfo;
}

function ago(ts: number | null, now: number): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function triggerSummary(bot: HostBotInfo): string {
  return bot.triggers
    .map((t) => (t.kind === 'github' ? `${t.repo ?? bot.repoId ?? '?'} · ${t.labels.join(', ')}` : `⏱ ${t.schedule}`))
    .join('  ·  ');
}

export function BotsList({ onOpen, focusedChatId }: BotsListProps): JSX.Element {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<BotHostListing[] | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [form, setForm] = useState<{ editing?: { hostId: string; bot: HostBotInfo } } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<{ hostId: string; bot: HostBotInfo } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (fresh: boolean) => {
    const list = await window.popbot.bots.list(fresh);
    setHosts(list);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', close, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setMenu(null);
    const res = await fn();
    setError(res.ok ? null : res.error ?? null);
    await load(false);
  };

  const toggle = (key: string): void => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const anyHost = (hosts ?? []).length > 0;

  return (
    <div className="bots-list">
      {error && (
        <div className="bots-error" onClick={() => setError(null)} title={t('common.close')}>
          <i className="fa-solid fa-triangle-exclamation" /> {error}
        </div>
      )}
      {hosts === null && <div className="empty"><div>{t('common.loading')}</div></div>}
      {hosts !== null && !anyHost && (
        <div className="empty">
          <div className="ico">○</div>
          <div>{t('bots.noHosts')}</div>
        </div>
      )}
      {(hosts ?? []).map((h) => (
        <div className="list-section" key={h.hostId}>
          <div className="list-section-head">
            <i className={`fa-solid fa-server bots-host-icon ${h.reachable ? '' : 'off'}`} />
            {h.hostName}
            {!h.reachable && <span className="bots-host-off" title={h.error}>{t('bots.hostOff')}</span>}
            <span className="count">{h.bots.length}</span>
          </div>
          <div className="list-section-body">
            {h.bots.length === 0 && h.reachable && <div className="bots-none">{t('bots.none')}</div>}
            {h.bots.map((bot) => {
              const key = `${h.hostId}/${bot.id}`;
              const state = h.reachable ? bot.state : 'offline';
              const open = expanded.has(key);
              return (
                <div key={key}>
                  <div
                    className={`chat-row bot-row ${bot.chatId === focusedChatId ? 'focused' : ''} ${h.reachable ? '' : 'inactive'}`}
                    onClick={() => onOpen(h.hostId, bot.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, hostId: h.hostId, bot });
                    }}
                    title={bot.lastError ?? undefined}
                  >
                    <span className="bot-avatar" title={t(`bots.state.${state}`)}>
                      {bot.avatar ? <img src={bot.avatar} alt="" /> : <i className="fa-solid fa-robot" />}
                      <span className={`bot-dot ${state}`} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="name">{bot.name}</div>
                      <div className="meta-line">
                        <span className="pill muted">{t(`bots.state.${state}`)}</span>
                        {bot.githubLogin && <span className="bot-login">@{bot.githubLogin}</span>}
                        <span style={{ flex: 1 }} />
                        {bot.watching.length > 0 && (
                          <button
                            className="bot-watching"
                            onClick={(e) => { e.stopPropagation(); toggle(key); }}
                            title={t('bots.watchingTooltip')}
                          >
                            {t('bots.watching', { count: bot.watching.length })} {open ? '▾' : '▸'}
                          </button>
                        )}
                        <span className="timestamp" title={t('bots.lastLook')}>{ago(bot.lastPollAt, now)}</span>
                      </div>
                      {bot.triggers.length > 0 && <div className="bot-triggers-line">{triggerSummary(bot)}</div>}
                      {bot.lastError && h.reachable && <div className="bot-error-line">{bot.lastError}</div>}
                    </div>
                  </div>
                  {open && (
                    <div className="bot-prs">
                      {bot.watching.map((pr) => (
                        <a
                          key={`${pr.repo}#${pr.number}`}
                          className="bot-pr"
                          href={pr.url}
                          target="_blank"
                          rel="noreferrer"
                          title={`${pr.repo} · @${pr.author}`}
                        >
                          <span className="bot-pr-num">#{pr.number}</span>
                          <span className="bot-pr-title">{pr.title}</span>
                          <span className={`bot-pr-ci ${pr.ci.toLowerCase()}`}>{pr.ci === 'NONE' ? '' : pr.ci.toLowerCase()}</span>
                          {pr.decision !== 'NONE' && <span className="bot-pr-decision">{pr.decision.toLowerCase().replace(/_/g, ' ')}</span>}
                          {pr.mergeable === 'CONFLICTING' && <span className="bot-pr-conflict">{t('bots.conflicts')}</span>}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {anyHost && (
        <div className="bots-new">
          <button className="btn sm" onClick={() => setForm({})} disabled={!(hosts ?? []).some((h) => h.reachable)}>
            <i className="fa-solid fa-plus" /> {t('bots.new')}
          </button>
        </div>
      )}
      {menu && (
        <div className="git-context-menu work-item-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="work-item-menu-head" title={menu.bot.name}>{menu.bot.name}</div>
          <button className="git-menu-item" onClick={() => { setMenu(null); onOpen(menu.hostId, menu.bot.id); }}>
            <i className="fa-regular fa-comment" /> {t('bots.menu.open')}
          </button>
          <button className="git-menu-item" onClick={() => { setForm({ editing: { hostId: menu.hostId, bot: menu.bot } }); setMenu(null); }}>
            <i className="fa-solid fa-pen" /> {t('bots.menu.edit')}
          </button>
          <button className="git-menu-item" onClick={() => void act(() => window.popbot.bots.action(menu.hostId, menu.bot.id, 'wake'))}>
            <i className="fa-solid fa-bolt" /> {t('bots.menu.wake')}
          </button>
          <button className="git-menu-item" title={t('bots.menu.resetTooltip')} onClick={() => void act(() => window.popbot.bots.action(menu.hostId, menu.bot.id, 'reset'))}>
            <i className="fa-solid fa-rotate-right" /> {t('bots.menu.reset')}
          </button>
          <button
            className="git-menu-item"
            onClick={() => void act(() => window.popbot.bots.action(menu.hostId, menu.bot.id, menu.bot.state === 'paused' ? 'resume' : 'pause'))}
          >
            <i className={`fa-solid ${menu.bot.state === 'paused' ? 'fa-play' : 'fa-pause'}`} />{' '}
            {menu.bot.state === 'paused' ? t('bots.menu.resume') : t('bots.menu.pause')}
          </button>
          <button
            className="git-menu-item danger"
            onClick={() => {
              setKilling({ hostId: menu.hostId, bot: menu.bot });
              setMenu(null);
            }}
          >
            <i className="fa-solid fa-skull" /> {t('bots.menu.kill')}
          </button>
        </div>
      )}
      {killing && (
        <ConfirmDialog
          title={t('bots.killTitle', { name: killing.bot.name })}
          message={t('bots.killConfirm', { name: killing.bot.name })}
          confirmLabel={t('bots.menu.kill')}
          destructive
          onCancel={() => setKilling(null)}
          onConfirm={() => {
            const target = killing;
            setKilling(null);
            void act(() => window.popbot.bots.kill(target.hostId, target.bot.id));
          }}
        />
      )}
      {form && (
        <BotForm
          hosts={hosts ?? []}
          editing={form.editing}
          onClose={() => setForm(null)}
          onSaved={() => void load(false)}
        />
      )}
    </div>
  );
}

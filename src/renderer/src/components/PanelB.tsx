import { useEffect, useState } from 'react';
import { colAccentStyle } from '../lib/repoColor';
import type { ChatRecord } from '@shared/persistence';
import type { SourceControlProviderId } from '@shared/sourceControl';
import { tokenBarClass, tokenBarPct, type Chat } from '../fixtures/data';
import { SlotStatusStrip } from './SlotStatusStrip';
import { P4Glyph } from './P4Glyph';
import { useTranslation } from '../lib/i18n';

/** Per-row version-control icon (replaces the old status glyph — status is
 *  already conveyed by the row's color/animation; the VCS is more useful at a
 *  glance, e.g. for archived chats). Branch icon for git, the P4 glyph for
 *  Perforce. No color set — it inherits the glyph's text color (the filled
 *  circle's contrasting fg), same as the old status character. */
function ScmGlyph({ scm }: { scm?: SourceControlProviderId | null }): JSX.Element {
  if (scm === 'perforce') {
    return <P4Glyph />;
  }
  return <i className="fa-solid fa-code-branch scm-mark-git" />;
}

/** Tiny kind chip — at-a-glance "what kind of chat is this?" Goes
 *  before the branch in the row's meta-line. */
function ChatKindChip({ chat }: { chat: Chat }): JSX.Element | null {
  const { t } = useTranslation();
  if (chat.pr) {
    return <span className="pill done" title={t('panelB.kind.prTooltip', { pr: chat.pr })}>{t('panelB.kind.pr', { pr: chat.pr })}</span>;
  }
  if (chat.ticket) {
    return <span className="pill run" title={t('panelB.kind.ticketTooltip', { ticket: chat.ticket })}>{t('panelB.kind.ticket')}</span>;
  }
  if (chat.type === 'client_test') {
    return <span className="pill wait" title={t('panelB.kind.clientTestTooltip')}>{t('panelB.kind.clientTest')}</span>;
  }
  if (chat.type === 'server_test') {
    return <span className="pill wait" title={t('panelB.kind.serverTestTooltip')}>{t('panelB.kind.serverTest')}</span>;
  }
  return <span className="pill muted" title={t('panelB.kind.plainTooltip')}>{t('panelB.kind.plain')}</span>;
}

interface ChatRowProps {
  chat: Chat;
  focused?: boolean;
  inactive?: boolean;
  removing?: boolean;
  onClick?: () => void;
  onDelete?: () => void;
}

function ChatRow({ chat, focused, inactive, removing, onClick, onDelete }: ChatRowProps): JSX.Element {
  const { t } = useTranslation();
  const tokens = chat.tokens;
  const tokenPct = tokens ? tokenBarPct(tokens.used) : 0;
  return (
    <div
      className={`chat-row ${focused ? 'focused' : ''} ${inactive ? 'inactive' : ''} ${removing ? 'removing' : ''}`}
      onClick={onClick}
      // Per-row accent: drives the top-edge color bar (`::after`) and
      // the left-edge focused indicator (`::before`) in this chat's
      // repo color, plus the perceptual fg pair. Falls back to the
      // global apple-blue accent when repoColor is unset; the top
      // bar simply doesn't render in that case.
      style={colAccentStyle(chat.repoColor)}
    >
      <span className={`status-glyph scm-glyph status-${chat.status}`}>
        <ScmGlyph scm={chat.scm} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="name">{chat.name}</div>
        <div className="meta-line">
          <ChatKindChip chat={chat} />
          {chat.slotId != null && (
            <span className="pill muted" title={t('panelB.slotTooltip', { slotId: chat.slotId })}>
              S{chat.slotId}
            </span>
          )}
          <span className="branch" title={chat.branch}>⎇ {chat.branch}</span>
          <span style={{ flex: 1 }} />
          <span className="timestamp">{chat.timestamp}</span>
        </div>
        {tokens && (
          <div className={`token-bar ${tokenBarClass(tokens.used, tokens.budget)}`}>
            <i style={{ width: tokenPct + '%' }} />
          </div>
        )}
      </div>
      {onDelete && (
        <button
          className="chat-row-delete"
          title={t('panelB.deleteChatTooltip')}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <i className="fa-regular fa-trash-can" />
        </button>
      )}
    </div>
  );
}

interface DeleteConfirmProps {
  chat: Chat;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteConfirm({ chat, onConfirm, onCancel }: DeleteConfirmProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <div className="scrim" onClick={onCancel} />
      <div className="modal" data-screen-label="Modal · delete-chat">
        <div className="modal-head">
          <h2>{t('panelB.delete.title')}</h2>
          <div className="sub">{t('panelB.delete.sub')}</div>
        </div>
        <div className="modal-body">
          {t('panelB.delete.body')}
          <br /><br />
          <b>{chat.name}</b>
          {chat.branch && chat.branch !== '(no branch)' && (
            <>
              <br />
              <code>⎇ {chat.branch}</code>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="btn danger" onClick={onConfirm}>{t('panelB.delete.confirm')}</button>
        </div>
      </div>
    </>
  );
}

interface PanelBProps {
  chats: Chat[];
  inactive: Chat[];
  focusedId: string;
  setFocusedId: (id: string) => void;
  onOpenInactive?: (id: string) => void;
  onDelete?: (id: string) => void;
  onNewChat?: () => void;
  /** Bumps when chats open/close so the slot status strip refreshes. */
  slotVersion?: number;
  /** Opens Preferences → Runtime for first-time slot setup. */
  onSetupSlots?: () => void;
  /** Adapter for ChatRecord → ChatFixture so search results render via
   *  the same ChatRow as the regular lists. */
  toFixture: (r: ChatRecord) => Chat;
}

const REMOVE_ANIM_MS = 220;

export function PanelB({
  chats,
  inactive,
  focusedId,
  setFocusedId,
  onOpenInactive,
  onDelete,
  onNewChat,
  slotVersion = 0,
  onSetupSlots,
  toFixture,
}: PanelBProps): JSX.Element {
  const { t } = useTranslation();
  const [openActive, setOpenActive] = useState(true);
  const [openInactive, setOpenInactive] = useState(true);
  const [inactiveLimit, setInactiveLimit] = useState(25);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatRecord[]>([]);
  const [removingIds, setRemovingIds] = useState<Set<string>>(() => new Set());
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  /** Mark the row as collapsing, then call the parent's delete after the
   *  CSS transition so the user sees it disappear. */
  const animateDelete = onDelete
    ? (id: string) => {
        setRemovingIds((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        setTimeout(() => {
          onDelete(id);
          setRemovingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }, REMOVE_ANIM_MS);
      }
    : undefined;

  /** Trash icon click → opens the confirm modal. */
  const requestDelete = onDelete ? (id: string) => setPendingDeleteId(id) : undefined;

  // Debounced search — wait 150ms after typing stops to fire the IPC.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void window.popbot.chats.search(q, 50).then((rows) => {
        if (!cancelled) setResults(rows);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const isSearching = query.trim().length > 0;
  const openIds = new Set(chats.map((c) => c.id));
  const searchResults = results.map(toFixture);

  return (
    <div className="panel-b" data-screen-label="Panel B · Chat List">
      <SlotStatusStrip
        version={slotVersion}
        onClickOccupant={(id) => setFocusedId(id)}
        onSetupSlots={onSetupSlots}
      />
      <div className="panel-b-search">
        <i className="fa-solid fa-magnifying-glass" />
        <input
          type="text"
          placeholder={t('panelB.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {isSearching && (
          <button
            className="panel-b-search-clear"
            onClick={() => setQuery('')}
            title={t('panelB.clearSearchTooltip')}
          >
            ×
          </button>
        )}
      </div>

      <div className="panel-b-scroll">
      {isSearching ? (
        <div className="list-section">
          <div className="list-section-head">
            <span className="caret">▼</span>
            {t('panelB.results')}
            <span className="count">{searchResults.length}</span>
          </div>
          <div className="list-section-body">
            {searchResults.length === 0 ? (
              <div className="empty">
                <div>{t('panelB.noMatches')}</div>
              </div>
            ) : (
              searchResults.map((c) => {
                const isOpen = openIds.has(c.id);
                return (
                  <ChatRow
                    key={c.id}
                    chat={c}
                    focused={c.id === focusedId}
                    inactive={!isOpen}
                    onClick={() => (isOpen ? setFocusedId(c.id) : onOpenInactive?.(c.id))}
                    removing={removingIds.has(c.id)}
                    onDelete={requestDelete ? () => requestDelete(c.id) : undefined}
                  />
                );
              })
            )}
          </div>
        </div>
      ) : null}
      {!isSearching && (
        <div className={`list-section ${openActive ? '' : 'collapsed'}`}>
          <div className="list-section-head" onClick={() => setOpenActive((v) => !v)}>
            <span className="caret">▼</span>
            {t('panelB.active')}
            <span className="count">{chats.length}</span>
          </div>
          <div className="list-section-body">
            {chats.map((c) => (
              <ChatRow
                key={c.id}
                chat={c}
                focused={c.id === focusedId}
                onClick={() => setFocusedId(c.id)}
                removing={removingIds.has(c.id)}
                onDelete={requestDelete ? () => requestDelete(c.id) : undefined}
              />
            ))}
            {chats.length === 0 && (
              <div className="empty">
                <div className="ico">○</div>
                <div>{t('panelB.noActiveChats')}</div>
                <button className="btn primary sm" onClick={onNewChat}>{t('panelB.newChat')}</button>
              </div>
            )}
          </div>
        </div>
      )}
      {!isSearching && inactive.length > 0 && (
        <div className={`list-section ${openInactive ? '' : 'collapsed'}`}>
          <div className="list-section-head" onClick={() => setOpenInactive((v) => !v)}>
            <span className="caret">▼</span>
            {t('panelB.inactive')}
            <span className="count">{inactive.length}</span>
          </div>
          <div className="list-section-body">
            {inactive.slice(0, inactiveLimit).map((c) => (
              <ChatRow
                key={c.id}
                chat={c}
                inactive
                onClick={() => onOpenInactive?.(c.id)}
                removing={removingIds.has(c.id)}
                onDelete={requestDelete ? () => requestDelete(c.id) : undefined}
              />
            ))}
            {inactive.length > inactiveLimit && (
              <button
                className="show-more"
                onClick={() => setInactiveLimit((n) => n + 25)}
              >
                {t('panelB.showMore', { count: Math.min(25, inactive.length - inactiveLimit) })}
              </button>
            )}
          </div>
        </div>
      )}
      </div>
      {pendingDeleteId && (() => {
        const all = [...chats, ...inactive, ...searchResults];
        const target = all.find((c) => c.id === pendingDeleteId);
        if (!target) {
          setPendingDeleteId(null);
          return null;
        }
        return (
          <DeleteConfirm
            chat={target}
            onCancel={() => setPendingDeleteId(null)}
            onConfirm={() => {
              setPendingDeleteId(null);
              animateDelete?.(target.id);
            }}
          />
        );
      })()}
    </div>
  );
}

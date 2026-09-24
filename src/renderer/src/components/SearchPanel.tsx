/**
 * Search every chat's transcript — open and archived — and jump to a hit.
 *
 * Backed by the FTS index (main's `chats.searchTranscripts`): a fragment
 * of a name, identifier or error message is enough. Hits arrive best
 * first and are shown grouped by chat in that order, each with the text
 * around the match; "Go to" (or clicking the line) hands the hit to App,
 * which focuses the chat — reopening it from the archive if it has to —
 * and scrolls its transcript to that message.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TranscriptSearchHit } from '@shared/ipc';
import { useTranslation } from '../lib/i18n';

interface SearchPanelProps {
  onClose: () => void;
  onGoTo: (hit: TranscriptSearchHit) => void;
}

const MIN_CHARS = 3;
const PER_CHAT = 5;
const MAX_HITS = 80;

interface ChatGroup {
  chatId: string;
  chatName: string;
  closed: boolean;
  hits: TranscriptSearchHit[];
}

/** One line of context: whitespace collapsed so a hit inside a diff or a
 *  JSON blob still reads as a line. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ');

function fmtAge(ts: number, t: (k: 'time.secondsAgo' | 'time.minutesAgo' | 'time.hoursAgo' | 'time.daysAgo', v: { count: number }) => string): string {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return t('time.secondsAgo', { count: Math.floor(d) });
  if (d < 3600) return t('time.minutesAgo', { count: Math.floor(d / 60) });
  if (d < 86400) return t('time.hoursAgo', { count: Math.floor(d / 3600) });
  return t('time.daysAgo', { count: Math.floor(d / 86400) });
}

export function SearchPanel({ onClose, onGoTo }: SearchPanelProps): JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TranscriptSearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  // Debounced: the index answers in milliseconds, the IPC hop and the
  // re-render are what a keystroke-per-query would waste.
  useEffect(() => {
    const q = query.trim();
    setError(null);
    if (q.length < MIN_CHARS) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void window.popbot.chats
        .searchTranscripts(q, { includeClosed: true, maxResults: MAX_HITS, contextChars: 110 })
        .then((res) => {
          if (cancelled) return;
          if (res.ok) setHits(res.hits);
          else { setHits([]); setError(res.error); }
        })
        .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);

  // Group by chat in first-seen order: hits are ranked, so the first
  // chat is the one with the best match.
  const groups = useMemo((): ChatGroup[] => {
    const byChat = new Map<string, ChatGroup>();
    for (const h of hits) {
      let g = byChat.get(h.chatId);
      if (!g) {
        g = { chatId: h.chatId, chatName: h.chatName, closed: h.closed, hits: [] };
        byChat.set(h.chatId, g);
      }
      g.hits.push(h);
    }
    return [...byChat.values()];
  }, [hits]);

  const go = (hit: TranscriptSearchHit): void => {
    onGoTo(hit);
    onClose();
  };

  const q = query.trim();
  const tooShort = q.length > 0 && q.length < MIN_CHARS;
  const nothing = q.length >= MIN_CHARS && !searching && !error && hits.length === 0;

  return createPortal(
    <div className="confirm-scrim work-item-search-scrim" onMouseDown={onClose}>
      <div
        className="confirm-dialog work-item-search search-panel"
        role="dialog"
        aria-label={t('search.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">
          <i className="fa-solid fa-magnifying-glass" aria-hidden /> {t('search.title')}
        </div>
        <div className="confirm-body" style={{ paddingBottom: 6 }}>
          <input
            className="pref-input mono narrow"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'Enter' && hits.length > 0) go(hits[0]);
            }}
            style={{ width: '100%' }}
            spellCheck={false}
            autoFocus
          />
          <div className="search-panel-results">
            {groups.map((g) => (
              <div className="work-item-search-group" key={g.chatId}>
                <button
                  type="button"
                  className="work-item-search-head search-panel-chat"
                  onClick={() => go(g.hits[0])}
                  title={t('search.goTo')}
                >
                  <i className="fa-solid fa-comments" aria-hidden />
                  <span className="search-panel-chat-name">{g.chatName}</span>
                  {g.closed && <span className="search-panel-tag">{t('search.archived')}</span>}
                  <span className="search-panel-count">{g.hits.length}</span>
                </button>
                {g.hits.slice(0, PER_CHAT).map((h) => (
                  <div className="work-item-search-row search-panel-hit" key={`${h.messageId}:${h.offset}`} onClick={() => go(h)}>
                    <span className={`search-panel-role role-${h.role}`}>{h.role}</span>
                    <span className="search-panel-snippet">
                      {oneLine(h.before)}
                      <mark>{h.match}</mark>
                      {oneLine(h.after)}
                    </span>
                    <span className="work-item-search-row-hint">{fmtAge(h.ts, t)}</span>
                    <button
                      type="button"
                      className="btn sm search-panel-go"
                      onClick={(e) => { e.stopPropagation(); go(h); }}
                    >
                      {t('search.goTo')} <i className="fa-solid fa-arrow-right" aria-hidden />
                    </button>
                  </div>
                ))}
                {g.hits.length > PER_CHAT && (
                  <div className="search-panel-more">{t('search.more', { count: g.hits.length - PER_CHAT })}</div>
                )}
              </div>
            ))}
            {tooShort && <div className="search-panel-note">{t('search.tooShort')}</div>}
            {nothing && <div className="search-panel-note">{t('search.noResults')}</div>}
            {error && <div className="pref-error" style={{ marginTop: 10 }}>{error}</div>}
          </div>
        </div>
        <div className="confirm-foot">
          <span className="search-panel-keys">{t('search.hint')}</span>
          <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

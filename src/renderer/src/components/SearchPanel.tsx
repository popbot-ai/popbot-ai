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
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatRefs, TranscriptSearchHit } from '@shared/ipc';
import { SEARCH_TAGS, parseSearchQuery } from '@shared/searchQuery';
import type { MessageKey } from '@shared/i18n';
import { useTranslation } from '../lib/i18n';

interface SearchPanelProps {
  onClose: () => void;
  onGoTo: (hit: TranscriptSearchHit) => void;
}

const MIN_CHARS = 3;
const PER_CHAT = 5;
const MAX_HITS = 80;

/** Tooltip per tag button, by the value it inserts. */
const TAG_HINT: Record<(typeof SEARCH_TAGS)[number]['value'], MessageKey> = {
  'ticket:': 'search.tag.ticket',
  'cr:': 'search.tag.cr',
  'last:week': 'search.tag.lastWeek',
  'last:month': 'search.tag.lastMonth',
  'from:user': 'search.tag.fromUser',
  'from:agent': 'search.tag.fromAgent',
  'from:tool': 'search.tag.fromTool',
  'tool:': 'search.tag.tool',
  'agent:codex': 'search.tag.agent',
  'in:archive': 'search.tag.inArchive',
  'chat:': 'search.tag.chat',
};

/** A completion for the `ticket:` / `cr:` / `chat:` value being typed. */
interface Suggestion {
  /** What goes into the box after the key, e.g. ENG-123 or "login bug". */
  insert: string;
  label: string;
  detail: string;
  closed: boolean;
}

/** The `key:partial` token at the end of the query (the one being
 *  typed), when it is one we can complete. */
function completableToken(query: string): { start: number; key: 'ticket' | 'cr' | 'chat'; partial: string } | null {
  const m = /(^|\s)(ticket|cr|pr|chat):("?)([^"]*)$/i.exec(query);
  if (!m) return null;
  const partial = m[4];
  // Unquoted values end at a space — a space means the user moved on.
  if (!m[3] && /\s/.test(partial)) return null;
  const key = m[2].toLowerCase() === 'pr' ? 'cr' : (m[2].toLowerCase() as 'ticket' | 'cr' | 'chat');
  return { start: m.index + m[1].length, key, partial: partial.toLowerCase() };
}

function suggestionsFor(refs: ChatRefs | null, token: ReturnType<typeof completableToken>): Suggestion[] {
  if (!refs || !token) return [];
  const p = token.partial;
  const has = (s: string): boolean => s.toLowerCase().includes(p);
  const starts = (s: string): boolean => s.toLowerCase().startsWith(p);
  let out: Suggestion[];
  if (token.key === 'ticket') {
    out = refs.tickets
      .filter((t) => !p || has(t.key) || has(t.chatName))
      .sort((a, b) => Number(starts(b.key)) - Number(starts(a.key)))
      .map((t) => ({ insert: t.key, label: t.key, detail: t.chatName, closed: t.closed }));
  } else if (token.key === 'cr') {
    out = refs.prs
      .filter((r) => !p || starts(String(r.number)) || has(r.chatName))
      .map((r) => ({ insert: String(r.number), label: `#${r.number}`, detail: r.chatName, closed: r.closed }));
  } else {
    out = refs.chats
      .filter((c) => !p || has(c.name))
      .map((c) => ({ insert: `"${c.name.replace(/"/g, '')}"`, label: c.name, detail: '', closed: c.closed }));
  }
  return out.slice(0, 7);
}

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
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Complete filters chosen with the buttons (last:week, from:user, …).
  // They ride along with the search without appearing in the box; only
  // prefixes that need a value (ticket:, cr:, tool:, chat:) go into it.
  const [chips, setChips] = useState<string[]>([]);
  // Autocomplete for ticket: / cr: / chat: values, from the chats we know.
  const [refs, setRefs] = useState<ChatRefs | null>(null);
  const [suggestIdx, setSuggestIdx] = useState(0);
  useEffect(() => {
    void window.popbot.chats.listRefs().then(setRefs).catch(() => setRefs(null));
  }, []);
  const token = useMemo(() => completableToken(query), [query]);
  const suggestions = useMemo(() => suggestionsFor(refs, token), [refs, token]);
  useEffect(() => { setSuggestIdx(0); }, [query]);

  /** Put the suggestion into the box in place of the partial value. */
  const accept = (s: Suggestion): void => {
    if (!token) return;
    const next = `${query.slice(0, token.start)}${token.key}:${s.insert} `;
    setQuery(next);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(next.length, next.length);
    });
  };

  // The search as the parser reads it: chips plus what's typed. The
  // "enough to search" rule is on the text part only (tags alone list
  // the newest matching entries).
  const effectiveQuery = useMemo(() => [...chips, query.trim()].filter(Boolean).join(' '), [chips, query]);
  const parsed = useMemo(() => parseSearchQuery(effectiveQuery), [effectiveQuery]);
  const canSearch = parsed.text.length >= MIN_CHARS || (parsed.hasFilters && parsed.text.length === 0);

  const tagKey = (value: string): string => value.slice(0, value.indexOf(':'));
  const typedHas = (value: string): boolean =>
    new RegExp(`(^|\\s)${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(query);

  /** A tag button. Prefix (ends with ':'): insert it into the box with
   *  the caret after it, for the value to be typed. Complete: toggle it
   *  as a chip — one per key, except `from:` which adds up. */
  const clickTag = (value: string): void => {
    if (value.endsWith(':')) {
      const base = query.trimEnd();
      const next = (base ? `${base} ` : '') + value;
      setQuery(next);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(next.length, next.length);
      });
      return;
    }
    setChips((prev) => {
      if (prev.includes(value)) return prev.filter((c) => c !== value);
      const key = tagKey(value);
      const kept = key === 'from' ? prev : prev.filter((c) => tagKey(c) !== key);
      return [...kept, value];
    });
    inputRef.current?.focus();
  };

  // Debounced: the index answers in milliseconds, the IPC hop and the
  // re-render are what a keystroke-per-query would waste.
  useEffect(() => {
    setError(null);
    if (!canSearch) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void window.popbot.chats
        .searchTranscripts(effectiveQuery, { includeClosed: true, maxResults: MAX_HITS, contextChars: 220 })
        .then((res) => {
          if (cancelled) return;
          if (res.ok) setHits(res.hits);
          else { setHits([]); setError(res.error); }
        })
        .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [effectiveQuery, canSearch]);

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

  const tooShort = effectiveQuery.length > 0 && !canSearch;
  const nothing = canSearch && !searching && !error && hits.length === 0;
  const tagsOnly = canSearch && parsed.text.length === 0 && hits.length > 0;

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
          <div className="search-panel-input-wrap">
          <input
            ref={inputRef}
            className="pref-input mono narrow"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (suggestions.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && token && token.partial.length > 0))) {
                e.preventDefault();
                accept(suggestions[Math.min(suggestIdx, suggestions.length - 1)]);
              } else if (suggestions.length > 0 && e.key === 'ArrowDown') {
                e.preventDefault();
                setSuggestIdx((i) => (i + 1) % suggestions.length);
              } else if (suggestions.length > 0 && e.key === 'ArrowUp') {
                e.preventDefault();
                setSuggestIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
              } else if (e.key === 'Escape') onClose();
              else if (e.key === 'Enter' && hits.length > 0) go(hits[0]);
            }}
            style={{ width: '100%' }}
            spellCheck={false}
            autoFocus
          />
          {suggestions.length > 0 && (
            <div className="search-panel-suggest" role="listbox">
              {suggestions.map((s, i) => (
                <button
                  type="button"
                  key={`${token?.key}:${s.insert}`}
                  role="option"
                  aria-selected={i === suggestIdx}
                  className={`search-panel-suggest-row${i === suggestIdx ? ' active' : ''}`}
                  onMouseEnter={() => setSuggestIdx(i)}
                  onMouseDown={(e) => { e.preventDefault(); accept(s); }}
                >
                  <span className="mono">{s.label}</span>
                  {s.detail && <span className="search-panel-suggest-detail">{s.detail}</span>}
                  {s.closed && <span className="search-panel-tag">{t('search.archived')}</span>}
                </button>
              ))}
            </div>
          )}
          </div>
          {/* Filter tags: a click inserts the tag — complete ones such as
              last:week as they are, prefixes such as ticket: for the value
              to be typed. Lit while the query carries that tag. */}
          <div className="search-panel-tags" role="toolbar" aria-label={t('search.tagsLabel')}>
            {SEARCH_TAGS.map((tag) => {
              const prefix = tag.value.endsWith(':');
              const active = prefix ? typedHas(tag.value) : chips.includes(tag.value) || typedHas(tag.value);
              return (
                <button
                  type="button"
                  key={tag.value}
                  className={`search-panel-tag-btn${active ? ' active' : ''}${prefix ? ' prefix' : ''}`}
                  title={t(TAG_HINT[tag.value])}
                  onClick={() => clickTag(tag.value)}
                >
                  {prefix ? `${tag.value}…` : tag.value.slice(tag.value.indexOf(':') + 1)}
                </button>
              );
            })}
          </div>
          {tagsOnly && <div className="search-panel-note" style={{ paddingTop: 6 }}>{t('search.tagsOnly')}</div>}
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
          <span className="search-panel-keys">{suggestions.length > 0 ? t('search.hintSuggest') : t('search.hint')}</span>
          <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

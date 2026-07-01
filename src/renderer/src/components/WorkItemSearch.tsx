/**
 * Shared "find or add" picker for tickets, PRs, and chats. Mounts as
 * a modal from PanelA's `+` button (pin / focus) and inline from the
 * Cmd-K new-chat dialog (spawn from ticket/PR).
 *
 * Inputs:
 *   - knownTickets / knownPrs: currently surfaced in the panel (the
 *     merged pinned-plus-auto list). Matches against these are
 *     "already in your list — click to act"; non-matches that parse
 *     as ENG-12345 / PR #1234 surface a "Pin new …" row that fetches
 *     and pins on click.
 *   - The component runs `chats.search` against the user's open +
 *     closed chats so an existing chat can be reopened/focused
 *     without sifting through the list.
 *
 * The three result groups render side by side under a single text
 * input so the user can decide between "open my existing chat" vs
 * "spawn a new one" without bouncing dialogs.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LinearIssueDto } from '@shared/linear';
import type { ReviewItem, ReviewSystem } from '@shared/reviews';
import type { ChatRecord } from '@shared/persistence';
import { LinearStateIcon } from '../lib/linearIcons';
import { useTranslation } from '../lib/i18n';

interface WorkItemSearchProps {
  title?: string;
  onCancel: () => void;
  /** Currently-surfaced tickets in the panel (pinned + auto). The
   *  picker shows in-list matches inline so the user doesn't try to
   *  pin something already visible. */
  knownTickets: LinearIssueDto[];
  knownPrs: ReviewItem[];
  /** Pin-new actions for items not currently in the panel. The
   *  parent decides what `pin` means (PanelA: persist; new-chat:
   *  pin + spawn). */
  onPinTicket: (id: string) => Promise<{ ok: true } | { ok: false; reason: string; error?: string }>;
  onPinPr: (n: number, system?: ReviewSystem) => Promise<{ ok: true } | { ok: false; reason: string; error?: string }>;
  /** Click on a known ticket/PR (the user wants to act on it). The
   *  parent may focus its chat, scroll to it in the list, or spawn
   *  a new chat — picker is policy-free. */
  onSelectTicket?: (issue: LinearIssueDto) => void;
  onSelectPr?: (pr: ReviewItem) => void;
  /** Click on a chat-search match. Typically reopens-and-focuses. */
  onSelectChat?: (chat: ChatRecord) => void;
}

type FreeForm =
  | { kind: 'ticket'; identifier: string }
  | { kind: 'pr'; number: number; system: ReviewSystem }
  | null;

/** Parse the user's query for a free-form ticket id / review number that
 *  doesn't match anything already in the lists. Returns the parsed
 *  form when the query unambiguously names one. A `swarm`/`sw`/`review`
 *  prefix (e.g. "swarm 27", "sw#27") names a Helix Swarm review BY REVIEW ID
 *  (the /reviews/<id> path — NOT a changelist number); a bare number or
 *  `PR #123` names a GitHub PR. */
function parseFreeForm(raw: string): FreeForm {
  const s = raw.trim();
  if (!s) return null;
  const tm = /^([A-Z]{2,5})-(\d+)$/i.exec(s);
  if (tm) return { kind: 'ticket', identifier: `${tm[1].toUpperCase()}-${tm[2]}` };
  const sm = /^(?:swarm|sw|review)\s*#?\s*(\d+)$/i.exec(s);
  if (sm) return { kind: 'pr', number: Number(sm[1]), system: 'swarm' };
  const pm = /^(?:PR\s*)?#?\s*(\d+)$/i.exec(s);
  if (pm) return { kind: 'pr', number: Number(pm[1]), system: 'github' };
  return null;
}

/** Filter + dedupe by identifier — the caller passes a UNION of
 *  (assigned + pinned + recent-team) which can repeat the same issue
 *  multiple times. First-seen wins so the assigned/pinned copy
 *  (which appears earlier in the union) takes precedence over a
 *  duplicate from the recent-team pull. */
function filterTickets(tickets: LinearIssueDto[], q: string): LinearIssueDto[] {
  if (!q) return [];
  const needle = q.toLowerCase();
  const seen = new Set<string>();
  const out: LinearIssueDto[] = [];
  for (const t of tickets) {
    if (seen.has(t.identifier)) continue;
    if (
      t.identifier.toLowerCase().includes(needle)
      || t.title.toLowerCase().includes(needle)
    ) {
      seen.add(t.identifier);
      out.push(t);
      if (out.length >= 8) break;
    }
  }
  return out;
}

function filterPrs(prs: ReviewItem[], q: string): ReviewItem[] {
  if (!q) return [];
  const needle = q.toLowerCase();
  const asNumber = /^(?:pr\s*)?#?\s*(\d+)$/i.exec(q);
  const seen = new Set<number>();
  const out: ReviewItem[] = [];
  for (const p of prs) {
    if (seen.has(p.number)) continue;
    if (
      p.title.toLowerCase().includes(needle)
      || (asNumber ? p.number === Number(asNumber[1]) : false)
    ) {
      seen.add(p.number);
      out.push(p);
      if (out.length >= 8) break;
    }
  }
  return out;
}

export function WorkItemSearch({
  title,
  onCancel,
  knownTickets,
  knownPrs,
  onPinTicket,
  onPinPr,
  onSelectTicket,
  onSelectPr,
  onSelectChat,
}: WorkItemSearchProps): JSX.Element {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('work.title');
  const [query, setQuery] = useState('');
  const [chatHits, setChatHits] = useState<ChatRecord[]>([]);
  const [busyKind, setBusyKind] = useState<'ticket' | 'pr' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Debounce chat search — fires after the user stops typing. 250ms
  // strikes a balance between feeling instant and not hammering the
  // SQLite LIKE scan on every keystroke.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setChatHits([]); return; }
    const t = setTimeout(() => {
      void window.popbot.chats.search(q, 8).then(setChatHits).catch(() => setChatHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const ticketHits = useMemo(() => filterTickets(knownTickets, query), [knownTickets, query]);
  const prHits = useMemo(() => filterPrs(knownPrs, query), [knownPrs, query]);
  const freeForm = useMemo(() => {
    const ff = parseFreeForm(query);
    if (!ff) return null;
    // Hide the "pin new" row when the item is already in the list —
    // the existing row already shows up under "Tickets" / "PRs".
    if (ff.kind === 'ticket' && knownTickets.some((t) => t.identifier === ff.identifier)) return null;
    // Match on system + number so a Swarm review #27 isn't hidden by a GitHub
    // PR #27 already in the list (and vice versa).
    if (ff.kind === 'pr' && knownPrs.some((p) => p.number === ff.number && p.scm === ff.system)) return null;
    return ff;
  }, [query, knownTickets, knownPrs]);

  const pinNew = async (): Promise<void> => {
    if (!freeForm) return;
    setBusyKind(freeForm.kind);
    setError(null);
    try {
      const res = freeForm.kind === 'ticket'
        ? await onPinTicket(freeForm.identifier)
        : await onPinPr(freeForm.number, freeForm.system);
      if (!res.ok) {
        setError(
          res.reason === 'not-found' ? t('work.error.notFound')
          : res.reason === 'not-configured' ? t('work.error.notConfigured')
          : res.reason === 'auth-failed' ? t('work.error.authFailed')
          : res.reason === 'gh-not-found' ? t('work.error.ghNotFound')
          : res.reason === 'gh-not-authed' ? t('work.error.ghNotAuthed')
          : res.reason === 'no-repo' ? t('work.error.noRepo')
          : res.reason === 'duplicate' ? t('work.error.duplicate')
          : res.error || t('work.error.generic'),
        );
        return;
      }
      onCancel();
    } finally {
      setBusyKind(null);
    }
  };

  const empty =
    ticketHits.length === 0
    && prHits.length === 0
    && chatHits.length === 0
    && !freeForm
    && query.trim().length > 0;

  return createPortal(
    <div className="confirm-scrim work-item-search-scrim" onMouseDown={onCancel}>
      <div
        className="confirm-dialog work-item-search"
        role="dialog"
        aria-label={resolvedTitle}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: '92vw' }}
      >
        <div className="confirm-head">{resolvedTitle}</div>
        <div className="confirm-body" style={{ paddingBottom: 6 }}>
          <input
            className="pref-input mono narrow"
            placeholder={t('work.searchPlaceholder')}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancel();
              else if (e.key === 'Enter' && freeForm) void pinNew();
            }}
            style={{ width: '100%' }}
            autoFocus
          />

          {freeForm && (
            <div className="work-item-search-group">
              <div className="work-item-search-head">{t('work.addNew')}</div>
              <button
                type="button"
                className="work-item-search-row pin-new"
                onClick={() => void pinNew()}
                disabled={busyKind !== null}
              >
                <i className="fa-solid fa-thumbtack" />
                <span className="mono">
                  {freeForm.kind === 'ticket'
                    ? freeForm.identifier
                    : freeForm.system === 'swarm'
                      ? t('work.reviewNumber', { number: freeForm.number })
                      : t('work.prNumber', { number: freeForm.number })}
                </span>
                <span style={{ flex: 1 }} />
                <span className="work-item-search-row-hint">
                  {busyKind ? t('work.lookingUp') : t('work.pinKind', { kind: freeForm.kind })}
                </span>
              </button>
            </div>
          )}

          {ticketHits.length > 0 && (
            <div className="work-item-search-group">
              <div className="work-item-search-head">{t('work.tickets')}</div>
              {ticketHits.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="work-item-search-row"
                  onClick={() => { onSelectTicket?.(t); onCancel(); }}
                >
                  <LinearStateIcon state={{ name: t.state.name, type: t.state.type, color: t.state.color }} size={11} />
                  <span className="mono">{t.identifier}</span>
                  <span className="work-item-search-row-title">{t.title}</span>
                </button>
              ))}
            </div>
          )}

          {prHits.length > 0 && (
            <div className="work-item-search-group">
              <div className="work-item-search-head">{t('work.prs')}</div>
              {prHits.map((p) => (
                <button
                  key={p.number}
                  type="button"
                  className="work-item-search-row"
                  onClick={() => { onSelectPr?.(p); onCancel(); }}
                >
                  <i className="fa-solid fa-code-pull-request" style={{ color: 'var(--fg-3)' }} />
                  <span className="mono">{t('work.prNumber', { number: p.number })}</span>
                  <span className="work-item-search-row-title">{p.title}</span>
                </button>
              ))}
            </div>
          )}

          {chatHits.length > 0 && (
            <div className="work-item-search-group">
              <div className="work-item-search-head">{t('work.chats')}</div>
              {chatHits.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="work-item-search-row"
                  onClick={() => { onSelectChat?.(c); onCancel(); }}
                >
                  <i className={`fa-solid fa-comments`} style={{ color: 'var(--fg-3)' }} />
                  <span className="work-item-search-row-title">{c.name}</span>
                  {c.ticket && <span className="mono work-item-search-row-hint">{c.ticket}</span>}
                  {c.pr && <span className="mono work-item-search-row-hint">{t('work.prNumber', { number: c.pr })}</span>}
                </button>
              ))}
            </div>
          )}

          {empty && (
            <div style={{ padding: '14px 4px 4px', fontSize: 12, color: 'var(--fg-3)' }}>
              {t('work.emptyHint', { id: 'ENG-12345', pr: 'PR #1234', swarm: 'swarm 27' })}
            </div>
          )}

          {error && <div className="pref-error" style={{ marginTop: 10 }}>{error}</div>}
        </div>
        <div className="confirm-foot">
          <button className="btn ghost" onClick={onCancel}>{t('common.close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

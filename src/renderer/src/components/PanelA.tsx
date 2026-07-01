import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LinearIssueDto, LinearWorkflowStateDto } from '@shared/linear';
import type { ReviewItem, ReviewSystem } from '@shared/reviews';
import type { SourceControlProviderId } from '@shared/sourceControl';

/** A manually-pinned review, namespaced by system so a GitHub PR #27 and a
 *  Swarm review #27 don't collide. */
type PinnedReview = { scm: ReviewSystem; number: number };
/** Map a review system to the SCM provider id the reviews IPC expects. */
const providerIdFor = (scm: ReviewSystem): SourceControlProviderId =>
  scm === 'swarm' ? 'perforce' : 'git';
import { TICKET_PROVIDERS, type TicketProviderId } from '@shared/ticketProvider';
import type { MessageKey, Translator } from '@shared/i18n';
import { useTranslation } from '../lib/i18n';
import { Tooltip } from './Tooltip';
import { useHighlight, usePulseActive } from '../lib/highlightBus';
import {
  avatarColor,
  type Ticket,
  type SlackItem,
} from '../fixtures/data';
import { useLinearIssues } from '../lib/useLinearIssues';
import { useReviews } from '../lib/useReviews';
import { LinearStateIcon } from '../lib/linearIcons';
import { WorkItemSearch } from './WorkItemSearch';
import { PrReviewActionDialog } from './PrReviewActionDialog';
import type { AgentCreateConfig } from './AgentCreateControls';

interface PanelAProps {
  onSpawnFromTicket: (t: Ticket, agentConfig?: AgentCreateConfig) => void;
  onSpawnFromReview: (r: ReviewItem, agentConfig?: AgentCreateConfig) => void;
  /** Fired when the user clicks the RE-REVIEW chip on a PR row.
   *  The chat for this PR already exists (you reviewed it once);
   *  this action focuses that chat AND sends the re-review template
   *  prompt so the agent picks up the second pass. */
  onReReview?: (r: ReviewItem) => void;
  /** Reserved for when Slack integration ships — until then the Slack
   *  tab shows a "configure in Preferences" empty state. */
  onSpawnFromSlack?: (s: SlackItem) => void;
  /** Reopen-and-focus an existing chat by id. Used by the
   *  WorkItemSearch picker when the user clicks a chat result. */
  onFocusChat?: (chatId: string) => void;
  onOpenPrefs?: (section?: string) => void;
  /** Linear poll status — lifted to App so the same data feeds the
   *  per-chat status chip on every column without each chip running
   *  its own poll. */
  linearStatus: ReturnType<typeof useLinearIssues>['status'];
  /** Manual refresh hook for the panel's refresh button. */
  refreshLinear: () => void;
  /** Fired with newly-arrived reviews so App can pop a toast. */
  onNewReviews?: (fresh: ReviewItem[]) => void;
  /** PR numbers that already have an open or closed chat — review
   *  rows for those PRs show a "linked" indicator + click goes to
   *  the existing chat instead of starting a fresh one. */
  reviewChats?: Map<number, { open: boolean; focused: boolean }>;
  /** Linear identifier (ENG-1234) → chat-state map. Drives the
   *  "this ticket is being worked on" treatment on Linear rows. */
  ticketChats?: Map<string, { open: boolean; focused: boolean; slotId: number | null; pr: number | null }>;
}

const PRIORITY_LABEL: Record<number, Ticket['priority']> = {
  1: 'urgent',
  2: 'high',
  3: 'med',
  4: 'low',
};

/** Slack inbox tab — FEATURE IN PROGRESS. Hidden from the UI (never
 *  tested end-to-end) but all the code is retained behind this flag so
 *  it's a one-line re-enable once verified. */
const SLACK_TAB_ENABLED = false;

/** Late-stage workflow states that have moved past "needs dev work."
 *  Once a ticket is in QA / deploy queue, surfacing it on the Tickets
 *  tab adds noise — the team handling test/deploy isn't using PopBot
 *  to start a chat from it. Open chats whose ticket is in one of
 *  these states still remain (they're tracked by `ticketChats`), but
 *  the issue itself drops off the unstarted queue. */
function isLateStageState(name: string): boolean {
  return /ready\s*(to|for)\s*(deploy|merge|release|test)|test\s*in\s*progress|qa\s*investigation/i.test(name);
}

function statusLabel(state: LinearIssueDto['state']): Ticket['status'] {
  if (state.type === 'started') return 'In Progress';
  if (state.type === 'triage') return 'Triage';
  return 'Backlog';
}

/** Project a Linear issue into the legacy Ticket shape so we can reuse
 *  the existing row UI + spawn handler unchanged. */
function issueToTicket(issue: LinearIssueDto): Ticket {
  return {
    id: issue.identifier,
    title: issue.title,
    status: statusLabel(issue.state),
    priority: PRIORITY_LABEL[issue.priority] ?? 'low',
    project: issue.project?.name ?? '—',
    description: issue.description ?? undefined,
    url: issue.url,
  };
}

export function PanelA({
  onSpawnFromTicket,
  onSpawnFromReview,
  onReReview,
  onFocusChat,
  onOpenPrefs,
  linearStatus,
  refreshLinear,
  onNewReviews,
  reviewChats,
  ticketChats,
}: PanelAProps): JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'tickets' | 'reviews' | 'slack'>('tickets');
  // Which tracker feeds the queue, so the UI can feature-detect provider
  // capabilities (e.g. hide the inline status picker for GitHub Issues,
  // which have no workflow states). Re-read whenever the issue list changes
  // — switching trackers in Preferences bumps the version, which re-fetches
  // and gives `linearStatus` a fresh identity, so this self-corrects.
  const [ticketProvider, setTicketProvider] = useState<TicketProviderId>('linear');
  useEffect(() => {
    void window.popbot.settings.get<string>('ticketSource').then((id) => {
      // Own-property check, not `in`: `'constructor' in TICKET_PROVIDERS` is
      // true via the prototype, so a corrupted ticketSource could otherwise
      // slip past the fallback and crash on the capabilities read below.
      const providerId =
        typeof id === 'string' && Object.prototype.hasOwnProperty.call(TICKET_PROVIDERS, id)
          ? (id as TicketProviderId)
          : 'linear';
      setTicketProvider(providerId);
    });
  }, [linearStatus]);
  const canChangeStatus = TICKET_PROVIDERS[ticketProvider].capabilities.changeStatus;
  const handleNewReviews = useCallback(
    (fresh: ReviewItem[]) => onNewReviews?.(fresh),  // playPing now happens in the App-level notify subscriber
    [onNewReviews],
  );
  const { status: reviewsStatus, refresh: refreshReviews } = useReviews({ onNew: handleNewReviews });

  // Persistent set of PR numbers the user has explicitly told us to
  // ignore. They get filtered out of the Reviews tab on render. Loaded
  // once on mount; updated via the action dialog. Lives in app
  // settings so it survives across runs.
  const [ignoredPrs, setIgnoredPrs] = useState<number[]>([]);
  const [ignoredTickets, setIgnoredTickets] = useState<string[]>([]);
  // Manually-pinned items — user-curated entries that should appear in
  // the lists even when they're outside the auto-queue (e.g. a PR I'm
  // collaborating on but wasn't asked to review, or a ticket I want
  // visible across launches). IDs persist in settings; the fetched
  // data is held in memory and refreshed alongside the auto-list.
  const [pinnedTicketIds, setPinnedTicketIds] = useState<string[]>([]);
  const [pinnedPrNumbers, setPinnedPrNumbers] = useState<PinnedReview[]>([]);
  const [pinnedTicketsData, setPinnedTicketsData] = useState<LinearIssueDto[]>([]);
  const [pinnedPrsData, setPinnedPrsData] = useState<ReviewItem[]>([]);
  const [addPinOpen, setAddPinOpen] = useState(false);
  // Search-cache: recent issues across the configured team (regardless
  // of assignee) and recent open PRs in the configured repo. Pulled
  // on refresh + first mount so WorkItemSearch fuzzy-matches against
  // a local cache instead of hitting Linear / `gh` per keystroke.
  // Window is configurable via `panela.search.recentDays` (default 30).
  const [recentTickets, setRecentTickets] = useState<LinearIssueDto[]>([]);
  const [recentPrs, setRecentPrs] = useState<ReviewItem[]>([]);
  // Re-review chips the user has clicked (i.e. "I'm on it now"). Keyed
  // by PR number → `updatedAt` at click time. When the author pushes
  // again and the PR's updatedAt advances past the stored value, the
  // dismissal is invalidated and the chip surfaces again — the next
  // round of fixes needs a fresh re-review.
  const [dismissedReReviews, setDismissedReReviews] = useState<Record<number, string>>({});
  useEffect(() => {
    void window.popbot.settings
      .get<Record<number, string>>('panela.dismissed.rereviews')
      .then((v) => { if (v && typeof v === 'object') setDismissedReReviews(v); });
  }, []);
  const dismissReReview = useCallback((prNumber: number, updatedAt: string) => {
    setDismissedReReviews((prev) => {
      if (prev[prNumber] === updatedAt) return prev;
      const next = { ...prev, [prNumber]: updatedAt };
      void window.popbot.settings.set('panela.dismissed.rereviews', next);
      return next;
    });
  }, []);
  useEffect(() => {
    void window.popbot.settings
      .get<number[]>('reviews.ignored')
      .then((v) => { if (Array.isArray(v)) setIgnoredPrs(v); });
    void window.popbot.settings
      .get<string[]>('linear.ignored')
      .then((v) => { if (Array.isArray(v)) setIgnoredTickets(v); });
    void window.popbot.settings
      .get<string[]>('panela.pinned.tickets')
      .then((v) => { if (Array.isArray(v)) setPinnedTicketIds(v); });
    void window.popbot.settings
      .get<Array<number | PinnedReview>>('panela.pinned.prs')
      .then((v) => {
        if (!Array.isArray(v)) return;
        // Migrate the legacy number[] (all GitHub) to the {scm, number} shape.
        setPinnedPrNumbers(v.map((e) => (typeof e === 'number' ? { scm: 'github', number: e } : e)));
      });
  }, []);
  const ignorePr = useCallback(async (n: number) => {
    setIgnoredPrs((prev) => {
      if (prev.includes(n)) return prev;
      const next = [...prev, n];
      void window.popbot.settings.set('reviews.ignored', next);
      return next;
    });
  }, []);

  /** Re-fetch the metadata for every pinned ticket. Runs alongside the
   *  Linear auto-list refresh so the pinned rows stay current too.
   *  Drops items whose lookup fails (deleted ticket, lost access) so
   *  the user isn't left staring at a stale title. */
  const refreshPinnedTickets = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setPinnedTicketsData([]);
      return;
    }
    const results = await Promise.all(
      ids.map((id) => window.popbot.linear.getIssue(id)),
    );
    const next: LinearIssueDto[] = [];
    for (const res of results) if (res.ok) next.push(res.issue);
    setPinnedTicketsData(next);
  }, []);

  const refreshPinnedPrs = useCallback(async (pins: PinnedReview[]) => {
    if (pins.length === 0) {
      setPinnedPrsData([]);
      return;
    }
    const results = await Promise.all(
      pins.map((p) => window.popbot.reviews.getPr(p.number, providerIdFor(p.scm))),
    );
    const next: ReviewItem[] = [];
    for (const res of results) if (res.ok) next.push(res.pr);
    setPinnedPrsData(next);
  }, []);

  // `ticketProvider` in the deps so switching trackers re-fetches the pinned
  // rows against the new provider instead of leaving the prior provider's
  // resolved tickets on screen.
  useEffect(() => { void refreshPinnedTickets(pinnedTicketIds); }, [pinnedTicketIds, refreshPinnedTickets, ticketProvider]);
  useEffect(() => { void refreshPinnedPrs(pinnedPrNumbers); }, [pinnedPrNumbers, refreshPinnedPrs]);

  /** Pull the search-cache from Linear + GitHub. Runs alongside the
   *  visible-list refreshes so the user sees one progress banner
   *  covering everything. Errors are swallowed — the WorkItemSearch
   *  picker degrades gracefully to the auto-list-only corpus. */
  const refreshSearchCaches = useCallback(async () => {
    const [linearRes, prsRes] = await Promise.all([
      window.popbot.linear.listRecent().catch(() => ({ issues: [] })),
      window.popbot.reviews.listRecent().catch(() => ({ ok: false as const, reason: 'error' as const })),
    ]);
    if ('issues' in linearRes && Array.isArray(linearRes.issues)) {
      setRecentTickets(linearRes.issues);
    }
    if ('ok' in prsRes && prsRes.ok) {
      setRecentPrs(prsRes.prs);
    }
  }, []);
  // Re-pull the search cache on provider switch too, so the WorkItemSearch
  // corpus reflects the active tracker rather than the previous one.
  useEffect(() => { void refreshSearchCaches(); }, [refreshSearchCaches, ticketProvider]);

  /** Pin a ticket by identifier. Validates with a single Linear fetch
   *  before persisting so a typo / unknown ticket surfaces an error
   *  to the AddPinDialog instead of leaving a phantom row that
   *  perpetually fails to load. */
  const pinTicket = useCallback(async (identifier: string): Promise<
    | { ok: true }
    | { ok: false; reason: 'not-found' | 'not-configured' | 'auth-failed' | 'duplicate' | 'error'; error?: string }
  > => {
    // GitHub identifiers are case-sensitive `owner/repo#number`; upper-casing
    // them would break the lookup. Linear/Jira keys are conventionally upper.
    const trimmed = identifier.trim();
    const lookupId = ticketProvider === 'github' ? trimmed : trimmed.toUpperCase();
    if (pinnedTicketIds.includes(lookupId)) return { ok: false, reason: 'duplicate' };
    const res = await window.popbot.linear.getIssue(lookupId);
    if (!res.ok) return res;
    // Pin and persist the provider's canonical identifier, not the typed
    // form — a GitHub id entered with off-canonical casing passes lookup but
    // would otherwise store an id that never matches the auto-list row,
    // breaking dedupe, unpin, and chat matching.
    const id = res.issue.identifier;
    if (pinnedTicketIds.includes(id)) return { ok: false, reason: 'duplicate' };
    setPinnedTicketIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      void window.popbot.settings.set('panela.pinned.tickets', next);
      return next;
    });
    setPinnedTicketsData((prev) =>
      prev.some((issue) => issue.identifier === id) ? prev : [res.issue, ...prev],
    );
    return { ok: true };
  }, [pinnedTicketIds, ticketProvider]);

  const pinPr = useCallback(async (prNumber: number, system: ReviewSystem = 'github'): Promise<
    | { ok: true }
    | { ok: false; reason: 'not-found' | 'gh-not-found' | 'gh-not-authed' | 'no-repo' | 'duplicate' | 'error'; error?: string }
  > => {
    // Manual add always REACTIVATES: validate it exists, un-ignore it, and
    // ensure it's pinned — even if it already exists (ignored, or linked to a
    // closed chat). Re-adding is how you pull a review back to active, so this
    // never errors as a "duplicate".
    const res = await window.popbot.reviews.getPr(prNumber, providerIdFor(system));
    if (!res.ok) return res;
    // Un-ignore so it's no longer filtered out of the active list.
    setIgnoredPrs((prev) => {
      if (!prev.includes(prNumber)) return prev;
      const next = prev.filter((n) => n !== prNumber);
      void window.popbot.settings.set('reviews.ignored', next);
      return next;
    });
    const alreadyPinned = pinnedPrNumbers.some((p) => p.scm === system && p.number === prNumber);
    if (!alreadyPinned) {
      setPinnedPrNumbers((prev) => {
        const next = [...prev, { scm: system, number: prNumber }];
        void window.popbot.settings.set('panela.pinned.prs', next);
        return next;
      });
    }
    // Refresh (or insert) the pinned row's data at the top.
    setPinnedPrsData((prev) => [res.pr, ...prev.filter((p) => !(p.scm === system && p.number === prNumber))]);
    return { ok: true };
  }, [pinnedPrNumbers]);

  const unpinTicket = useCallback((identifier: string) => {
    setPinnedTicketIds((prev) => {
      if (!prev.includes(identifier)) return prev;
      const next = prev.filter((x) => x !== identifier);
      void window.popbot.settings.set('panela.pinned.tickets', next);
      return next;
    });
    setPinnedTicketsData((prev) => prev.filter((t) => t.identifier !== identifier));
  }, []);

  const unpinPr = useCallback((prNumber: number, system: ReviewSystem = 'github') => {
    setPinnedPrNumbers((prev) => {
      if (!prev.some((p) => p.scm === system && p.number === prNumber)) return prev;
      const next = prev.filter((p) => !(p.scm === system && p.number === prNumber));
      void window.popbot.settings.set('panela.pinned.prs', next);
      return next;
    });
    setPinnedPrsData((prev) => prev.filter((p) => !(p.scm === system && p.number === prNumber)));
  }, []);
  const ignoreTicket = useCallback(async (identifier: string) => {
    setIgnoredTickets((prev) => {
      if (prev.includes(identifier)) return prev;
      const next = [...prev, identifier];
      void window.popbot.settings.set('linear.ignored', next);
      return next;
    });
  }, []);

  // The PR currently awaiting the action-dialog. Set when the user
  // clicks a non-linked review row; cleared when they pick an action
  // or cancel.
  const [pendingReview, setPendingReview] = useState<ReviewItem | null>(null);

  // Right-click context menu for any work-item row (PR or ticket).
  // Two actions: "Open web page" (opens the URL we already know) and
  // "Ignore" (drops the item from this view permanently). Held at
  // PanelA level so a single click-outside listener dismisses it.
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    label: string;
    url: string | null;
    onIgnore: () => void;
    /** True for manually-pinned rows (action is "Unpin"); false/undefined
     *  for auto-fetched rows (action is "Ignore"). Both share the same
     *  context-menu slot but mean different things, so this flag selects
     *  the right icon + label. */
    isUnpin?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!rowMenu) return;
    const close = (): void => setRowMenu(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    });
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [rowMenu]);

  // Per-tab "seen" baselines for the unseen-items badge. Loaded from
  // settings on mount, then updated whenever the user clicks the tab
  // (which clears the badge). Stored as Sets keyed by the natural id
  // of the item (PR number / Linear identifier). Null until hydrated
  // so we can tell "loaded but empty" from "still loading."
  const [seenReviews, setSeenReviews] = useState<Set<number> | null>(null);
  const [seenTickets, setSeenTickets] = useState<Set<string> | null>(null);
  useEffect(() => {
    void window.popbot.settings.get<number[]>('panela.seen.reviews').then((v) => {
      setSeenReviews(new Set(Array.isArray(v) ? v : []));
    });
    void window.popbot.settings.get<string[]>('panela.seen.tickets').then((v) => {
      setSeenTickets(new Set(Array.isArray(v) ? v : []));
    });
  }, []);
  // Silent first-load baseline. Without this, every PR / ticket the
  // user already has on first launch would count as "new" and the
  // badge would scream a number that's just the queue's existing
  // size. Once we've seeded, only items that arrive *after* this
  // moment count toward the badge.
  const reviewsList = reviewsStatus.kind === 'ok' ? reviewsStatus.reviews : null;
  const ticketsList = linearStatus.kind === 'ok' ? linearStatus.issues : null;
  useEffect(() => {
    if (!reviewsList || !seenReviews || seenReviews.size > 0 || reviewsList.length === 0) return;
    const fresh = new Set(reviewsList.map((r) => r.number));
    setSeenReviews(fresh);
    void window.popbot.settings.set('panela.seen.reviews', [...fresh]);
  }, [reviewsList, seenReviews]);
  useEffect(() => {
    if (!ticketsList || !seenTickets || seenTickets.size > 0 || ticketsList.length === 0) return;
    const fresh = new Set(ticketsList.map((i) => i.identifier));
    setSeenTickets(fresh);
    void window.popbot.settings.set('panela.seen.tickets', [...fresh]);
  }, [ticketsList, seenTickets]);

  // Acknowledgment model — a PR is "unseen" until the user actively
  // signals "I've seen this round" via either:
  //   - the NEW chip (or any row interaction that marks it seen), or
  //   - the RE-REVIEW chip (for re-review rows)
  //   - the "Mark all seen" button (clears both pools for everything
  //     currently in view).
  // The row's `flags.reReview` decides which signal counts: for a
  // re-review row, we look at `dismissedReReviews[N] === r.updatedAt`;
  // for everything else, the legacy seenReviews set.
  //
  // Counts walk the *visible* list (same filter chain the panel
  // renders) so the badge never strands a +1 on a row the user
  // can't actually click — ignored PRs/tickets and late-stage
  // tickets are all dropped before counting, matching what the
  // user sees.

  /** Merge pinned items into the linear/review status objects so the
   *  child components render them through the same paths as the
   *  auto-fetched rows. Pinned wins on duplicate identifier — manual
   *  pins are user-curated and should survive even when the auto-list
   *  drops them. */
  const mergedLinearStatus = (() => {
    if (linearStatus.kind !== 'ok') {
      if (pinnedTicketsData.length === 0) return linearStatus;
      // Even when Linear is loading / not-configured, surface pinned
      // items the user has already validated; they live in the same
      // settings and shouldn't disappear behind a Linear hiccup.
      return { kind: 'ok' as const, issues: pinnedTicketsData, refreshing: false };
    }
    const pinnedIds = new Set(pinnedTicketsData.map((t) => t.identifier));
    const merged: LinearIssueDto[] = [
      ...pinnedTicketsData,
      ...linearStatus.issues.filter((i) => !pinnedIds.has(i.identifier)),
    ];
    return { ...linearStatus, issues: merged };
  })();
  const mergedReviewsStatus = (() => {
    if (reviewsStatus.kind !== 'ok') {
      if (pinnedPrsData.length === 0) return reviewsStatus;
      return { kind: 'ok' as const, reviews: pinnedPrsData, refreshing: false };
    }
    const pinnedNumbers = new Set(pinnedPrsData.map((p) => p.number));
    const merged: ReviewItem[] = [
      ...pinnedPrsData,
      ...reviewsStatus.reviews.filter((r) => !pinnedNumbers.has(r.number)),
    ];
    return { ...reviewsStatus, reviews: merged };
  })();

  // Single-source-of-truth visible lists: same filter chain the
  // ReviewList / LinearTickets components use to render rows. The
  // badge counts walk these so what's counted matches what's clickable.
  const ignoredPrsSet = new Set(ignoredPrs);
  const ignoredTicketsSet = new Set(ignoredTickets);
  const visibleReviewsList: ReviewItem[] = mergedReviewsStatus.kind === 'ok'
    ? mergedReviewsStatus.reviews.filter((r) => !ignoredPrsSet.has(r.number))
    : [];
  const visibleTicketsList: LinearIssueDto[] = mergedLinearStatus.kind === 'ok'
    ? mergedLinearStatus.issues.filter((i) =>
      !ignoredTicketsSet.has(i.identifier) && !isLateStageState(i.state.name),
    )
    : [];

  const unseenReviews = seenReviews
    ? visibleReviewsList.reduce((n, r) => {
        const acked = r.flags.reReview
          ? dismissedReReviews[r.number] === r.updatedAt
          : seenReviews.has(r.number);
        return n + (acked ? 0 : 1);
      }, 0)
    : 0;
  const unseenTickets = seenTickets
    ? visibleTicketsList.reduce((n, i) => n + (seenTickets.has(i.identifier) ? 0 : 1), 0)
    : 0;

  // Refresh banner state — flips on when the user clicks Refresh and
  // off ~1s after both auto-list + pinned refreshes resolve. Drives
  // the yellow→blue→slide-out banner at the top of the panel.
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'done'>('idle');
  const refreshAll = useCallback(async () => {
    setRefreshState('refreshing');
    try {
      await Promise.all([
        Promise.resolve(refreshLinear()),
        Promise.resolve(refreshReviews()),
        refreshPinnedTickets(pinnedTicketIds),
        refreshPinnedPrs(pinnedPrNumbers),
        refreshSearchCaches(),
      ]);
    } finally {
      setRefreshState('done');
      // Hold the "Refreshed" affirmation briefly, then slide shut.
      setTimeout(() => setRefreshState('idle'), 1200);
    }
  }, [refreshLinear, refreshReviews, refreshPinnedTickets, refreshPinnedPrs, refreshSearchCaches, pinnedTicketIds, pinnedPrNumbers]);

  const markReviewsSeen = useCallback(() => {
    if (!reviewsList || !seenReviews) return;
    const next = new Set(seenReviews);
    for (const r of reviewsList) next.add(r.number);
    if (next.size !== seenReviews.size) {
      setSeenReviews(next);
      void window.popbot.settings.set('panela.seen.reviews', [...next]);
    }
    // "Mark all seen" also acknowledges the current round of every
    // re-review on the list — without this, re-review rows kept the
    // badge count up because `unseenReviews` gates on the dismissed
    // map (not just the seen-set).
    setDismissedReReviews((prev) => {
      let changed = false;
      const draft: Record<number, string> = { ...prev };
      for (const r of reviewsList) {
        if (r.flags.reReview && draft[r.number] !== r.updatedAt) {
          draft[r.number] = r.updatedAt;
          changed = true;
        }
      }
      if (!changed) return prev;
      void window.popbot.settings.set('panela.dismissed.rereviews', draft);
      return draft;
    });
  }, [reviewsList, seenReviews]);
  const markTicketsSeen = useCallback(() => {
    if (!ticketsList || !seenTickets) return;
    if (ticketsList.every((i) => seenTickets.has(i.identifier))) return;
    const next = new Set(seenTickets);
    for (const i of ticketsList) next.add(i.identifier);
    setSeenTickets(next);
    void window.popbot.settings.set('panela.seen.tickets', [...next]);
  }, [ticketsList, seenTickets]);
  // Per-item dismiss for the NEW chip — clicking it on a single row
  // removes just that row from the unseen set, leaving the rest of the
  // queue still flagged. Both list types share the same shape.
  const markOneReviewSeen = useCallback((n: number) => {
    setSeenReviews((prev) => {
      if (!prev || prev.has(n)) return prev;
      const next = new Set(prev);
      next.add(n);
      void window.popbot.settings.set('panela.seen.reviews', [...next]);
      return next;
    });
    // Also dismiss any active re-review for this PR — same intent as
    // markReviewsSeen but scoped to one row. Without this, marking
    // seen on a re-review row didn't tick the badge down.
    const row = reviewsList?.find((x) => x.number === n);
    if (row?.flags.reReview) {
      setDismissedReReviews((prev) => {
        if (prev[n] === row.updatedAt) return prev;
        const draft = { ...prev, [n]: row.updatedAt };
        void window.popbot.settings.set('panela.dismissed.rereviews', draft);
        return draft;
      });
    }
  }, [reviewsList]);
  const markOneTicketSeen = useCallback((id: string) => {
    setSeenTickets((prev) => {
      if (!prev || prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      void window.popbot.settings.set('panela.seen.tickets', [...next]);
      return next;
    });
  }, []);

  // Test hook (Preferences > Notifications has a "Flag N items as NEW"
  // button that dispatches this event). Picks up to N current items
  // from the named list and removes them from the seen-set so they
  // re-appear with the NEW chip + bump the tab pip. Each flagged item
  // also fires its own notification through the bell, mirroring the
  // real polling flow exactly (one record per item). Real items only
  // — no fake data is ever inserted into the queue.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ kind: 'tickets' | 'reviews'; count?: number }>).detail;
      if (!detail) return;
      const n = Math.max(1, detail.count ?? 2);
      if (detail.kind === 'reviews' && reviewsList && seenReviews) {
        const targets = reviewsList.slice(0, n);
        if (targets.length === 0) return;
        const next = new Set(seenReviews);
        for (const r of targets) next.delete(r.number);
        setSeenReviews(next);
        void window.popbot.settings.set('panela.seen.reviews', [...next]);
        for (const r of targets) {
          void window.popbot.notifications.dispatch({
            kind: 'review',
            urgency: 'med',
            source: 'GitHub (test)',
            title: `#${r.number} · ${r.title}`,
            subtitle: r.author ? `New PR to review · @${r.author}` : 'New PR to review',
            summary: '',
            actor: { name: r.author || 'GitHub', avatar: (r.author || 'GH').slice(0, 2).toUpperCase(), color: '#0d1117' },
            actions: [
              { kind: 'external', label: 'Open on GitHub', url: r.url, primary: true },
              { kind: 'internal', label: 'Show in PopBot', targetKind: 'review', targetId: String(r.number) },
            ],
            dedupKey: `test-review:${r.number}:${Date.now()}`,
          });
        }
      } else if (detail.kind === 'tickets' && ticketsList && seenTickets) {
        const targets = ticketsList.slice(0, n);
        if (targets.length === 0) return;
        const next = new Set(seenTickets);
        for (const i of targets) next.delete(i.identifier);
        setSeenTickets(next);
        void window.popbot.settings.set('panela.seen.tickets', [...next]);
        for (const i of targets) {
          void window.popbot.notifications.dispatch({
            kind: 'ticket',
            urgency: i.priority === 1 ? 'high' : 'med',
            source: 'Linear (test)',
            title: `${i.identifier} · ${i.title}`,
            subtitle: i.project?.name ? `New ticket · ${i.project.name}` : 'New ticket',
            summary: '',
            actor: { name: 'Linear', avatar: 'LI', color: '#5e6ad2' },
            actions: [
              { kind: 'external', label: 'Open in Linear', url: i.url, primary: true },
              { kind: 'internal', label: 'Show in PopBot', targetKind: 'linear-issue', targetId: i.id },
            ],
            dedupKey: `test-ticket:${i.id}:${Date.now()}`,
          });
        }
      }
    };
    window.addEventListener('popbot:test-mark-unseen', handler);
    return () => window.removeEventListener('popbot:test-mark-unseen', handler);
  }, [reviewsList, ticketsList, seenReviews, seenTickets]);

  // Register highlight handlers + listen for the App-level toast click
  // bridge event. Switching tabs is the navigate; pulse is driven by
  // each row comparing its data-pulse-id against the bus.
  const { registerHandler, highlight } = useHighlight();
  useEffect(() => {
    const offReview = registerHandler('review', () => setTab('reviews'));
    const offLinear = registerHandler('linear-issue', () => setTab('tickets'));
    const onBridge = (e: Event) => {
      const detail = (e as CustomEvent<{ kind: string; id: string }>).detail;
      if (detail) highlight(detail.kind, detail.id);
    };
    window.addEventListener('popbot:highlight', onBridge);
    return () => {
      offReview();
      offLinear();
      window.removeEventListener('popbot:highlight', onBridge);
    };
  }, [registerHandler, highlight]);

  return (
    <div className="panel-a" data-screen-label="Panel A · Work Queues">
      <div className="panel-head">
        <div className="panel-tabs">
          {/* Total-count chips removed — they were noise. The unseen
              red pill in the upper-left of each tab is the only
              count signal we want; total-queue size is visible in
              the list itself. */}
          {/* Tab clicks no longer auto-mark items as seen — that was
              passive acknowledgment. Now each NEW row is dismissed
              individually via its NEW chip, or all at once via the
              "Mark all seen" panel action. */}
          <button
            className="panel-tab"
            aria-selected={tab === 'tickets'}
            onClick={() => setTab('tickets')}
          >
            {t('panelA.tab.tickets')}
            {unseenTickets > 0 && (
              <span className="tab-unseen" title={t('panelA.tab.unseenTitle', { count: unseenTickets })}>
                {unseenTickets > 9 ? '9+' : unseenTickets}
              </span>
            )}
          </button>
          <button
            className="panel-tab"
            aria-selected={tab === 'reviews'}
            onClick={() => setTab('reviews')}
          >
            {t('panelA.tab.reviews')}
            {unseenReviews > 0 && (
              <span className="tab-unseen" title={t('panelA.tab.unseenTitle', { count: unseenReviews })}>
                {unseenReviews > 9 ? '9+' : unseenReviews}
              </span>
            )}
          </button>
          {SLACK_TAB_ENABLED && (
            <button className="panel-tab" aria-selected={tab === 'slack'} onClick={() => setTab('slack')}>
              {t('panelA.tab.slack')}
            </button>
          )}
        </div>
        <div className="panel-actions">
          {tab === 'tickets' && unseenTickets > 0 && (
            <button
              className="iconbtn"
              title={t('panelA.action.markAllTicketsSeen', { count: unseenTickets })}
              onClick={markTicketsSeen}
            >
              <i className="fa-solid fa-check-double" />
            </button>
          )}
          {tab === 'reviews' && unseenReviews > 0 && (
            <button
              className="iconbtn"
              title={t('panelA.action.markAllReviewsSeen', { count: unseenReviews })}
              onClick={markReviewsSeen}
            >
              <i className="fa-solid fa-check-double" />
            </button>
          )}
          <button
            className="iconbtn"
            title={t('panelA.action.addItem')}
            onClick={() => setAddPinOpen(true)}
          >
            <i className="fa-solid fa-plus" />
          </button>
          <button
            className="iconbtn"
            title={t('panelA.action.refresh')}
            onClick={() => void refreshAll()}
            disabled={refreshState === 'refreshing'}
          >
            <i className="fa-solid fa-arrows-rotate" />
          </button>
          <button className="iconbtn" title={t('panelA.action.filter')}>
            <i className="fa-solid fa-filter" />
          </button>
        </div>
      </div>
      {refreshState !== 'idle' && (
        <div className={`panel-refresh-banner ${refreshState}`}>
          {refreshState === 'refreshing'
            ? <>
                <i className="fa-solid fa-arrows-rotate fa-spin" />
                <span>{t('panelA.refresh.inProgress')}</span>
              </>
            : <>
                <i className="fa-solid fa-check" />
                <span>{t('panelA.refresh.done')}</span>
              </>}
        </div>
      )}
      <div className="panel-body">
        {tab === 'tickets' && (
          <LinearTickets
            status={mergedLinearStatus}
            onSpawn={onSpawnFromTicket}
            onOpenPrefs={onOpenPrefs}
            onRefresh={refreshAll}
            canChangeStatus={canChangeStatus}
            ticketChats={ticketChats}
            ignoredTickets={ignoredTickets}
            isNew={(id) => seenTickets ? !seenTickets.has(id) : false}
            onMarkSeen={markOneTicketSeen}
            onContextMenu={(issue, x, y) => setRowMenu({
              x, y,
              label: `${issue.identifier} · ${issue.title.slice(0, 60)}`,
              url: issue.url,
              // Pinned rows get an Unpin action; auto-fetched rows
              // keep the existing Ignore action.
              onIgnore: pinnedTicketIds.includes(issue.identifier)
                ? () => unpinTicket(issue.identifier)
                : () => void ignoreTicket(issue.identifier),
              isUnpin: pinnedTicketIds.includes(issue.identifier),
            })}
          />
        )}
        {tab === 'reviews' && (
          <ReviewList
            status={mergedReviewsStatus}
            onSpawn={onSpawnFromReview}
            onOpenPrefs={onOpenPrefs}
            reviewChats={reviewChats}
            ignoredPrs={ignoredPrs}
            isNew={(n) => seenReviews ? !seenReviews.has(n) : false}
            onMarkSeen={markOneReviewSeen}
            onPromptAction={setPendingReview}
            // RE-REVIEW chip → dismiss it locally (until the author
            // pushes a fresh round), mark the row seen so any latent
            // NEW chip also clears, AND fire the re-review handler so
            // App.tsx focuses the chat + sends the template prompt.
            // Marking-seen here is what makes the tab badge tick down
            // when the user clicks the chip on a row that was also
            // flagged as NEW from a prior tick.
            isReReviewDismissed={(r) => dismissedReReviews[r.number] === r.updatedAt}
            onReReview={(r) => {
              dismissReReview(r.number, r.updatedAt);
              markOneReviewSeen(r.number);
              onReReview?.(r);
            }}
            onContextMenu={(review, x, y) => setRowMenu({
              x, y,
              label: `${review.scm === 'swarm' ? 'Review' : 'PR'} #${review.number} · ${review.title.slice(0, 60)}`,
              url: review.url,
              onIgnore: pinnedPrNumbers.some((p) => p.scm === review.scm && p.number === review.number)
                ? () => unpinPr(review.number, review.scm)
                : () => void ignorePr(review.number),
              isUnpin: pinnedPrNumbers.some((p) => p.scm === review.scm && p.number === review.number),
            })}
          />
        )}
        {tab === 'slack' && (
          <div className="row-empty">
            <p>{t('slack.empty.notConnected')}</p>
            <p style={{ color: 'var(--fg-3)', fontSize: 12, marginBottom: 12 }}>
              {t('slack.empty.description')}
            </p>
            {onOpenPrefs && (
              <button className="btn primary sm" onClick={() => onOpenPrefs('integ')}>
                <i className="fa-solid fa-plug" /> {t('slack.empty.connectButton')}
              </button>
            )}
          </div>
        )}
      </div>
      {pendingReview && (
        <PrReviewActionDialog
          review={pendingReview}
          onCreateChat={(agentConfig) => {
            const r = pendingReview;
            setPendingReview(null);
            onSpawnFromReview(r, agentConfig);
          }}
          onIgnore={() => {
            const r = pendingReview;
            setPendingReview(null);
            void ignorePr(r.number);
          }}
          onCancel={() => setPendingReview(null)}
        />
      )}
      {rowMenu && (
        <div
          className="git-context-menu work-item-menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="work-item-menu-head" title={rowMenu.label}>{rowMenu.label}</div>
          {rowMenu.url && (
            <button
              className="git-menu-item"
              onClick={() => {
                if (rowMenu.url) window.open(rowMenu.url, '_blank');
                setRowMenu(null);
              }}
            >
              <i className="fa-solid fa-arrow-up-right-from-square" /> {t('panelA.menu.openWebPage')}
            </button>
          )}
          <button
            className="git-menu-item danger"
            onClick={() => {
              rowMenu.onIgnore();
              setRowMenu(null);
            }}
          >
            <i className={`fa-solid ${rowMenu.isUnpin ? 'fa-thumbtack-slash' : 'fa-eye-slash'}`} />
            &nbsp;{rowMenu.isUnpin ? t('panelA.menu.unpin') : t('panelA.menu.ignore')}
          </button>
        </div>
      )}
      {addPinOpen && (
        <WorkItemSearch
          onCancel={() => setAddPinOpen(false)}
          // Union of (assigned + pinned + recent-team) for tickets,
          // (queue + pinned + recent-open) for PRs. Pinned + assigned
          // are ALWAYS in the cache (per user requirement); the
          // recent pulls add fuzzy-searchable coverage of items the
          // user wasn't directly assigned. Dedup happens inside
          // WorkItemSearch so duplicates don't render.
          knownTickets={[
            ...(mergedLinearStatus.kind === 'ok' ? mergedLinearStatus.issues : pinnedTicketsData),
            ...recentTickets,
          ]}
          knownPrs={[
            ...(mergedReviewsStatus.kind === 'ok' ? mergedReviewsStatus.reviews : pinnedPrsData),
            ...recentPrs,
          ]}
          onPinTicket={pinTicket}
          onPinPr={pinPr}
          onSelectTicket={(t) => {
            // Already in the list — convert to the canonical `Ticket`
            // shape and spawn the chat. Skips spawning if there's a
            // live chat for this ticket (handled in App.tsx
            // via `focusOrAttach`).
            onSpawnFromTicket({
              id: t.identifier,
              title: t.title,
              status: t.state.name as Ticket['status'],
              priority: (PRIORITY_LABEL[t.priority] ?? 'med') as Ticket['priority'],
              project: t.project?.name ?? '',
              url: t.url,
              description: t.description ?? '',
            });
          }}
          onSelectPr={(p) => { setPendingReview(p); }}
          onSelectChat={(c) => { onFocusChat?.(c.id); }}
        />
      )}
    </div>
  );
}

interface ReviewListProps {
  status: ReturnType<typeof useReviews>['status'];
  onSpawn: (r: ReviewItem) => void;
  onOpenPrefs?: (section?: string) => void;
  /** PR-number → chat-state map. Rows for PRs with an existing chat
   *  badge accordingly + their click is "go to that chat" rather than
   *  "spawn a fresh one" (the spawn handler upstream handles both). */
  reviewChats?: Map<number, { open: boolean; focused: boolean }>;
  /** PR numbers the user has chosen to ignore — filtered out of the
   *  rendered list. */
  ignoredPrs?: number[];
  /** Whether a PR row should render with the NEW chip. */
  isNew?: (n: number) => boolean;
  /** Click handler for the NEW chip — dismisses just that row. */
  onMarkSeen?: (n: number) => void;
  /** Fired when the user clicks a review row that has no existing
   *  chat. The parent opens the action dialog so the user can pick
   *  Create / Ignore / Cancel. Linked rows skip the prompt — clicking
   *  them just routes to the existing chat via `onSpawn`. */
  onPromptAction?: (r: ReviewItem) => void;
  /** Whether the RE-REVIEW chip for this PR has been clicked in
   *  this session (and the author hasn't pushed a newer batch yet).
   *  Hides the chip + treats the row like a normal PR row again. */
  isReReviewDismissed?: (review: ReviewItem) => boolean;
  /** Click handler for the RE-REVIEW chip. */
  onReReview?: (review: ReviewItem) => void;
  /** Right-click on a row pops the parent's shared work-item menu
   *  (Open web page / Ignore). */
  onContextMenu?: (review: ReviewItem, x: number, y: number) => void;
}

/** One step in the GitHub readiness checklist: a status dot + label,
 *  and either a CTA button (when this step is the blocker) or nothing.
 *  Steps gated behind an earlier unmet step render muted/pending. */
function ReviewStep({
  state,
  label,
  hint,
  action,
}: {
  state: 'ok' | 'needed' | 'pending';
  label: string;
  hint?: string;
  action?: { text: string; onClick: () => void };
}): JSX.Element {
  const icon = state === 'ok' ? 'fa-circle-check'
    : state === 'needed' ? 'fa-circle-exclamation'
      : 'fa-circle';
  const color = state === 'ok' ? 'var(--ok, #46c878)'
    : state === 'needed' ? 'var(--warn, #e6b04a)'
      : 'var(--fg-3)';
  return (
    <div className="reviews-step">
      <i className={`fa-solid ${icon}`} style={{ color, width: 15, textAlign: 'center', flex: '0 0 auto' }} />
      <span style={{ color: state === 'pending' ? 'var(--fg-3)' : 'var(--fg-2)', fontSize: 12.5 }}>{label}</span>
      {hint && <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>· {hint}</span>}
      {action && (
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={action.onClick}>
          {action.text}
        </button>
      )}
    </div>
  );
}

/** GitHub-readiness checklist for the Reviews tab. Walks gh-installed →
 *  signed-in → repo-configured, deriving each step's state from the
 *  reviews status discriminant. Shows green checks for satisfied steps
 *  and an actionable button for the first one that's missing — replacing
 *  the old bare one-line error text. `footer` is rendered below the
 *  checklist (e.g. the "no PRs waiting" note once everything's green). */
function ReviewsReadiness({
  status,
  onOpenPrefs,
  footer,
}: {
  status: ReturnType<typeof useReviews>['status'];
  onOpenPrefs?: (section?: string) => void;
  footer?: JSX.Element;
}): JSX.Element {
  const { t } = useTranslation();
  const ghInstalled = status.kind !== 'gh-not-found';
  const ghAuthed = ghInstalled && status.kind !== 'gh-not-authed';
  const hasRepo = ghAuthed && status.kind !== 'no-repo';
  const allReady = ghInstalled && ghAuthed && hasRepo;
  return (
    <div className="empty reviews-readiness">
      <div className="ico"><i className="fa-brands fa-github" /></div>
      <div style={{ fontWeight: 600, color: 'var(--fg-2)' }}>
        {allReady ? t('reviews.readiness.connected') : t('reviews.readiness.connectPrompt')}
      </div>
      <div className="reviews-steps">
        <ReviewStep
          state={ghInstalled ? 'ok' : 'needed'}
          label={t('reviews.readiness.installLabel')}
          action={ghInstalled ? undefined : {
            text: t('reviews.readiness.installAction'),
            onClick: () => window.open('https://cli.github.com', '_blank'),
          }}
        />
        <ReviewStep
          state={!ghInstalled ? 'pending' : ghAuthed ? 'ok' : 'needed'}
          label={t('reviews.readiness.signedInLabel')}
          hint={ghInstalled && !ghAuthed ? t('reviews.readiness.signedInHint') : undefined}
          action={ghInstalled && !ghAuthed ? {
            text: t('reviews.readiness.signedInAction'),
            onClick: () => window.open('https://cli.github.com/manual/gh_auth_login', '_blank'),
          } : undefined}
        />
        <ReviewStep
          state={!ghAuthed ? 'pending' : hasRepo ? 'ok' : 'needed'}
          label={t('reviews.readiness.repoLabel')}
          action={ghAuthed && !hasRepo && onOpenPrefs ? {
            text: t('reviews.readiness.repoAction'),
            onClick: () => onOpenPrefs('repos'),
          } : undefined}
        />
      </div>
      {footer}
    </div>
  );
}

function ReviewList({
  status,
  onSpawn,
  onOpenPrefs,
  reviewChats,
  ignoredPrs,
  isNew,
  onMarkSeen,
  isReReviewDismissed,
  onReReview,
  onPromptAction,
  onContextMenu,
}: ReviewListProps): JSX.Element {
  const { t } = useTranslation();
  if (status.kind === 'loading') {
    return <div className="row-empty">{t('reviews.list.loading')}</div>;
  }
  // gh missing / not signed in / no repo → the progressive readiness
  // checklist (green checks for what's done, a button for what's next).
  if (status.kind === 'gh-not-found' || status.kind === 'gh-not-authed' || status.kind === 'no-repo') {
    return <ReviewsReadiness status={status} onOpenPrefs={onOpenPrefs} />;
  }
  if (status.kind === 'error') {
    return <div className="row-empty error">{t('reviews.list.loadError', { message: status.message })}</div>;
  }
  // Drop ignored PRs before checking emptiness — if the only remaining
  // PRs are ones the user already dismissed, the panel should read as
  // empty, not "0 PRs to review" with hidden rows underneath.
  const ignoredSet = new Set(ignoredPrs ?? []);
  const visibleReviews = status.reviews.filter((r) => !ignoredSet.has(r.number));
  if (visibleReviews.length === 0) {
    // Everything's connected — show just the "nothing waiting" note, no
    // config checklist. We only surface the readiness steps when a step
    // is actually missing (mirrors the Tickets tab + central chat panel).
    return (
      <div className="empty reviews-readiness">
        <div className="ico"><i className="fa-brands fa-github" /></div>
        <div className="reviews-empty-note">{t('reviews.empty.none')}</div>
      </div>
    );
  }
  return (
    <>
      {visibleReviews.map((r) => {
        const linked = reviewChats?.get(r.number);
        const linkedTitle = linked?.focused
          ? t('reviews.row.linkedFocused')
          : linked?.open
            ? t('reviews.row.linkedOpen')
            : linked
              ? t('reviews.row.linkedClosed')
              : t('reviews.row.linkedDefault', { number: r.number, title: r.title });
        // Linked rows skip the prompt — clicking them is "focus / reopen
        // the existing chat for this PR." Non-linked rows go through the
        // action dialog so the user can choose Create / Ignore / Cancel.
        const onClick = linked || !onPromptAction
          ? () => onSpawn(r)
          : () => onPromptAction(r);
        return (
          <ReviewRow
            key={r.number}
            review={r}
            linked={linked}
            onClick={onClick}
            avatarColor={avatarColor}
            linkedTitle={linkedTitle}
            isNew={isNew?.(r.number) ?? false}
            isReReviewDismissed={isReReviewDismissed?.(r) ?? false}
            onMarkSeen={onMarkSeen}
            onReReview={onReReview}
            onContextMenu={onContextMenu}
          />
        );
      })}
    </>
  );
}

function ReviewRow({ review: r, linked, onClick, avatarColor, linkedTitle, isNew, isReReviewDismissed, onMarkSeen, onReReview, onContextMenu }: {
  review: ReviewItem;
  linked: { open: boolean; focused: boolean } | undefined;
  onClick: () => void;
  avatarColor: (s: string) => string;
  linkedTitle: string;
  isNew: boolean;
  isReReviewDismissed: boolean;
  onMarkSeen?: (n: number) => void;
  onReReview?: (r: ReviewItem) => void;
  onContextMenu?: (review: ReviewItem, x: number, y: number) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const pulsing = usePulseActive('review', r.number);
  // Re-review wins over NEW when both apply: the RE-REVIEW chip is
  // more specific (the user has already engaged with this PR — they
  // need to know it's the same one back for another pass). Clicking
  // the chip fires onReReview AND marks it dismissed until the next
  // round of fixes from the author (tracked by updatedAt).
  const reReview = r.flags.reReview && !isReReviewDismissed;
  const showNewChip = isNew && !reReview;
  return (
          <div
            data-pulse-id={`review:${r.number}`}
            className={`row review-row ${linked ? 'has-chat' : ''} ${linked?.focused ? 'is-focused' : ''} ${pulsing ? 'pulse' : ''} ${(isNew || reReview) ? 'is-new' : ''}`}
            onClick={() => {
              // Any interaction with a row counts as acknowledgment —
              // dismiss the NEW chip + bump the tab pip down. Done
              // here (rather than only on the chip itself) so clicking
              // the row body to open / spawn also clears it.
              if (showNewChip) onMarkSeen?.(r.number);
              onClick();
            }}
            onContextMenu={(e) => {
              if (!onContextMenu) return;
              e.preventDefault();
              if (showNewChip) onMarkSeen?.(r.number);
              onContextMenu(r, e.clientX, e.clientY);
            }}
            aria-label={linkedTitle}
          >
            <span className="avatar" style={{ background: avatarColor(r.author || '?') }}>
              {(r.author || '?').slice(0, 2)}
            </span>
            {reReview && (
              <button
                type="button"
                className="row-new-chip row-rereview-chip"
                title={linked
                  ? t('reviews.row.reReviewLinkedTitle')
                  : t('reviews.row.reReviewNewTitle')}
                onClick={(e) => {
                  e.stopPropagation();
                  if (linked) onReReview?.(r);
                  else onClick();
                }}
              >
                {t('reviews.row.reReviewChip')}
              </button>
            )}
            {showNewChip && (
              <button
                type="button"
                className="row-new-chip"
                title={t('common.markAsSeen')}
                onClick={(e) => { e.stopPropagation(); onMarkSeen?.(r.number); }}
              >
                {t('reviews.row.newChip')}
              </button>
            )}
            <span className="id">#{r.number}</span>
            <span className="title">{r.title}</span>
            <span className="meta">
              {linked && (
                <span
                  className={`pill ${linked.focused ? 'done' : linked.open ? 'wait' : 'muted'}`}
                  title={linkedTitle}
                >
                  <i className="fa-solid fa-comment" /> {linked.open ? t('reviews.row.chatPill') : t('reviews.row.closedPill')}
                </span>
              )}
              {r.flags.requestedReviewer && (
                <span className="pill wait" title={t('reviews.row.requestedReviewerTitle')}>
                  <span className="glyph">?</span>{t('reviews.row.requestedReviewerLabel')}
                </span>
              )}
              {r.flags.noReviewsYet && !r.flags.requestedReviewer && (
                <span className="pill muted" title={t('reviews.row.noReviewsTitle')}>{t('reviews.row.noReviewsLabel')}</span>
              )}
              {r.isDraft && <span className="pill muted">{t('reviews.row.draft')}</span>}
              {/* Open-in-browser is now exposed via right-click → "Open
                  web page" — see the work-item context menu in PanelA. */}
            </span>
          </div>
  );
}

interface LinearTicketsProps {
  status: ReturnType<typeof useLinearIssues>['status'];
  onSpawn: (t: Ticket) => void;
  onOpenPrefs?: (section?: string) => void;
  onRefresh: () => void;
  /** Whether the active tracker supports changing an issue's status from
   *  PopBot (Linear/Jira do; GitHub Issues don't). Off → the row renders a
   *  read-only status glyph instead of the interactive picker. */
  canChangeStatus: boolean;
  ticketChats?: Map<string, { open: boolean; focused: boolean; slotId: number | null; pr: number | null }>;
  /** Linear identifiers the user has chosen to ignore — filtered out
   *  of the rendered list. Mirrors the PR-ignore behavior. */
  ignoredTickets?: string[];
  /** Whether a ticket row should render with the NEW chip. */
  isNew?: (identifier: string) => boolean;
  /** Click handler for the NEW chip — dismisses just that row. */
  onMarkSeen?: (identifier: string) => void;
  /** Right-click on a row → parent's shared work-item menu. */
  onContextMenu?: (issue: LinearIssueDto, x: number, y: number) => void;
}

/** Priority groups, in render order. Top three (urgent/high/medium)
 *  default to expanded; low/none collapsed. Map indices align with
 *  Linear's priority enum (0=none, 1=urgent, 2=high, 3=medium, 4=low). */
const GROUPS: Array<{
  key: 'urgent' | 'high' | 'med' | 'low' | 'none';
  labelKey: MessageKey;
  priority: number;
  defaultOpen: boolean;
}> = [
  { key: 'urgent', labelKey: 'priority.urgent', priority: 1, defaultOpen: true },
  { key: 'high', labelKey: 'priority.high', priority: 2, defaultOpen: true },
  { key: 'med', labelKey: 'priority.med', priority: 3, defaultOpen: true },
  { key: 'low', labelKey: 'priority.low', priority: 4, defaultOpen: false },
  { key: 'none', labelKey: 'priority.none', priority: 0, defaultOpen: false },
];

/** Maps the legacy Ticket priority key → its message catalog key for
 *  the IssueTooltip priority line. */
const PRIORITY_KEY: Record<Ticket['priority'] | 'none', MessageKey> = {
  urgent: 'priority.urgent',
  high: 'priority.high',
  med: 'priority.med',
  low: 'priority.low',
  none: 'priority.none',
};


/** Linear-style priority glyph. Numeric priority matches Linear's API:
 *  0=none, 1=urgent, 2=high, 3=medium, 4=low.
 *  - Urgent: red rounded square with white "!"
 *  - High/Medium/Low: three ascending bars; how many are filled marks
 *    severity (3/2/1). Unfilled bars stay visible as a faint outline.
 *  - None: three flat dashes. */
function LinearPriorityIcon({ priority, size = 14 }: { priority: number; size?: number }): JSX.Element {
  if (priority === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="#eb5757" />
        <rect x="7.25" y="3.5" width="1.5" height="6" rx="0.75" fill="white" />
        <rect x="7.25" y="11" width="1.5" height="1.5" rx="0.75" fill="white" />
      </svg>
    );
  }
  if (priority === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <rect x="2.5"  y="7.25" width="2.5" height="1.5" rx="0.75" fill="currentColor" opacity="0.55" />
        <rect x="6.75" y="7.25" width="2.5" height="1.5" rx="0.75" fill="currentColor" opacity="0.55" />
        <rect x="11"   y="7.25" width="2.5" height="1.5" rx="0.75" fill="currentColor" opacity="0.55" />
      </svg>
    );
  }
  // 2=high → 3 lit, 3=medium → 2 lit, 4=low → 1 lit. Bars left-to-right
  // are short / medium / tall; lit bars use full opacity, unlit fade.
  let lit = 1;
  if (priority === 2) lit = 3;
  else if (priority === 3) lit = 2;
  const opacity = (idx: number): number => (idx <= lit ? 1 : 0.25);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="2"   y="10" width="3" height="4"  rx="0.75" fill="currentColor" opacity={opacity(1)} />
      <rect x="6.5" y="7"  width="3" height="7"  rx="0.75" fill="currentColor" opacity={opacity(2)} />
      <rect x="11"  y="3"  width="3" height="11" rx="0.75" fill="currentColor" opacity={opacity(3)} />
    </svg>
  );
}

/** Clickable status icon that opens a popover of the team's workflow
 *  states; selecting one updates the issue in Linear and refreshes
 *  the local list. Replaces the read-only StatusIcon for issue rows. */
function StatusPicker({ issue, onChanged }: { issue: LinearIssueDto; onChanged: () => void }): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [states, setStates] = useState<LinearWorkflowStateDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Lazy-fetch the team's workflow states the first time the popover
  // opens. Cached for the life of this row — closing + reopening hits
  // the local copy.
  useEffect(() => {
    if (!open || states) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.popbot.linear.listStates(issue.team.id).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if ('error' in res && res.error) setError(res.error);
      else if (res.notConfigured) setError(t('linear.error.notConfigured'));
      else if (res.authFailed) setError(t('linear.error.authFailed'));
      else setStates(res.states);
    });
    return () => { cancelled = true; };
  }, [open, issue.team.id, states]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 4 });
  }, [open]);

  // Close on outside click or Escape — same shape as Tooltip's manual
  // outside-click handling, plus a popRef check so clicks inside the
  // popover (e.g. on a state row) don't close prematurely.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onMouseDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  const pick = async (state: LinearWorkflowStateDto): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.popbot.linear.setIssueState(issue.id, state.id);
      if (r.ok) {
        setOpen(false);
        onChanged();
      } else {
        setError(r.reason);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="status-picker-btn"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={t('linear.status.changeTitle', { state: issue.state.name })}
        aria-label={t('linear.status.changeAriaLabel', { state: issue.state.name })}
      >
        <LinearStateIcon state={issue.state} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="status-picker-pop"
          style={{ left: pos.left, top: pos.top }}
          role="listbox"
          onClick={(e) => e.stopPropagation()}
        >
          {loading && <div className="status-picker-empty">{t('common.loading')}</div>}
          {error && <div className="status-picker-error">{error}</div>}
          {states && states.length === 0 && (
            <div className="status-picker-empty">{t('linear.status.noStates')}</div>
          )}
          {states?.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`status-picker-row ${s.name === issue.state.name ? 'current' : ''}`}
              onClick={() => void pick(s)}
              disabled={busy}
            >
              <LinearStateIcon state={s} />
              <span className="status-picker-name">{s.name}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function relTime(iso: string, t: Translator): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return t('time.justNow');
  if (diff < 60 * 60_000) return t('time.minutesAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 24 * 60 * 60_000) return t('time.hoursAgo', { count: Math.floor(diff / 3_600_000) });
  return t('time.daysAgo', { count: Math.floor(diff / 86_400_000) });
}

/** Rich tooltip body for a Linear ticket row. Includes the status icon
 *  inline so it's clear what state we're in without re-reading text. */
function IssueTooltip({ issue }: { issue: LinearIssueDto }): JSX.Element {
  const { t } = useTranslation();
  const priorityKey = PRIORITY_LABEL[issue.priority] ?? 'none';
  return (
    <div className="tip-issue">
      <div className="tip-issue-head">
        <span className="tip-id">{issue.identifier}</span>
        <span className="tip-title">{issue.title}</span>
      </div>
      <dl className="tip-meta">
        <dt>{t('linear.tooltip.status')}</dt>
        <dd>
          <LinearStateIcon state={issue.state} /> {issue.state.name}
        </dd>
        <dt>{t('linear.tooltip.priority')}</dt>
        <dd>
          <LinearPriorityIcon priority={issue.priority} /> {t(PRIORITY_KEY[priorityKey])}
        </dd>
        {issue.project?.name && (<>
          <dt>{t('linear.tooltip.project')}</dt>
          <dd>{issue.project.name}</dd>
        </>)}
        <dt>{t('linear.tooltip.updated')}</dt>
        <dd title={new Date(issue.updatedAt).toLocaleString()}>{relTime(issue.updatedAt, t)}</dd>
      </dl>
      <div className="tip-foot mono">{issue.url}</div>
    </div>
  );
}

function LinearRow({ issue, onSpawn, onRefresh, canChangeStatus, chatLink, isNew, onMarkSeen, onContextMenu }: {
  issue: LinearIssueDto;
  onSpawn: (t: Ticket) => void;
  onRefresh: () => void;
  /** When false, the status is shown as a read-only glyph (the active
   *  tracker can't change status from PopBot — e.g. GitHub Issues). */
  canChangeStatus: boolean;
  chatLink?: { open: boolean; focused: boolean; slotId: number | null; pr: number | null };
  isNew: boolean;
  onMarkSeen?: (identifier: string) => void;
  onContextMenu?: (issue: LinearIssueDto, x: number, y: number) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const ticket = issueToTicket(issue);
  const pulsing = usePulseActive('linear-issue', issue.id);
  const linkedTitle = chatLink?.focused
    ? t('linear.row.linkedFocused', { id: ticket.id })
    : chatLink?.open
      ? t('linear.row.linkedOpen', { id: ticket.id })
      : chatLink
        ? t('linear.row.linkedClosed', { id: ticket.id })
        : t('linear.row.linkedDefault', { id: ticket.id, title: ticket.title });
  return (
    <Tooltip content={<IssueTooltip issue={issue} />}>
      <div
        data-pulse-id={`linear-issue:${issue.id}`}
        className={`row ${pulsing ? 'pulse' : ''} ${chatLink ? 'has-chat' : ''} ${chatLink?.focused ? 'is-focused' : ''} ${isNew ? 'is-new' : ''}`}
        onClick={() => {
          // Any interaction with a NEW row counts as acknowledgment —
          // dismiss the chip + decrement the tab pip. Done here so a
          // click on the row body (to spawn / focus) also clears it,
          // not just the dedicated chip.
          if (isNew) onMarkSeen?.(issue.identifier);
          onSpawn(ticket);
        }}
        onContextMenu={(e) => {
          if (!onContextMenu) return;
          e.preventDefault();
          if (isNew) onMarkSeen?.(issue.identifier);
          onContextMenu(issue, e.clientX, e.clientY);
        }}
        aria-label={linkedTitle}
      >
        <span className="status-ico-wrap"><LinearPriorityIcon priority={issue.priority} /></span>
        {isNew && (
          <button
            type="button"
            className="row-new-chip"
            title={t('common.markAsSeen')}
            onClick={(e) => { e.stopPropagation(); onMarkSeen?.(issue.identifier); }}
          >
            {t('reviews.row.newChip')}
          </button>
        )}
        <span className="id">{ticket.id}</span>
        <span className="title">{ticket.title}</span>
        <span className="meta">
          {chatLink && (
            <span
              className={`pill ${chatLink.focused ? 'done' : chatLink.open ? 'wait' : 'muted'}`}
              title={linkedTitle}
            >
              <i className="fa-solid fa-comment" />{' '}
              {chatLink.pr != null
                ? t('panelB.kind.pr', { pr: chatLink.pr })
                : chatLink.slotId != null
                  ? `S${chatLink.slotId}`
                  : chatLink.open ? t('reviews.row.chatPill') : t('reviews.row.closedPill')}
            </span>
          )}
          {canChangeStatus ? (
            <StatusPicker issue={issue} onChanged={onRefresh} />
          ) : (
            // Tracker can't change status from PopBot (e.g. GitHub Issues,
            // which only have open/closed). Show a read-only status glyph.
            <span
              className="status-picker-btn read-only"
              title={`Status: ${issue.state.name}`}
              aria-label={`Status: ${issue.state.name}`}
            >
              <LinearStateIcon state={issue.state} />
            </span>
          )}
          {/* Open-in-Linear is now via right-click → "Open web page". */}
        </span>
      </div>
    </Tooltip>
  );
}

function LinearTickets({
  status,
  onSpawn,
  onOpenPrefs,
  onRefresh,
  canChangeStatus,
  ticketChats,
  ignoredTickets,
  isNew,
  onMarkSeen,
  onContextMenu,
}: LinearTicketsProps): JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    () => Object.fromEntries(GROUPS.map((g) => [g.key, g.defaultOpen])),
  );

  if (status.kind === 'loading') {
    return <div className="empty"><div className="ico">…</div><div>{t('linear.list.loading')}</div></div>;
  }
  if (status.kind === 'not-configured') {
    return (
      <div className="empty">
        <div className="ico"><i className="fa-solid fa-ticket" /></div>
        <div>{t('linear.empty.notConfigured')}</div>
        {onOpenPrefs && (
          <button className="btn primary sm" onClick={() => onOpenPrefs('integ')}>
            <i className="fa-solid fa-plug" /> {t('linear.empty.connectButton')}
          </button>
        )}
      </div>
    );
  }
  if (status.kind === 'auth-failed') {
    return (
      <div className="empty">
        <div className="ico"><i className="fa-solid fa-circle-exclamation" /></div>
        <div>{t('linear.empty.authFailed')}</div>
        {onOpenPrefs && (
          <button className="btn primary sm" onClick={() => onOpenPrefs('integ')}>{t('common.reconnect')}</button>
        )}
      </div>
    );
  }
  if (status.kind === 'error') {
    return (
      <div className="empty">
        <div className="ico"><i className="fa-solid fa-circle-exclamation" /></div>
        <div>{t('linear.error.loadFailed')}</div>
        <div className="hint">{status.message}</div>
        <button className="btn ghost sm" onClick={onRefresh}>{t('common.retry')}</button>
      </div>
    );
  }

  // Tickets that have already moved past dev work — Ready to Deploy /
  // Ready to Test — are filtered out of the Tickets tab so the queue
  // reflects "things that need code." Open chats with those tickets
  // remain in the chat list (driven by `ticketChats`, not by this
  // visible-issue list), so handoff state is preserved.
  // Also drop user-ignored tickets up front so they never count toward
  // emptiness checks or sort order.
  const ignoredSet = new Set(ignoredTickets ?? []);
  const upstream = status.issues
    .filter((i) => !isLateStageState(i.state.name))
    .filter((i) => !ignoredSet.has(i.identifier));

  const q = query.trim().toLowerCase();
  const filtered = q
    ? upstream.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.identifier.toLowerCase().includes(q) ||
          (i.project?.name?.toLowerCase().includes(q) ?? false),
      )
    : upstream;
  // Sort issues by recency (most recent first) before bucketing so each
  // group ends up sorted naturally.
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const buckets: Record<string, LinearIssueDto[]> = Object.fromEntries(
    GROUPS.map((g) => [g.key, []]),
  );
  for (const issue of sorted) {
    const g = GROUPS.find((x) => x.priority === issue.priority);
    if (g) buckets[g.key].push(issue);
  }

  return (
    <>
      <div className="linear-search">
        <i className="fa-solid fa-magnifying-glass" />
        <input
          type="text"
          placeholder={t('linear.search.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="linear-search-clear" title={t('common.clear')} onClick={() => setQuery('')}>×</button>
        )}
      </div>
      {sorted.length === 0 && (
        <div className="empty">
          <div className="ico">○</div>
          <div>{q ? t('linear.empty.noMatches') : t('linear.empty.noTickets')}</div>
        </div>
      )}
      {GROUPS.map((g) => {
        const items = buckets[g.key];
        if (items.length === 0) return null;
        const open = openGroups[g.key];
        return (
          <div key={g.key} className={`linear-group ${open ? '' : 'collapsed'}`}>
            <div
              className="linear-group-head"
              onClick={() => setOpenGroups((s) => ({ ...s, [g.key]: !s[g.key] }))}
            >
              <span className="caret">▼</span>
              <span className="status-ico-wrap"><LinearPriorityIcon priority={g.priority} /></span>
              {t(g.labelKey)}
              <span className="count">{items.length}</span>
            </div>
            {open && items.map((issue) => (
              <LinearRow
                key={issue.id}
                issue={issue}
                onSpawn={onSpawn}
                onRefresh={onRefresh}
                canChangeStatus={canChangeStatus}
                chatLink={ticketChats?.get(issue.identifier)}
                isNew={isNew?.(issue.identifier) ?? false}
                onMarkSeen={onMarkSeen}
                onContextMenu={onContextMenu}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

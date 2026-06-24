import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { RAW_CHAT_REPO_ID, type ChatRecord } from '@shared/persistence';
import { Titlebar } from './components/Titlebar';
import { AboutDialog } from './components/AboutDialog';
import { PanelA } from './components/PanelA';
import { PanelB } from './components/PanelB';
import { MonitorCard } from './components/MonitorCard';
import { ChatColumn, EmptyColumn, ReadinessGateModal } from './components/ChatColumn';
import { PanelD } from './components/PanelD';
import { GitPanel } from './components/GitPanel';
import { DiffOverlay } from './components/DiffOverlay';
import { BaseBranchDialog } from './components/BaseBranchDialog';
import { ChatSettingsSheet } from './components/ChatSettingsSheet';
import { Modal } from './components/Modal';
import { PreferencesSheet } from './components/PreferencesSheet';
import { CloseChatPrompt } from './components/CloseChatPrompt';
import { BusyOverlay } from './components/BusyOverlay';
import {
  AGENT_EFFORT_DEFAULTS_SETTING,
  agentCreateConfigWithEffortDefaults,
  type AgentCreateConfig,
  type AgentEffortDefaultsSettings,
} from './components/AgentCreateControls';
import { DEFAULT_RE_REVIEW_TEMPLATE, DEFAULT_START_CODE_REVIEW_TEMPLATE, DEFAULT_START_TICKET_TEMPLATE, expandTemplate } from './lib/templates';
import type { ReviewItem } from '@shared/reviews';
import type { LinearIssueDto } from '@shared/linear';
import { useLinearIssues } from './lib/useLinearIssues';
import { usePrStatusByChat } from './lib/usePrStatusByChat';
import { Toast } from './components/Toast';
import { useSettings } from './lib/useSettings';
import { useUpdates } from './lib/useUpdates';
import { HighlightProvider } from './lib/highlightBus';
import { playPing, playUrgentDing } from './lib/ping';
import type { NotificationAction, NotificationRecord } from '@shared/notifications';
import { NotificationToastStack } from './components/NotificationToast';
import type { CreateChatInput } from '@shared/ipc';
import { useChats } from './lib/useChats';
import { useReadiness } from './lib/useReadiness';
import { hotkey } from './lib/hotkeys';
import {
  type Chat as ChatFixture,
  type Ticket,
  type SlackItem,
} from './fixtures/data';

type ColumnLayoutVars = CSSProperties & {
  '--col-left': string;
  '--row-bottom': string;
  '--col-right'?: string;
};

/** Min width per column. Mirrors `.col { min-width }` in prototype.css.
 *  TODO: make this user-adjustable in prefs. */
const MIN_COL_WIDTH = 560;

/**
 * Adapter: many of the prototype-derived components (PanelB row,
 * MonitorCard) still expect the fixture's Chat shape. Project the live
 * ChatRecord into that shape until those components are migrated to take
 * ChatRecord directly.
 */
function chatRecordToFixture(c: ChatRecord): ChatFixture {
  return {
    id: c.id,
    name: c.name,
    branch: c.branch ?? '(no branch)',
    status: c.status,
    timestamp: relativeTime(c.lastActiveAt),
    tokens: { used: c.tokensUsed, budget: c.tokensBudget },
    snippet: c.snippet,
    type: c.type,
    ticket: c.ticket ?? undefined,
    pr: c.pr ?? undefined,
    agent: c.agent,
    slotId: c.slotId,
    worktreePath: c.worktreePath,
    repoColor: c.repoColor,
  };
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 30_000) return 'active now';
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function App(): JSX.Element {
  const { chats, closedChats, loading, create, close, reopen, attachSlot, remove, refresh } = useChats();
  // The visible columns are a contiguous window of `chats`. windowStart is
  // the index of the leftmost visible chat. Click a thumbnail to scroll
  // the window so that chat is visible (and active).
  const [windowStart, setWindowStart] = useState<number>(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [foregroundId, setForegroundId] = useState<string | null>(null);
  const [settingsForId, setSettingsForId] = useState<string | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefsSection, setPrefsSection] = useState<string | undefined>(undefined);
  // Bumped whenever setup might have changed (Preferences closed, repos
  // edited) so the readiness checklist re-probes agents + repos.
  const [readinessVersion, setReadinessVersion] = useState(0);
  // Single source of truth for "can the user create a chat yet" — needs
  // at least one AI provider (claude/codex) AND one repository. Drives
  // both the empty-pane checklist and the gating of every create
  // affordance (central +, ⌘T/⌘K, PanelB +, ticket / PR / Slack spawn).
  const readiness = useReadiness(readinessVersion);
  // When the user tries to start a chat any other way before setup is
  // done, we pop the same checklist as the center pane.
  const [gateOpen, setGateOpen] = useState(false);
  /** Returns true when a chat can be created; otherwise pops the
   *  "finish setup" gate modal and returns false. Probe-in-flight is
   *  treated as ready so we never block on a transient null. */
  const requireReady = useCallback((): boolean => {
    if (readiness.loading || readiness.ready) return true;
    setGateOpen(true);
    return false;
  }, [readiness.loading, readiness.ready]);
  const [linearVersion, setLinearVersion] = useState(0);
  // Fire a notification for each Linear issue that wasn't in the
  // previous poll's set. The hook itself silently establishes a
  // baseline on first load, so users don't get spammed by their
  // existing queue on app start — only newly-arrived tickets fire.
  const onNewLinearIssues = useCallback((fresh: LinearIssueDto[]) => {
    for (const issue of fresh) {
      void window.popbot.notifications.dispatch({
        kind: 'ticket',
        urgency: issue.priority === 1 ? 'high' : 'med',
        source: 'Linear',
        title: `${issue.identifier} · ${issue.title}`,
        subtitle: issue.project?.name ? `New ticket · ${issue.project.name}` : 'New ticket',
        summary: '',
        actor: { name: 'Linear', avatar: 'LI', color: '#5e6ad2' },
        actions: [
          { kind: 'external', label: 'Open in Linear', url: issue.url, primary: true },
          { kind: 'internal', label: 'Show in PopBot', targetKind: 'linear-issue', targetId: issue.id },
        ],
        dedupKey: `ticket:${issue.id}`,
      });
    }
  }, []);
  // Lifted out of PanelA so the same poll feeds the ticket list AND
  // the per-chat status chip on every column. PanelA still drives the
  // refresh button via `refreshLinear`; the chips re-render whenever
  // the issue list updates because they read out of `ticketByIdentifier`.
  const { status: linearStatus, refresh: refreshLinear } = useLinearIssues(linearVersion, {
    onNew: onNewLinearIssues,
  });
  // Map carries both state (for the chip's color/icon/label) and url
  // (for click-to-open) so the chip never needs to re-fetch from
  // listIssues at click time.
  const ticketByIdentifier = (() => {
    type TicketChipData = {
      state: { name: string; type: string; color?: string };
      url: string;
    };
    if (linearStatus.kind !== 'ok') return new Map<string, TicketChipData>();
    return new Map(
      linearStatus.issues.map((i) => [i.identifier, { state: i.state, url: i.url }] as const),
    );
  })();
  // PR status, polled at the same cadence as Linear via the lifted
  // hook. Keys are chat ids — the chip needs both PR state (for
  // color/icon/label) and url (for click-to-open).
  const prByChatId = usePrStatusByChat(chats);
  /** Bumped when slot configuration changes (count saved, slots
   *  initialized, slots deleted) so the PanelB strip re-fetches. */
  const [slotConfigVersion, setSlotConfigVersion] = useState(0);
  /** Whole-window "please wait" overlay shown during slow main-side
   *  work (git worktree add, checkout, stash pop, …). */
  const [busy, setBusy] = useState<{ message: string; detail?: string } | null>(null);
  /** Chat that's mid-close (showing the CloseChatPrompt). */
  const [closingChat, setClosingChat] = useState<ChatRecord | null>(null);
  /** True when a chat-create failed because the slot pool is full. */
  const [noSlotsOpen, setNoSlotsOpen] = useState(false);
  /** About dialog (Help ▸ About PopBot, or the native macOS app menu). */
  const [aboutOpen, setAboutOpen] = useState(false);
  const { get: getSetting, set: setAppSetting, loading: settingsLoading } = useSettings();
  const [gitPanelOpen, setGitPanelOpen] = useState<boolean>(false);
  // Hydrate sidebar state once settings have loaded; remembers last
  // open/closed across restarts.
  useEffect(() => {
    if (settingsLoading) return;
    const ui = getSetting<{ gitPanelOpen?: boolean; gitPanelWidth?: number }>('ui', {});
    if (ui?.gitPanelOpen) setGitPanelOpen(true);
    if (typeof ui?.gitPanelWidth === 'number' && ui.gitPanelWidth > 0) {
      setColRight(Math.max(240, Math.min(720, ui.gitPanelWidth)));
    }
    // settingsLoading toggles exactly once on initial fetch — that's
    // when we want this to fire, not on every getSetting identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoading]);
  const toggleGitPanel = useCallback(() => {
    setGitPanelOpen((prev) => {
      const next = !prev;
      void setAppSetting('ui', {
        ...(getSetting<Record<string, unknown>>('ui', {}) ?? {}),
        gitPanelOpen: next,
      });
      return next;
    });
  }, [getSetting, setAppSetting]);

  const openPrefsAt = useCallback((sectionId?: string) => {
    setPrefsSection(sectionId);
    setPrefsOpen(true);
  }, []);
  const [modal, setModal] = useState<string | null>(null);
  const [colWidth, setColWidth] = useState<number>(280);
  const [bottomHeight, setBottomHeight] = useState<number>(240);
  const [colRight, setColRight] = useState<number>(360);
  // Persistent diff overlay state — lifted out of GitPanel so the
  // overlay can live at the workspace level and survive re-renders.
  const [diffView, setDiffView] = useState<{
    chatId: string;
    scope: import('@shared/git').GitScope;
    path: string;
  } | null>(null);
  const closeDiff = useCallback(() => setDiffView(null), []);
  // Pending chat-creation that's waiting for the repo + base-branch
  // picker. The dialog returns BOTH because base-branch lists are
  // per-repo, so the user has to pick the repo first.
  const [pendingCreate, setPendingCreate] = useState<{
    subtitle: string;
    initialBase?: string;
    /** When set, the dialog also asks the user for a chat subject
     *  (and derives the branch name from it). Used by the generic
     *  "+" / Cmd-K new-chat flow where there's no ticket/PR. */
    askSubject?: boolean;
    /** Generic new-chat flow can intentionally skip repo selection. */
    allowNoRepo?: boolean;
    /** Generic lite chats can run from repo root without a slot. */
    allowRepoRoot?: boolean;
    /** Creation flows can pick the backend before the first prompt. */
    showAgentPicker?: boolean;
    run: (input: {
      repoId: string | null;
      baseBranch: string | null;
      subject?: string;
      branch?: string;
      workspaceMode?: 'slot' | 'repo-root';
      agentConfig?: AgentCreateConfig;
    }) => void | Promise<void>;
  } | null>(null);
  const openDiff = useCallback(
    (scope: import('@shared/git').GitScope, path: string) => {
      if (focusedId) setDiffView({ chatId: focusedId, scope, path });
    },
    [focusedId],
  );
  const [columnsWidth, setColumnsWidth] = useState<number>(0);
  /** Left panel: PanelA (work queues) height as a fraction of .left. */
  const [panelAFraction, setPanelAFraction] = useState<number>(0.38);
  const wsRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const centerHeadRef = useRef<HTMLDivElement | null>(null);
  const thumbstripRef = useRef<HTMLDivElement | null>(null);
  const visibleStartRef = useRef<HTMLDivElement | null>(null);
  const visibleEndRef = useRef<HTMLDivElement | null>(null);
  const [overlayRect, setOverlayRect] = useState<{
    left: number;
    width: number;
    top: number;
    height: number;
  } | null>(null);

  // Track the available width for chat columns; visibleCols scales with it.
  // Trailing-edge debounce — each resize push the timer back; the
  // expensive refresh (which can mount/unmount ChatColumns when
  // visibleCols crosses MIN_COL_WIDTH) only fires once the user
  // actually stops dragging.
  useEffect(() => {
    const el = columnsRef.current;
    if (!el) return;
    setColumnsWidth(el.clientWidth);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = el.clientWidth;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) pending = entry.contentRect.width;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; setColumnsWidth(pending); }, 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, []);

  const visibleCols = Math.max(1, Math.floor(columnsWidth / MIN_COL_WIDTH) || 1);

  // Free-floating overlay around the visible thumbnails. Lives as a sibling
  // of the thumbstrip (inside center-head) to avoid the strip's overflow
  // clip — and computes its rect relative to center-head so vertical insets
  // don't get cut off.
  const computeOverlay = useCallback(() => {
    const head = centerHeadRef.current;
    const start = visibleStartRef.current;
    const end = visibleEndRef.current;
    if (!head || !start || !end) {
      setOverlayRect(null);
      return;
    }
    const headRect = head.getBoundingClientRect();
    const startRect = start.getBoundingClientRect();
    const endRect = end.getBoundingClientRect();
    const PAD_X = 2;
    const PAD_Y = 2;
    setOverlayRect({
      left: startRect.left - headRect.left - PAD_X,
      top: startRect.top - headRect.top - PAD_Y,
      width: endRect.right - startRect.left + PAD_X * 2,
      height: startRect.height + PAD_Y * 2,
    });
  }, []);

  useLayoutEffect(() => {
    computeOverlay();
  }, [computeOverlay, chats, windowStart, visibleCols]);

  useEffect(() => {
    const head = centerHeadRef.current;
    const strip = thumbstripRef.current;
    if (!head) return;
    // Debounced — computeOverlay does getBoundingClientRect calls
    // that force layout. While the user drags, every pixel pushes the
    // refresh further out; it fires once they stop.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; computeOverlay(); }, 150);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(head);
    if (strip) {
      ro.observe(strip);
      strip.addEventListener('scroll', schedule, { passive: true });
    }
    return () => {
      ro.disconnect();
      strip?.removeEventListener('scroll', schedule);
      if (timer) clearTimeout(timer);
    };
  }, [computeOverlay]);

  // Keep windowStart in range as chats grow / shrink. Also seed focusedId
  // on the first non-empty load.
  useEffect(() => {
    if (loading) return;
    if (chats.length === 0) {
      setWindowStart(0);
      setFocusedId(null);
      return;
    }
    const maxStart = Math.max(0, chats.length - visibleCols);
    if (windowStart > maxStart) setWindowStart(maxStart);
    if (focusedId === null || !chats.some((c) => c.id === focusedId)) {
      setFocusedId(chats[Math.min(windowStart, maxStart)].id);
    }
  }, [chats, loading, windowStart, focusedId, visibleCols]);

  const resizeHRef = useRef<HTMLDivElement | null>(null);
  const startResizeH = (e: MouseEvent) => {
    e.preventDefault();
    let last = colWidth;
    // Skip React re-renders during the drag — they cascade through
    // every chat column / diff / markdown render and are expensive.
    // Just rewrite the layout CSS variable + the handle's `left`
    // directly, then commit to React state on mouseup.
    const onMove = (ev: globalThis.MouseEvent) => {
      const w = Math.max(220, Math.min(420, ev.clientX));
      last = w;
      const ws = wsRef.current;
      const rh = resizeHRef.current;
      if (ws) ws.style.setProperty('--col-left', w + 'px');
      if (rh) rh.style.left = w + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setColWidth(last);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const resizeHRightRef = useRef<HTMLDivElement | null>(null);
  const startResizeHRight = (e: MouseEvent) => {
    e.preventDefault();
    let last = colRight;
    const onMove = (ev: globalThis.MouseEvent) => {
      const w = Math.max(240, Math.min(720, window.innerWidth - ev.clientX));
      last = w;
      const ws = wsRef.current;
      const rh = resizeHRightRef.current;
      if (ws) ws.style.setProperty('--col-right', w + 'px');
      if (rh) rh.style.right = w + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setColRight(last);
      void setAppSetting('ui', {
        ...(getSetting<Record<string, unknown>>('ui', {}) ?? {}),
        gitPanelWidth: last,
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startResizeV = (e: MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: globalThis.MouseEvent) => {
      const h = window.innerHeight - ev.clientY;
      setBottomHeight(Math.max(120, Math.min(window.innerHeight - 220, h)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  /** Vertical splitter between PanelA (work queues) and PanelB (chat
   *  list) inside the .left column. */
  const startResizePanelA = (e: MouseEvent) => {
    e.preventDefault();
    const left = leftRef.current;
    if (!left) return;
    const rect = left.getBoundingClientRect();
    const onMove = (ev: globalThis.MouseEvent) => {
      const fraction = (ev.clientY - rect.top) / rect.height;
      setPanelAFraction(Math.max(0.15, Math.min(0.85, fraction)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const fixtures = chats.map(chatRecordToFixture);
  const inactiveFixtures = closedChats.map(chatRecordToFixture);
  const focusedRecord = chats.find((c) => c.id === focusedId);
  const settingsChat = chats.find((c) => c.id === settingsForId);

  // PR-number → chat-state index for the Reviews panel. Open chats
  // win over closed ones if both exist for the same PR.
  const reviewChats = new Map<number, { open: boolean; focused: boolean }>();
  for (const c of closedChats) {
    if (c.pr != null) reviewChats.set(c.pr, { open: false, focused: false });
  }
  for (const c of chats) {
    if (c.pr != null) reviewChats.set(c.pr, { open: true, focused: c.id === focusedId });
  }

  // Same idea for Linear tickets — `chat.ticket` holds the identifier
  // (ENG-1234). Drives the "this ticket is being worked on" treatment
  // on Linear rows: highlight class + slot/PR chip.
  const ticketChats = new Map<string, { open: boolean; focused: boolean; slotId: number | null; pr: number | null }>();
  for (const c of closedChats) {
    if (c.ticket) ticketChats.set(c.ticket, { open: false, focused: false, slotId: c.slotId, pr: c.pr });
  }
  for (const c of chats) {
    if (c.ticket) ticketChats.set(c.ticket, {
      open: true, focused: c.id === focusedId, slotId: c.slotId, pr: c.pr,
    });
  }

  const visibleChats = chats.slice(windowStart, windowStart + visibleCols);
  const maxStart = Math.max(0, chats.length - visibleCols);

  /**
   * Click-on-thumbnail: scroll the window so the clicked chat is visible.
   * - Already visible → just focus, no scroll.
   * - One step outside the window on either side → slide the window by
   *   one so the clicked chat becomes the new edge.
   * - Far outside → snap so the clicked chat lands at the matching edge
   *   (left edge if it's to the left of the window; right edge if to the
   *   right).
   */
  const scrollToChat = (id: string) => {
    const idx = chats.findIndex((c) => c.id === id);
    if (idx < 0) return;
    setFocusedId(id);
    if (idx >= windowStart && idx < windowStart + visibleCols) return;
    const newStart = idx < windowStart ? idx : Math.max(0, idx - (visibleCols - 1));
    setWindowStart(Math.min(maxStart, Math.max(0, newStart)));
  };

  const closeCol = (id: string) => {
    const chat = chats.find((c) => c.id === id);
    if (!chat) return;
    // Worktree-backed chats always go through the prompt (parking +
    // optional stash). Lightweight chats close immediately.
    if (chat.slotId != null) {
      setClosingChat(chat);
    } else {
      void doClose(id, { stash: false });
    }
  };

  const doClose = async (id: string, opts: { stash: boolean }) => {
    if (focusedId === id) {
      const nextIdx = chats.findIndex((c) => c.id === id);
      const fallback = chats[nextIdx + 1] ?? chats[nextIdx - 1] ?? null;
      setFocusedId(fallback?.id ?? null);
    }
    await close(id, opts);
    setClosingChat(null);
  };

  /** Create the chat (with optional slot/worktree). Surfaces config
   *  gates by routing to the right Preferences page; surfaces "pool
   *  full" by routing to Preferences → Runtime so the user can raise
   *  the count. Shows a busy overlay during the slow git work. */
  const createWithSlot = async (
    input: CreateChatInput,
    opts?: { busy?: { message: string; detail?: string }; onCreated?: (chatId: string) => void },
  ) => {
    if (opts?.busy) setBusy(opts.busy);
    let result;
    try {
      result = await create(input);
    } finally {
      setBusy(null);
    }
    if (!result.ok) {
      if (result.reason === 'slots-not-configured') {
        openPrefsAt('runtime');
      } else if (result.reason === 'no-free-slot') {
        // Don't railroad into prefs — let the user cancel or jump in.
        setNoSlotsOpen(true);
      } else if (result.reason === 'git-not-configured') {
        openPrefsAt('git');
      } else if (result.reason === 'worktree-failed') {
        // eslint-disable-next-line no-console
        console.error('worktree setup failed:', result.message);
        setBusy({ message: 'Worktree setup failed', detail: result.message });
        setTimeout(() => setBusy(null), 2500);
      }
      return;
    }
    opts?.onCreated?.(result.chat.id);
    scrollToChat(result.chat.id);
  };

  /** First few words of the title, lowercased, with non-alphanumeric
   *  punctuation stripped and spaces turned into dashes. Used to build
   *  branch names like `<username>/<ticketId>-<slug>`. */
  const slugifyTitle = (title: string, maxWords = 6): string =>
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, maxWords)
      .join('-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

  // Branch-name username, auto-derived from gh/git (Source-control
  // override wins). Loaded once so ticket branches read `you/<slug>`.
  const [branchUsername, setBranchUsername] = useState('pop');
  useEffect(() => {
    void window.popbot.git.username().then((u) => { if (u) setBranchUsername(u); });
  }, []);

  const ticketBranch = (t: Ticket): string => {
    const override = getSetting<{ username?: string }>('git', {})?.username?.trim();
    const username = override || branchUsername || 'pop';
    return `${username}/${t.id.toLowerCase()}-${slugifyTitle(t.title)}`;
  };

  /** Focus an existing chat — and if it doesn't yet have a slot, kick
   *  off the attach-slot flow so it ends up with a real workspace. */
  const focusOrAttach = async (existing: ChatRecord) => {
    let target: ChatRecord | null;
    if (chats.some((c) => c.id === existing.id)) {
      target = existing;
    } else {
      const result = await reopen(existing.id);
      if (!result.ok) {
        if (result.reason === 'no-free-slot') setNoSlotsOpen(true);
        else if (result.reason === 'worktree-failed') {
          setBusy({ message: 'Worktree setup failed', detail: result.message });
          setTimeout(() => setBusy(null), 2500);
        }
        return;
      }
      target = result.chat;
    }
    if (!target) return;
    scrollToChat(target.id);
    if (target.slotId == null && target.branch) {
      setBusy({ message: 'Setting up workspace…', detail: `Checking out ${target.branch}` });
      let result;
      try {
        result = await attachSlot(target.id);
      } finally {
        setBusy(null);
      }
      if (!result.ok) {
        if (result.reason === 'slots-not-configured') openPrefsAt('runtime');
        else if (result.reason === 'no-free-slot') setNoSlotsOpen(true);
        else if (result.reason === 'git-not-configured') openPrefsAt('git');
        else if (result.reason === 'worktree-failed') {
          setBusy({ message: 'Worktree setup failed', detail: result.message });
          setTimeout(() => setBusy(null), 2500);
        }
      }
    }
  };

  const handleSpawnFromTicket = (t: Ticket) => {
    const existing =
      chats.find((c) => c.ticket === t.id) ??
      closedChats.find((c) => c.ticket === t.id);
    if (existing) { void focusOrAttach(existing); return; }
    if (!requireReady()) return;
    const branch = ticketBranch(t);
    setPendingCreate({
      subtitle: `${t.id} · ${t.title.slice(0, 60)}`,
      showAgentPicker: true,
      run: async ({ repoId, baseBranch, agentConfig }) => {
        if (!repoId || !baseBranch) return;
        await createWithSlot(
      {
        name: `${t.id} · ${t.title.slice(0, 60)}`,
        ticket: t.id,
        branch,
        baseBranch,
        type: 'lite',
        allocateSlot: true,
        repoId,
        ...agentConfig,
      },
      {
        busy: { message: 'Setting up workspace…', detail: `Branching ${branch} from ${baseBranch}` },
        onCreated: (chatId) => {
          // Auto-promote the ticket to "In Progress" when we open a
          // chat for it. Idempotent + scoped on the main side: only
          // upstream states (backlog/triage/unstarted) get touched;
          // anything already started, completed, or canceled is left
          // alone. Fire-and-forget — chat startup doesn't block on
          // the Linear API. After Linear acknowledges, the next
          // poll cycle (≤90s) refreshes the ticket list / chat chip.
          void window.popbot.linear.promoteIssue(t.id).then(() => refreshLinear());
          // Send the start-ticket prompt as the chat's first user message.
          // Falls back to the built-in default if the user hasn't customized it.
          const tmpl = (
            getSetting<{ startTicket?: string }>('templates', {})?.startTicket
            ?? DEFAULT_START_TICKET_TEMPLATE
          ).trim();
          if (!tmpl) return;
          // Look up the slot the chat just got assigned (post-create
          // state may not have hit React yet, so query by ticket).
          const justCreated = chats.find((c) => c.id === chatId);
          const slot = justCreated?.slotId ?? '';
          const description = t.description ?? '';
          const text = expandTemplate(tmpl, {
            ticketid: t.id,
            tickettitle: t.title,
            description,
            // Linear's `description` field is already markdown, so expose
            // it under both names — pick whichever reads better in your
            // template.
            markdown: description,
            ticketurl: t.url ?? '',
            priority: t.priority,
            project: t.project,
            branch,
            slot,
          });
          void window.popbot.agent.send({ chatId, text });
        },
      },
        );
      },
    });
  };

  /** Re-review action — fired by the RE-REVIEW chip on PanelA. Finds
   *  the existing PR chat (you reviewed once already → there should be
   *  one), focuses it, and sends the re-review template prompt so the
   *  agent picks up the second pass scoped to the author's new commits.
   *
   *  When no existing chat exists (you've never reviewed this PR via
   *  PopBot), fall back to the standard new-PR-chat flow so the user
   *  still gets a usable starting point. */
  const handleReReview = async (r: ReviewItem): Promise<void> => {
    const existing =
      chats.find((c) => c.pr === r.number) ??
      closedChats.find((c) => c.pr === r.number);
    const tmpl = (
      getSetting<{ reReview?: string }>('templates', {})?.reReview
      ?? DEFAULT_RE_REVIEW_TEMPLATE
    ).trim();
    if (existing) {
      // Focus first, then send the prompt. focusOrAttach handles
      // reopening a closed chat + restoring the workspace if needed.
      await focusOrAttach(existing);
      if (tmpl) {
        const text = expandTemplate(tmpl, {
          prnum: r.number,
          prtitle: r.title,
          branch: r.headRefName,
          slot: '',
        });
        void window.popbot.agent.send({ chatId: existing.id, text });
      }
      return;
    }
    // No prior chat — open a fresh one via the normal new-PR flow.
    // The re-review template is still the right prompt here (it's a
    // re-review request from GitHub's perspective even if PopBot's
    // history is empty).
    if (!requireReady()) return;
    await createWithSlot(
      {
        name: `[CR] PR #${r.number} · ${r.title.slice(0, 80)}`,
        pr: r.number,
        type: 'lite',
        repoId: defaultRepoId(),
        ...codeReviewAgentConfig(),
      },
      {
        onCreated: (chatId) => {
          if (!tmpl) return;
          const text = expandTemplate(tmpl, {
            prnum: r.number,
            prtitle: r.title,
            branch: r.headRefName,
            slot: '',
          });
          void window.popbot.agent.send({ chatId, text });
        },
      },
    );
  };

  const handleSpawnFromReview = async (r: ReviewItem, agentConfig?: AgentCreateConfig) => {
    const existing =
      chats.find((c) => c.pr === r.number) ??
      closedChats.find((c) => c.pr === r.number);
    if (existing) { void focusOrAttach(existing); return; }
    if (!requireReady()) return;
    // Review chats are read-only against the configured repo: no slot,
    // no worktree, no branch checkout. The agent gets the repo as cwd
    // (via AgentHost's repo-fallback) so `gh` works.
    const reviewAgentConfig = agentConfig ?? codeReviewAgentConfig();
    await createWithSlot(
      {
        // `[CR]` prefix so review chats are obvious in the column
        // header + thumbnail strip vs. work / ticket chats.
        name: `[CR] PR #${r.number} · ${r.title.slice(0, 80)}`,
        pr: r.number,
        type: 'lite',
        repoId: defaultRepoId(),
        ...reviewAgentConfig,
      },
      {
        onCreated: (chatId) => {
          const tmpl = (
            getSetting<{ startCodeReview?: string }>('templates', {})?.startCodeReview
            ?? DEFAULT_START_CODE_REVIEW_TEMPLATE
          ).trim();
          if (!tmpl) return;
          const text = expandTemplate(tmpl, {
            prnum: r.number,
            prtitle: r.title,
            branch: r.headRefName,
            slot: '',
          });
          void window.popbot.agent.send({ chatId, text });
        },
      },
    );
  };

  // Legacy single-toast slot used by the update-checker (the rich
  // notification toasts use `notifToasts` below).
  const [toast, setToast] = useState<{ message: string; detail?: string; onClick?: () => void } | null>(null);
  // Live stack of notification-style rich toasts (max 4). Populated by
  // the notifications subscriber; dismissed individually after TTL.
  const [notifToasts, setNotifToasts] = useState<NotificationRecord[]>([]);
  // Top-center + fly-to-bell mode. Off by default; user opts in via
  // Preferences > Notifications. Loaded once on mount and re-loaded
  // when the prefs sheet closes (its save round-trips through the
  // settings store, so a fresh read picks up the change).
  // Default ON: top-center placement is the right call for the wide
  // displays this app targets. Users who prefer the corner toast can
  // turn it off in Preferences > Notifications. Treat an undefined or
  // never-saved value as "on" so first-run picks up the new default.
  const [centerFly, setCenterFly] = useState(true);
  useEffect(() => {
    const load = (): void => {
      void window.popbot.settings
        .get<{ centerFly?: boolean }>('notifications')
        .then((s) => setCenterFly(s?.centerFly !== false));
    };
    load();
    // PrefsNotifications dispatches this event after a successful
    // save so the live App picks up the change without needing a
    // full reload.
    const onChange = (): void => load();
    window.addEventListener('popbot:notifications-prefs-changed', onChange);
    return () => window.removeEventListener('popbot:notifications-prefs-changed', onChange);
  }, []);
  // Cache of the most recent review list so the toast/notification
  // click can hand a fully-hydrated ReviewItem to handleSpawnFromReview
  // without an extra IPC round-trip.
  const reviewsCacheRef = useRef<ReviewItem[]>([]);

  // Action router: fires when the user clicks a notification action
  // from either the bell dropdown or a toast. Hands off to the right
  // subsystem (highlight bus, external open, chat spawn).
  const routeAction = useCallback((_n: NotificationRecord, action: NotificationAction) => {
    switch (action.kind) {
      case 'external':
        window.open(action.url, '_blank');
        return;
      case 'internal':
        // Special-case 'review': the review-tab row click already
        // spawns / focuses the chat, so an "internal" review action
        // just navigates + pulses (the "Spawn" action below handles
        // direct chat creation).
        window.dispatchEvent(new CustomEvent('popbot:highlight', {
          detail: { kind: action.targetKind, id: action.targetId },
        }));
        return;
      case 'spawn': {
        if (action.pr != null) {
          const match = reviewsCacheRef.current.find((x) => x.number === action.pr);
          if (match) { void handleSpawnFromReview(match); return; }
        }
        if (action.ticketId) {
          // No fast lookup available yet — surface the ticket via the
          // highlight bus so the user lands on the row and can spawn
          // from there. (Direct ticket-spawn IPC could be added later.)
          window.dispatchEvent(new CustomEvent('popbot:highlight', {
            detail: { kind: 'linear-issue', id: action.ticketId },
          }));
        }
        return;
      }
      case 'dismiss':
        // Mark-read happens automatically when the bell dropdown opens.
        // For toast click, the dismiss is implicit in the toast-leave.
        return;
    }
  }, []);

  // Subscribe to incoming notifications: pop a rich toast + ding by
  // urgency. The bell dropdown listens via its own hook for the
  // persisted list — this subscriber is only for the live-toast surface.
  useEffect(() => {
    return window.popbot.notifications.onAdded((rec) => {
      if (rec.urgency === 'high') playUrgentDing();
      else if (rec.urgency === 'med') playPing();
      // 'low' is silent — surfaces in the bell dropdown only.
      if (rec.urgency === 'low') return;
      setNotifToasts((prev) => [...prev.filter((t) => t.id !== rec.id), rec].slice(-4));
    });
  }, []);

  const dismissNotifToast = useCallback((id: string) => {
    setNotifToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Fire a notification per fresh PR — same baseline-then-diff
  // pattern useReviews already uses, so existing PRs at app start
  // don't dump into the bell. Re-requests / new mentions / etc.
  // would be additional fan-outs once those signals are wired up
  // separately; this just covers "a PR you didn't see before
  // appeared in your review queue."
  const onNewReviews = useCallback((fresh: ReviewItem[]) => {
    for (const r of fresh) {
      // Re-reviews dispatch as their own event so they aren't dedup-
      // suppressed by the original "new PR" notification (which would
      // share `review:N`). They're also high-urgency unconditionally
      // — the author asked for the user back specifically.
      const isReReview = r.flags.reReview;
      void window.popbot.notifications.dispatch({
        kind: 'review',
        urgency: isReReview || r.flags.requestedReviewer ? 'high' : 'med',
        source: 'GitHub',
        title: `#${r.number} · ${r.title}`,
        subtitle: isReReview
          ? (r.author ? `Re-review requested · by ${r.author}` : 'Re-review requested')
          : (r.author ? `New PR · by ${r.author}` : 'New PR'),
        summary: '',
        actor: { name: r.author || 'GitHub', avatar: (r.author || '?').slice(0, 2).toUpperCase(), color: '#9b51e0' },
        actions: [
          { kind: 'external', label: 'Open on GitHub', url: r.url, primary: true },
          { kind: 'internal', label: 'Show in PopBot', targetKind: 'review', targetId: String(r.number) },
        ],
        dedupKey: isReReview ? `review:${r.number}:rereview` : `review:${r.number}`,
      });
    }
  }, []);

  // Surface "newer release on GitHub" pushes from main as a clickable
  // toast that opens the release page. Reuses the review-toast slot —
  // collisions are rare given the main-side 3h quiet window.
  // Native macOS app menu → "About PopBot" opens our custom dialog.
  useEffect(() => window.popbot.updates.onShowAbout(() => setAboutOpen(true)), []);

  const {
    available: update,
    downloaded: updateReady,
    dismiss: dismissUpdate,
    install: installUpdate,
  } = useUpdates();
  // Manual-download fallback (unsigned build / updater error): open the
  // release page in the browser.
  useEffect(() => {
    if (!update) return;
    setToast({
      message: `Update available — ${update.name}`,
      detail: `You're on v${update.current}. Click to download v${update.latest}.`,
      onClick: () => {
        window.open(update.htmlUrl, '_blank');
        dismissUpdate();
        setToast(null);
      },
    });
  }, [update, dismissUpdate]);
  // In-app auto-update staged and ready: clicking quits and relaunches into
  // the new version.
  useEffect(() => {
    if (!updateReady) return;
    setToast({
      message: `Update ready — ${updateReady.name}`,
      detail: `v${updateReady.version} downloaded. Click to restart and install.`,
      onClick: () => installUpdate(),
    });
  }, [updateReady, installUpdate]);

  /** Best-effort default repo for "no-prompt" chat creation paths
   *  (review chats, Slack chats) — they don't surface the
   *  BaseBranchDialog, so they reuse whatever repo the user last
   *  picked there. Falls back to 'app' so single-repo installs
   *  keep working unchanged. */
  const defaultRepoId = (): string =>
    getSetting<string>('chatCreate.lastRepoId', 'app') ?? 'app';

  const codeReviewAgentConfig = (): AgentCreateConfig =>
    agentCreateConfigWithEffortDefaults(
      getSetting<AgentCreateConfig>('chatCreate.lastAgentConfig'),
      getSetting<AgentEffortDefaultsSettings>(AGENT_EFFORT_DEFAULTS_SETTING),
      'codeReview',
    );

  const handleSpawnFromSlack = async (s: SlackItem) => {
    if (!requireReady()) return;
    // Slack chats are exploratory — no slot, no worktree → no base branch.
    await createWithSlot({ name: `${s.ch} · ${s.who}`, type: 'lite', repoId: defaultRepoId() });
  };

  const handleNewChat = (type: 'lite' | 'client_test' = 'lite') => {
    // Hard prerequisites: an AI provider AND a repository. Until both are
    // set up, pop the "finish setup" checklist instead of opening a
    // create flow that can't complete.
    if (!requireReady()) return;
    // No ticket / PR context to source name & branch from — the dialog
    // will collect a subject from the user and derive the branch as
    // `<username>/<slug>`. createWithSlot calls scrollToChat on success
    // so the new chat lands at the right edge of the strip.
    setPendingCreate({
      subtitle: type === 'lite' ? 'New chat' : 'New client-test chat',
      askSubject: true,
      allowNoRepo: true,
      allowRepoRoot: type === 'lite',
      showAgentPicker: true,
      run: async ({ repoId, baseBranch, subject, branch, workspaceMode, agentConfig }) => {
        const name = (subject?.trim() || (type === 'lite' ? 'New chat' : 'New client-test chat'));
        if (repoId === null) {
          await createWithSlot({
            name,
            type,
            repoId: RAW_CHAT_REPO_ID,
            ...agentConfig,
          });
          return;
        }
        if (workspaceMode === 'repo-root') {
          await createWithSlot({
            name,
            type,
            repoId,
            ...agentConfig,
          });
          return;
        }
        if (!baseBranch) return;
        await createWithSlot({
          name,
          type,
          baseBranch,
          branch,
          allocateSlot: true,
          repoId,
          ...agentConfig,
        });
      },
    });
  };

  // Cmd-K (Ctrl-K elsewhere) → "+ new chat" — the same flow as the
  // thumbnail bar's "+" button. We skip the shortcut while focus is on
  // a text input / textarea / contentEditable so it doesn't intercept
  // editor / chat-input shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (target.isContentEditable) return;
      }
      e.preventDefault();
      handleNewChat('lite');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // handleNewChat closes over fresh state via setPendingCreate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const workspaceStyle: ColumnLayoutVars = {
    '--col-left': colWidth + 'px',
    '--row-bottom': bottomHeight + 'px',
    ...(gitPanelOpen ? { '--col-right': colRight + 'px' } : {}),
  };

  return (
    <HighlightProvider>
    <div
      className={`app${window.popbot.platform === 'win32' ? ' platform-win' : window.popbot.platform === 'linux' ? ' platform-linux' : ''}`}
      data-screen-label="PopBot · Main"
    >
      <Titlebar
        onOpenModal={setModal}
        onOpenPrefs={() => openPrefsAt()}
        onNewChat={() => void handleNewChat('lite')}
        onOpenAbout={() => setAboutOpen(true)}
        gitPanelOpen={gitPanelOpen}
        onToggleGitPanel={toggleGitPanel}
        onNotificationAction={routeAction}
        centerFly={centerFly}
      />
      <div
        className={`workspace${gitPanelOpen ? ' git-panel-open' : ''}`}
        ref={wsRef}
        style={workspaceStyle}
      >
        <div
          className="left"
          ref={leftRef}
          style={{ '--panel-a-h': `${(panelAFraction * 100).toFixed(2)}%` } as CSSProperties}
        >
          <PanelA
            onSpawnFromTicket={handleSpawnFromTicket}
            onSpawnFromReview={(r, agentConfig) => void handleSpawnFromReview(r, agentConfig)}
            onReReview={(r) => void handleReReview(r)}
            onSpawnFromSlack={handleSpawnFromSlack}
            // Search picker → click chat result → reopen + focus
            // (mirrors what clicking a list row does).
            onFocusChat={(chatId) => {
              const found = chats.find((c) => c.id === chatId)
                ?? closedChats.find((c) => c.id === chatId);
              if (found) void focusOrAttach(found);
            }}
            onOpenPrefs={openPrefsAt}
            linearStatus={linearStatus}
            refreshLinear={refreshLinear}
            onNewReviews={onNewReviews}
            reviewChats={reviewChats}
            ticketChats={ticketChats}
          />
          <div className="resize-v" onMouseDown={startResizePanelA} title="Drag to resize" />
          <PanelB
            chats={fixtures}
            inactive={inactiveFixtures}
            focusedId={focusedId ?? ''}
            setFocusedId={scrollToChat}
            slotVersion={
              chats.length +
              chats.filter((c) => c.slotId != null).length +
              slotConfigVersion
            }
            onSetupSlots={() => openPrefsAt('runtime')}
            onOpenInactive={async (id) => {
              const result = await reopen(id);
              if (result.ok) {
                scrollToChat(result.chat.id);
              } else if (result.reason === 'no-free-slot') {
                setNoSlotsOpen(true);
              } else if (result.reason === 'worktree-failed') {
                setBusy({ message: 'Worktree setup failed', detail: result.message });
                setTimeout(() => setBusy(null), 2500);
              }
            }}
            onDelete={(id) => {
              if (focusedId === id) {
                const idx = chats.findIndex((c) => c.id === id);
                const fallback = chats[idx + 1] ?? chats[idx - 1] ?? null;
                setFocusedId(fallback?.id ?? null);
              }
              void remove(id);
            }}
            onNewChat={() => void handleNewChat('lite')}
            toFixture={chatRecordToFixture}
          />
        </div>
        <div
          ref={resizeHRef}
          className="resize-h"
          onMouseDown={startResizeH}
          style={{ position: 'absolute', left: colWidth, top: 40, bottom: 0, width: 4, zIndex: 10 }}
        />

        <div className="center">
          <div className="center-head" ref={centerHeadRef}>
            <div className="thumbstrip" ref={thumbstripRef}>
              {fixtures.length === 0 && (
                <div className="thumbstrip-empty">
                  <i className="fa-regular fa-images" />
                  <div className="thumbstrip-empty-text">
                    <strong>Thumbnails Panel</strong>
                    <span>Miniature versions of your chats will display here when you open chats.</span>
                  </div>
                </div>
              )}
              {fixtures.map((c, idx) => {
                const isVisible = idx >= windowStart && idx < windowStart + visibleCols;
                const isWindowStart = idx === windowStart;
                const isWindowEnd = idx === Math.min(fixtures.length, windowStart + visibleCols) - 1;
                const refSetter = isWindowStart || isWindowEnd
                  ? (el: HTMLDivElement | null) => {
                      if (isWindowStart) visibleStartRef.current = el;
                      if (isWindowEnd) visibleEndRef.current = el;
                    }
                  : undefined;
                return (
                  <MonitorCard
                    key={c.id}
                    chat={c}
                    isFocused={c.id === focusedId}
                    isForeground={c.id === foregroundId}
                    isVisible={isVisible}
                    refSetter={refSetter}
                    onClick={() => scrollToChat(c.id)}
                    onBringForward={() =>
                      setForegroundId((prev) => (prev === c.id ? null : c.id))
                    }
                  />
                );
              })}
            </div>
            {overlayRect && fixtures.length > 0 && (
              <div
                className="thumbstrip-overlay"
                aria-hidden
                style={{
                  left: overlayRect.left,
                  top: overlayRect.top,
                  width: overlayRect.width,
                  height: overlayRect.height,
                }}
              />
            )}
            <div className="center-actions">
              <button className="iconbtn" title={`Command palette ${hotkey('K')}`}>{hotkey('K')}</button>
              <button
                className="iconbtn primary"
                title={`New chat ${hotkey('T')}`}
                onClick={() => void handleNewChat('lite')}
              >
                +
              </button>
            </div>
          </div>

          <div className="columns" ref={columnsRef}>
            {visibleChats.map((chat) => (
              <ChatColumn
                key={chat.id}
                chat={chat}
                isForeground={foregroundId === chat.id}
                isActive={focusedId === chat.id}
                onActivate={() => setFocusedId(chat.id)}
                onClose={() => void closeCol(chat.id)}
                onOpenSettings={() => setSettingsForId(chat.id)}
                onChatUpdated={() => void refresh()}
                onOpenPrefs={openPrefsAt}
                ticket={chat.ticket ? ticketByIdentifier.get(chat.ticket) ?? null : null}
                pr={prByChatId.get(chat.id) ?? null}
              />
            ))}
            {visibleChats.length === 0 && !loading && (
              <EmptyColumn
                onNewChat={() => void handleNewChat('lite')}
                onOpenPrefs={openPrefsAt}
                readiness={readiness}
              />
            )}
          </div>
        </div>

        <div
          className="resize-v"
          onMouseDown={startResizeV}
          style={{
            position: 'absolute',
            left: colWidth + 4,
            right: gitPanelOpen ? colRight : 0,
            bottom: bottomHeight,
            height: 4,
            zIndex: 10,
          }}
        />

        <PanelD
          focusedChat={focusedRecord ? chatRecordToFixture(focusedRecord) : undefined}
          focusedRecord={focusedRecord ?? null}
        />

        {gitPanelOpen && (
          <>
            <div
              ref={resizeHRightRef}
              className="resize-h-right"
              onMouseDown={startResizeHRight}
              style={{ right: colRight }}
              title="Drag to resize"
            />
            <div className="right">
              <GitPanel
                chatId={focusedRecord?.id ?? null}
                chatName={focusedRecord?.name}
                chatTicket={focusedRecord?.ticket ?? null}
                chatSlot={focusedRecord?.slotId ?? null}
                chatRepoId={focusedRecord?.repoId ?? null}
                onClose={toggleGitPanel}
                diffPath={diffView?.path ?? null}
                onOpenDiff={openDiff}
                onCloseDiff={closeDiff}
              />
            </div>
          </>
        )}

        {diffView && (
          <>
            {/* Backdrop covering the chat area (left-of-git-panel,
                right-of-left-panel). Click closes the diff overlay;
                clicks inside `.diff-overlay` stop propagation. */}
            <div
              className="diff-overlay-backdrop"
              onMouseDown={closeDiff}
              style={{
                left: colWidth,
                right: gitPanelOpen ? colRight : 0,
              }}
            />
            <DiffOverlay
              chatId={diffView.chatId}
              scope={diffView.scope}
              path={diffView.path}
              onClose={closeDiff}
            />
          </>
        )}
      </div>

      {pendingCreate && (
        <BaseBranchDialog
          subtitle={pendingCreate.subtitle}
          initial={pendingCreate.initialBase}
          askSubject={pendingCreate.askSubject}
          allowNoRepo={pendingCreate.allowNoRepo}
          allowRepoRoot={pendingCreate.allowRepoRoot}
          showAgentPicker={pendingCreate.showAgentPicker}
          onCancel={() => setPendingCreate(null)}
          onConfirm={(input) => {
            const pc = pendingCreate;
            setPendingCreate(null);
            void pc.run(input);
          }}
        />
      )}
      {settingsChat && <ChatSettingsSheet chat={settingsChat} onClose={() => setSettingsForId(null)} />}
      {prefsOpen && (
        <PreferencesSheet
          onClose={() => { setPrefsOpen(false); setReadinessVersion((v) => v + 1); }}
          onLinearChanged={() => setLinearVersion((v) => v + 1)}
          // Repo create / update / delete touches the denormalized
          // `repoColor`/`repoMode` columns on chats — refetch the chat
          // list so frame colors and slot pills update live. It also
          // covers per-repo slot config now (slots moved out of the
          // global Runtime panel), so bump the slot strip too.
          onReposChanged={() => {
            void refresh();
            setReadinessVersion((v) => v + 1);
            setSlotConfigVersion((v) => v + 1);
          }}
          initialSection={prefsSection}
        />
      )}
      {gateOpen && (
        <ReadinessGateModal
          readiness={readiness}
          onClose={() => setGateOpen(false)}
        />
      )}
      {busy && <BusyOverlay message={busy.message} detail={busy.detail} />}
      {toast && (
        <Toast
          message={toast.message}
          detail={toast.detail}
          onClick={toast.onClick}
          onDismiss={() => setToast(null)}
        />
      )}
      <NotificationToastStack
        toasts={notifToasts}
        onAction={routeAction}
        onDismiss={dismissNotifToast}
        centerFly={centerFly}
      />
      {noSlotsOpen && (
        <>
          <div className="scrim" onClick={() => setNoSlotsOpen(false)} />
          <div className="modal" data-screen-label="Modal · no-slots">
            <div className="modal-head">
              <h2>No free workspace slots</h2>
              <div className="sub">Every slot is held by an open chat.</div>
            </div>
            <div className="modal-body">
              Close one of your active chats to free a slot, or raise the slot
              limit in <b>Preferences → Runtime &amp; Slots</b>.
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setNoSlotsOpen(false)}>Cancel</button>
              <button
                className="btn primary"
                onClick={() => {
                  setNoSlotsOpen(false);
                  openPrefsAt('runtime');
                }}
              >
                Open Preferences
              </button>
            </div>
          </div>
        </>
      )}
      {closingChat && (
        <CloseChatPrompt
          chatId={closingChat.id}
          branch={closingChat.branch}
          slotId={closingChat.slotId}
          onCancel={() => setClosingChat(null)}
          onClose={(opts) => void doClose(closingChat.id, opts)}
        />
      )}
      {modal && <Modal kind={modal} onClose={() => setModal(null)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
    </HighlightProvider>
  );
}

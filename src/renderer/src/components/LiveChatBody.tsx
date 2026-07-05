import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isMcpTool, mcpServerOfTool } from '@shared/agent';

/** Active chatId, provided at the top of the chat body so deeply-nested
 *  markdown link / inline-code / tool-row renderers can resolve relative
 *  file references against the chat's cwd when opening them in the
 *  external editor. */
const ChatIdContext = createContext<string | null>(null);

/** Extensions we treat as openable code/text references when they appear
 *  bare in inline code spans (e.g. `src/foo.ts`). Kept tight so prose
 *  like `e.g.` or a version `v1.2` doesn't get linkified. */
const FILE_EXT_RE =
  /\.(tsx?|jsx?|mjs|cjs|json|css|scss|less|html?|mdx?|ya?ml|toml|ini|cfg|xml|svg|sql|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|lua|vue|svelte|astro|txt|lock|env|prisma|proto|gradle|dockerfile)(:\d+)?$/i;

/** Does a markdown href look like a file path (→ open in editor) rather
 *  than a real URL (→ browser)? */
function isFileHref(href: string): boolean {
  const h = href.trim();
  if (!h || h.startsWith('#') || h.startsWith('//')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return false; // has a URL scheme (http:, mailto:, …)
  return h.includes('/') || FILE_EXT_RE.test(h) || /\.\w{1,8}(:\d+)?$/.test(h);
}

/** Does a bare inline-code token look like a file reference worth
 *  linkifying? Stricter than isFileHref — a single spaceless token with
 *  a slash-path or a known code/file extension. */
function isFileToken(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 200 || /\s/.test(t)) return false;
  if (FILE_EXT_RE.test(t)) return true;
  return t.includes('/') && /\/[^/]+\.\w{1,8}(:\d+)?$/.test(t);
}

/** Open a file reference (relative or absolute, optional `:line`) in the
 *  configured external editor via main. Non-fatal: a mis-detected token
 *  just no-ops with a console warning. */
function openFileRef(chatId: string | null, ref: string, line?: number): void {
  void window.popbot.files.openInEditor(chatId, ref, line).then((res) => {
    if (!res.ok) console.warn('files.openInEditor failed', res.error);
  });
}

/** Markdown <a>: file-looking hrefs open in the editor; real URLs open
 *  in the OS browser via Electron's window-open handler (renderer
 *  navigation would reload the whole app). */
const MarkdownAnchor: NonNullable<Components['a']> = ({ href, children, ...props }) => {
  const chatId = useContext(ChatIdContext);
  const { t } = useTranslation();
  if (href && isFileHref(href)) {
    return (
      <a
        {...props}
        className={['file-link', props.className].filter(Boolean).join(' ')}
        href={href}
        title={t('chat.editor.openInEditor', { href })}
        onClick={(e) => { e.preventDefault(); openFileRef(chatId, href); }}
      >
        {children}
      </a>
    );
  }
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => { e.preventDefault(); if (href) window.open(href, '_blank'); }}
    >
      {children}
    </a>
  );
};

/** Markdown inline <code>: when the token looks like a file path, render
 *  a clickable editor link; otherwise a normal code span. Block code
 *  (carries a `language-*` class or spans multiple lines) is untouched. */
const MarkdownCode: NonNullable<Components['code']> = ({ className, children, ...props }) => {
  const chatId = useContext(ChatIdContext);
  const { t } = useTranslation();
  const raw = String(children ?? '');
  if (!className && !raw.includes('\n') && isFileToken(raw)) {
    return (
      <code
        {...props}
        className="file-link file-code-link"
        role="link"
        tabIndex={0}
        title={t('chat.editor.openInEditor', { href: raw })}
        onClick={() => openFileRef(chatId, raw)}
        onKeyDown={(e) => { if (e.key === 'Enter') openFileRef(chatId, raw); }}
      >
        {children}
      </code>
    );
  }
  return <code {...props} className={className}>{children}</code>;
};

/** Shared markdown renderers for agent-authored prose. Use everywhere we
 *  render markdown so file references are clickable and links stay in
 *  the OS browser rather than navigating the app. */
const MD_COMPONENTS: Components = {
  a: MarkdownAnchor,
  code: MarkdownCode,
};
import type {
  ChatAttachment,
  MessageBodyPermission,
  MessageBodyText,
  MessageBodyTool,
  MessageRecord,
} from '@shared/persistence';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { isYesNoQuestion, looksLikeQuestion } from '@shared/questionDetect';
import { useMessages } from '../lib/useMessages';
import { getExternalEditor } from '../lib/editor';
import { useTranslation } from '../lib/i18n';
import { toolLabel } from '../lib/toolLabel';
import type { Translator } from '@shared/i18n';

/** Total messages mounted at any time. The window slides as the user
 *  scrolls; older / newer messages live in the DB until they're scrolled
 *  into the window. */
// Two caps for the two modes the chat can be in:
//
//   TAIL_WINDOW: the live "I'm following the conversation" mode. Keeps
//     the DOM lean (each MessageRow is heavy — markdown, diff viewer,
//     tool blocks). Anything older than this is dropped from the DOM
//     while sticky-bottom is engaged.
//
//   BROWSE_WINDOW: the "I scrolled up to read history" mode. Larger
//     than the tail so casual scroll-ups don't constantly slide, but
//     still BOUNDED — this is the cap that actually protects the main
//     thread.
//
//     It used to be 1000, which on a long, heavy chat (e.g. a single
//     turn that read/wrote whole files — hundreds of rows, several tens
//     of KB each) meant a scroll-up mounted ~1000 MessageRows at once.
//     The post-commit `useLayoutEffect` then reads `scrollHeight`,
//     forcing ONE synchronous layout over that entire tree — seconds of
//     a frozen, non-interactive main thread (input events queue while
//     the compositor keeps painting already-composited layers, so the
//     window looks "alive but stuck"). Capping the mounted set keeps
//     that forced layout cheap; the slide-on-rest machinery still pages
//     the full history in as you scroll, so nothing is lost.
//
// Re-engaging sticky (hitting bottom + the rest timer, or pressing
// Latest) flips back to TAIL_WINDOW and the extras get unmounted.
const TAIL_WINDOW = 30;
const BROWSE_WINDOW = 200;
/** How many to slide the window per scroll-edge trigger. MUST stay
 *  strictly less than the smaller cap (TAIL_WINDOW) so the anchor message captured at the
 *  edge stays mounted across the slide — otherwise anchor restoration in
 *  the post-slide useLayoutEffect silently fails and scrollTop sticks
 *  at its tiny edge value while the mounted set has fully shifted,
 *  which the user sees as the scrollbar snapping to the top and then
 *  pingponging as further deltas re-render the body. */
const SLIDE_BATCH = 12;
/** Don't slide the window while the user is still actively scrolling.
 *  Each scroll event resets the wait; the slide only fires once the
 *  scroller has been at rest for this long. Without this, scrolling
 *  fast to the top would slide the window mid-flick and yank content
 *  out from under the wheel. */
const SLIDE_DEBOUNCE_MS = 500;
/** Pixel distance from an edge that triggers a slide. */
const SLIDE_THRESHOLD_PX = 200;
/** Pixel distance from the bottom under which the view stays "stuck" to
 *  the bottom — new content auto-scrolls into view. Above this, the user
 *  is reading history and we leave them alone. */
/** Tolerance for "the scrollbar is at the bottom" — the threshold
 *  used for sticky-engagement. 4 px is small enough that a user
 *  scrolling down doesn't feel snapped early (anything within 4 px
 *  of the bottom is visually indistinguishable from "at the bottom"),
 *  but loose enough to handle HiDPI subpixel rounding where
 *  `scrollHeight - scrollTop - clientHeight` lands at 1.0 or 1.5
 *  even when the scrollbar is fully at the bottom. */
const STICKY_BOTTOM_PX = 4;

/** A more generous tolerance used only for hiding the "Latest" jump-
 *  to-bottom button. The button is for advancing the user from far
 *  up the page; once they're within ~30 px of the bottom, the button
 *  is just noise. This also naturally accommodates the in-scroll
 *  "AI is thinking" indicator (~30 px tall) that sits below the last
 *  message while a turn is in flight — being at the bottom of the
 *  *messages* should hide the button even though the actual scroll
 *  bottom is past the indicator. */
const JUMP_HIDDEN_PX = 40;

/** Tool names whose tool-use row is suppressed from the transcript.
 *  Either the tool gets its own dedicated UI elsewhere (AskUserQuestion
 *  → PlanCard) or it's noisy internal plumbing where the result matters
 *  more than the call itself (ToolSearch). */
const HIDDEN_TOOL_NAMES = new Set<string>([
  'AskUserQuestion',
  'ToolSearch',
]);

interface LiveChatBodyProps {
  chatId: string;
  /** Current chat status — used to decide whether to render the latest
   *  agent question as a question card. */
  chatStatus?: string;
  /** Quick-reply send hook — fires when the user clicks Yes/No on a
   *  yes/no question card. Sends the chosen answer as a user message. */
  onQuickReply?: (text: string) => void;
  /** Single permission decision callback — emits the full scoped
   *  decision so the backend can persist a rule when scope is
   *  permanent. */
  onDecidePermission?: (
    permissionId: string,
    decision: 'allow' | 'allow-chat' | 'allow-everywhere' | 'allow-mcp-server' | 'deny' | 'deny-everywhere',
  ) => void;
}

/**
 * Renders a chat's transcript with a fixed-size sliding window:
 *
 *   only the active mode's cap (TAIL_WINDOW or BROWSE_WINDOW) of messages are mounted at any time. Scroll near the
 *   top → window slides up (older mounted, newer unmounted). Scroll near
 *   the bottom → window slides down. Scroll position is preserved by
 *   anchoring on a DOM element that survives the shift.
 *
 * Live new messages stick to the bottom only if the user is already at
 * the bottom of the scroller AND the window is showing the tail.
 */
function LiveChatBodyImpl({
  chatId,
  chatStatus,
  onQuickReply,
  onDecidePermission,
}: LiveChatBodyProps): JSX.Element {
  const { t } = useTranslation();
  const { messages, loading } = useMessages(chatId);
  // Index of the first message currently mounted. The mounted slice is
  // `messages[windowStart .. windowStart + cap]` where `cap` is
  // TAIL_WINDOW or BROWSE_WINDOW depending on `sticky`.
  const [windowStart, setWindowStart] = useState<number>(() =>
    Math.max(0, messages.length - TAIL_WINDOW),
  );
  const [showJumpToBottom, setShowJumpToBottom] = useState<boolean>(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Sticky-to-bottom is also the mode flag: true → tail mode (small
  // mounted window pinned to the latest), false → browse mode (large
  // mounted window the user can scroll through). It needs to be state
  // (not a ref) because changing modes also changes the cap which
  // changes the rendered slice — we need a re-render on the flip.
  const [sticky, setSticky] = useState<boolean>(true);
  const cap = sticky ? TAIL_WINDOW : BROWSE_WINDOW;
  // If non-null after a setWindowStart, useLayoutEffect uses this to
  // restore the user's scroll position by re-finding the anchor element.
  const anchorRef = useRef<{ id: string; offsetWithin: number } | null>(null);
  // True between a programmatic `el.scrollTop = …` write and the scroll
  // event the browser fires for it. onScroll bails when this is set so
  // the snap-to-bottom / anchor-restore writes don't re-enter the slide
  // logic — that re-entry was the up/down/up/down ping-pong bug.
  const programmaticScrollRef = useRef<boolean>(false);
  // Set when a slide-window setState is in flight; cleared after the
  // post-slide useLayoutEffect runs. Prevents a fast scroll burst
  // (multiple scroll events in one frame) from queueing N slides on top
  // of each other and overshooting the window. Without this, a quick
  // flick to the top would slide back N×SLIDE_BATCH and lose the
  // anchor entirely. */
  const slidingRef = useRef<boolean>(false);
  // True while the slide debounce timer is pending — the user is
  // actively engaged with the scrollbar and we're waiting for them to
  // stop before sliding. During this window, suppress the snap-to-
  // bottom behavior in useLayoutEffect: a text-delta arriving mid-rest
  // would otherwise yank the scroller back to the tail and the slide
  // would never get its quiet moment to commit. Cleared when the
  // timer fires, when it's canceled, or when the slide completes.
  const slidePendingRef = useRef<boolean>(false);
  // Last scrollTop seen by onScroll. Used to detect direction: a
  // decrease means the user scrolled up, which disengages sticky-
  // bottom mode. Content growth doesn't change scrollTop on its own,
  // so this stays a clean signal of user intent.
  const prevScrollTopRef = useRef<number>(0);
  // Bottom position (`scrollHeight - clientHeight`) at the moment of
  // the last sticky-snap, plus the windowStart that was active when
  // we took it. If the DOM's scrollTop drops below `bottom` between
  // renders AND windowStart hasn't changed, a user-initiated scroll-
  // up happened in the gap. If windowStart changed, the mounted set
  // swapped (e.g. tail→browse cap shift), the bottom reference is
  // meaningless, and we just snap fresh — comparing across mounted-
  // set swaps was the cause of the engage/disengage flashing on long
  // chats where sticky-engage triggered a windowStart re-pin.
  const lastSnapRef = useRef<{ bottom: number; windowStart: number } | null>(null);

  // Re-evaluate the "Latest" button visibility on every relevant state
  // change — not just on scroll events. The scroll handler updates
  // `showJumpToBottom` correctly but it doesn't fire on resize, on
  // initial mount, or when messages stream in without scrollTop
  // moving. Without this effect the button could stay visible after
  // the user is back at the bottom (e.g. content grew, sticky snapped
  // them down, then the next scroll event arrived too late). We mirror
  // the exact predicate from the scroll handler so the two stay in
  // sync.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distFromBottom < JUMP_HIDDEN_PX;
    const atVeryBottom = nearBottom && windowStart + cap >= messages.length;
    setShowJumpToBottom(!atVeryBottom);
  }, [messages.length, windowStart, cap, sticky]);

  // Reset window state when switching chats. The actual snap-to-tail
  // happens in the messages-length effect below, once messages load.
  useEffect(() => {
    setWindowStart(0);
    setSticky(true);
    anchorRef.current = null;
    // chatId only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Tail mode: pin windowStart to the live tail. Runs whenever the
  // message count changes OR sticky flips on. Browse mode is a no-op
  // here — windowStart is user-driven via slide-back/forward.
  useEffect(() => {
    if (!sticky) return;
    setWindowStart(Math.max(0, messages.length - TAIL_WINDOW));
  }, [messages.length, sticky]);

  // Capture an anchor on the topmost visible message — used to preserve
  // scroll position when the window slides.
  const captureAnchor = (el: HTMLDivElement) => {
    const candidates = el.querySelectorAll<HTMLElement>('[data-msg-id]');
    for (const node of Array.from(candidates)) {
      const top = node.offsetTop;
      const bottom = top + node.offsetHeight;
      if (bottom > el.scrollTop) {
        anchorRef.current = {
          id: node.dataset.msgId ?? '',
          offsetWithin: el.scrollTop - top,
        };
        return;
      }
    }
    anchorRef.current = null;
  };

  // Scroll handler: detect edge proximity + trigger window shifts +
  // track sticky-bottom flag. The slide itself is debounced — each
  // scroll event cancels the pending slide timer; the slide only fires
  // once the scroller has been at rest for SLIDE_DEBOUNCE_MS. This way
  // a fast flick to the top doesn't yank content out from under the
  // wheel mid-scroll; you see the older messages "fade in" after a
  // brief rest, which feels intentional.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    prevScrollTopRef.current = el.scrollTop;
    let slideTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelPendingSlide = () => {
      if (slideTimer !== null) {
        clearTimeout(slideTimer);
        slideTimer = null;
      }
      slidePendingRef.current = false;
    };
    const onScroll = () => {
      // Always update prevScrollTop and compute delta — even when the
      // event came from our own programmatic snap. Two reasons:
      //   1. prevScrollTopRef must stay in sync with the live scrollTop,
      //      otherwise the *next* user scroll computes delta against a
      //      stale baseline and the sign of the diff can flip.
      //   2. delta < 0 is an unambiguous "user scrolled up" signal:
      //      programmatic sticky snaps always move scrollTop DOWN
      //      (toward scrollHeight), never up. So we can act on a
      //      negative delta regardless of whether programmaticScrollRef
      //      is currently set — that's the fix for "scrolling up while
      //      a response is streaming doesn't disengage sticky."
      const newScrollTop = el.scrollTop;
      const prevScrollTop = prevScrollTopRef.current;
      prevScrollTopRef.current = newScrollTop;
      const delta = newScrollTop - prevScrollTop;

      const distFromBottom = el.scrollHeight - newScrollTop - el.clientHeight;
      const atBottom = distFromBottom < STICKY_BOTTOM_PX;
      // Sticky engages only when you're at the bottom of the CHAT,
      // not just the bottom of the mounted window. Without this
      // check, scrolling down to the bottom of a browse-mode mount
      // (which only shows the most recent BROWSE_WINDOW items, with
      // older content unmounted) would prematurely engage sticky and
      // trigger the tail-mode windowStart re-pin, causing the
      // mounted-set swap that flashes the screen. The slide-forward
      // debounce path is what loads newer content in browse mode;
      // sticky only takes over once everything is mounted.
      const atChatBottom = atBottom && windowStart + cap >= messages.length;

      // Sticky-bottom is position-based:
      //   - delta < 0 AND we've left the bottom zone → disengage.
      //   - atChatBottom AND we're not already sticky → engage.
      //
      // delta<0 inside the bottom zone (e.g. wheel-up by 5px while
      // distFromBottom < STICKY_BOTTOM_PX) does NOT disengage — that
      // way wheel jitter doesn't bounce sticky on/off.
      if (delta < 0 && !atBottom && sticky) {
        setSticky(false);
        setWindowStart(Math.max(0, messages.length - BROWSE_WINDOW));
      }
      if (atChatBottom && !sticky) {
        setSticky(true);
      }

      // "Jump to bottom" visibility uses a generous tolerance
      // (JUMP_HIDDEN_PX, ~40 px). The button is for advancing the
      // user from far up the page; once they're within ~30 px of the
      // bottom it just adds noise. This also accommodates the
      // in-scroll "AI is thinking" indicator that sits below the
      // last message during a turn — strict atBottom would otherwise
      // keep the button visible whenever a chat was running.
      const nearBottom = distFromBottom < JUMP_HIDDEN_PX;
      const atVeryBottom = nearBottom && windowStart + cap >= messages.length;
      setShowJumpToBottom(!atVeryBottom);

      // Slide direction is keyed off scroll *position* which we just
      // moved ourselves on a programmatic snap, so the slide debounce
      // path bails here — sticky/jump-to-bottom logic above already ran.
      if (programmaticScrollRef.current) return;

      // Any scrollbar movement resets the slide wait — even if a slide
      // was already pending. This is what makes "rest for a second to
      // load more" the actual UX rule.
      cancelPendingSlide();

      // Only one slide in flight at a time — once a slide has been
      // committed and is awaiting layout, ignore further triggers
      // until the post-slide layout effect releases the guard.
      if (slidingRef.current) return;

      const wantSlideBack = el.scrollTop < SLIDE_THRESHOLD_PX && windowStart > 0;
      const wantSlideForward =
        distFromBottom < SLIDE_THRESHOLD_PX &&
        windowStart + cap < messages.length;
      if (!wantSlideBack && !wantSlideForward) return;

      slidePendingRef.current = true;
      slideTimer = setTimeout(() => {
        slideTimer = null;
        slidePendingRef.current = false;
        // Re-read state from the DOM in case things changed during
        // the wait (e.g. a text-delta extended the bottom message
        // and our distFromBottom is no longer accurate).
        const currentEl = scrollRef.current;
        if (!currentEl) return;
        if (programmaticScrollRef.current || slidingRef.current) return;
        if (wantSlideBack) {
          if (currentEl.scrollTop >= SLIDE_THRESHOLD_PX || windowStart <= 0) return;
          slidingRef.current = true;
          captureAnchor(currentEl);
          setWindowStart((prev) => Math.max(0, prev - SLIDE_BATCH));
          return;
        }
        // wantSlideForward
        const distNow = currentEl.scrollHeight - currentEl.scrollTop - currentEl.clientHeight;
        if (distNow >= SLIDE_THRESHOLD_PX || windowStart + cap >= messages.length) return;
        slidingRef.current = true;
        captureAnchor(currentEl);
        setWindowStart((prev) =>
          Math.min(Math.max(0, messages.length - cap), prev + SLIDE_BATCH),
        );
      }, SLIDE_DEBOUNCE_MS);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelPendingSlide();
    };
  }, [windowStart, messages.length, sticky, cap]);

  // After every render: restore scroll via anchor if one was captured;
  // otherwise snap to bottom if the user was sticky-bottom. Any write
  // to scrollTop is bracketed with `programmaticScrollRef` so the
  // resulting scroll event doesn't re-trigger the slide logic.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const setScrollTop = (top: number) => {
      if (el.scrollTop === top) return;
      programmaticScrollRef.current = true;
      el.scrollTop = top;
      // The scroll event fires async (next macrotask). One rAF is
      // enough to outlive it before we drop the guard.
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    };
    const anchor = anchorRef.current;
    if (anchor) {
      const node = el.querySelector<HTMLElement>(`[data-msg-id="${anchor.id}"]`);
      if (node) {
        setScrollTop(node.offsetTop + anchor.offsetWithin);
      }
      anchorRef.current = null;
      slidingRef.current = false;
      lastSnapRef.current = null;
      return;
    }
    // Suppress the snap-to-bottom while a slide is pending (the user
    // is mid-rest waiting for older messages to load) or in flight
    // (we're about to anchor-restore on the next render). Otherwise a
    // text-delta arriving during that window would yank the scroller
    // back to the tail and the slide would never get to commit.
    if (sticky && !slidePendingRef.current && !slidingRef.current) {
      const lastSnap = lastSnapRef.current;
      // Streaming-render race detector. ONLY trust the comparison if
      // windowStart hasn't changed since the snap — otherwise the
      // mounted set was swapped (e.g. tail/browse cap flip) and the
      // bottom reference is meaningless.
      const drift = lastSnap !== null
        && lastSnap.windowStart === windowStart
        && el.scrollTop < lastSnap.bottom - 2;
      if (drift) {
        setSticky(false);
        setWindowStart(Math.max(0, messages.length - BROWSE_WINDOW));
        lastSnapRef.current = null;
      } else {
        setScrollTop(el.scrollHeight);
        lastSnapRef.current = {
          bottom: el.scrollHeight - el.clientHeight,
          windowStart,
        };
      }
    } else if (!sticky) {
      lastSnapRef.current = null;
    }
    // Always release the slide guard once layout has caught up — even
    // if anchor resolution failed, the slide is "done" and the next
    // user scroll should be allowed to trigger a new one.
    slidingRef.current = false;
  });

  // Slice + Q/A pairing must be computed BEFORE the early returns below
  // so the hook order stays stable across renders.
  const visible = messages.slice(windowStart, windowStart + cap);
  const newerHidden = Math.max(0, messages.length - (windowStart + cap));
  const questionMessageId =
    chatStatus === 'wait' && newerHidden === 0 ? findQuestionMessageId(visible) : null;
  const { consumedUserIds, qaAnswers } = useMemo(
    () => computeQAPairs(visible),
    [visible],
  );

  if (loading) {
    return (
      <div className="chat-scroll">
        <div className="msg agent">
          <div className="body" style={{ color: 'var(--fg-3)' }}>{t('chat.transcript.loading')}</div>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="chat-scroll">
        <div className="msg agent">
          <div className="body" style={{ color: 'var(--fg-3)' }}>
            {t('chat.transcript.empty')}
          </div>
        </div>
      </div>
    );
  }

  const olderHidden = windowStart;

  const jumpToBottom = () => {
    setSticky(true);
    setWindowStart(Math.max(0, messages.length - TAIL_WINDOW));
    // Snap directly after the next paint so the user sees the jump
    // immediately rather than waiting for the next layout effect.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
        setShowJumpToBottom(false);
      }
    });
  };

  return (
    <ChatIdContext.Provider value={chatId}>
      <div className="chat-scroll-wrap">
        <div className="chat-scroll" ref={scrollRef}>
        {olderHidden > 0 && (
          <div className="window-edge-marker">
            {olderHidden === 1
              ? t('chat.window.olderHidden', { count: olderHidden })
              : t('chat.window.olderHiddenPlural', { count: olderHidden })}
          </div>
        )}
        {visible
          // Drop messages that MessageRow would render as null. The
          // chat scroll uses gap:14px between flex children, so an
          // empty wrapper still adds visible blank space.
          .filter((m) => isMessageVisible(m, consumedUserIds))
          .map((m, i, arr) => (
            <div key={m.id} data-msg-id={m.id}>
              <MessageRow
                message={m}
                chatId={chatId}
                renderAsQuestion={m.id === questionMessageId}
                isStale={i < arr.length - 1}
                consumed={consumedUserIds.has(m.id)}
                qaAnswer={qaAnswers.get(m.id)}
                onDecide={onDecidePermission}
                onQuickReply={onQuickReply}
              />
            </div>
          ))}
        {newerHidden > 0 && (
          <div className="window-edge-marker">
            {newerHidden === 1
              ? t('chat.window.newerHidden', { count: newerHidden })
              : t('chat.window.newerHiddenPlural', { count: newerHidden })}
          </div>
        )}
        {/* "AI is thinking" indicator — same blinking-cursor signal as
            on the thumbnail, only here it always renders while running
            (the chat body has no inline streaming cursor of its own). */}
        {chatStatus === 'run' && newerHidden === 0 && (
          <div className="chat-thinking">
            <span className="tline-cursor" />
          </div>
        )}
      </div>
      {showJumpToBottom && (
        <button
          className="chat-jump-to-bottom"
          onClick={jumpToBottom}
          title={t('chat.jump.title')}
        >
          <i className="fa-solid fa-arrow-down" /> {t('chat.jump.label')}
        </button>
      )}
      </div>
    </ChatIdContext.Provider>
  );
}

/** Memoized export. Default shallow-equality on props is fine because
 *  ChatColumn now hands us stable useCallback references for the three
 *  handlers — without memo, every keystroke in the textarea (which
 *  flips ChatColumn's draft state) re-rendered the entire transcript
 *  and snapped the scroller. */
export const LiveChatBody = memo(LiveChatBodyImpl);

interface MessageRowProps {
  message: MessageRecord;
  renderAsQuestion?: boolean;
  /** True if any later message exists in this chat — implies the user
   *  already responded, so any permission card should render collapsed. */
  isStale?: boolean;
  /** True if this message has been "consumed" as the answer half of a
   *  Q/A pair rendered by an earlier permission row. Suppresses the
   *  standalone user bubble. */
  consumed?: boolean;
  /** When set on a permission row, the user's answer text from the
   *  paired user message — rendered inline below the question. */
  qaAnswer?: string;
  /** Chat id — used by the Retry button on system-error rows. */
  chatId: string;
  onQuickReply?: (text: string) => void;
  onDecide?: (
    permissionId: string,
    decision: 'allow' | 'allow-chat' | 'allow-everywhere' | 'allow-mcp-server' | 'deny' | 'deny-everywhere',
  ) => void;
}

function MessageRowImpl({ message, renderAsQuestion, isStale, consumed, qaAnswer, chatId, onQuickReply, onDecide }: MessageRowProps): JSX.Element | null {
  if (consumed) return null;
  if (message.kind === 'text' || message.kind === 'system') {
    const body = parseBody<MessageBodyText>(message.body, { text: '' });
    const attachments = body.attachments ?? [];
    if (!body.text && attachments.length === 0) return null;
    if (renderAsQuestion && message.role === 'agent') {
      return <QuestionCard text={body.text} onQuickReply={onQuickReply} />;
    }
    // Tag agent-emitted error messages so they read as errors (red
    // border / icon) instead of blending into normal agent prose.
    const isSystemError =
      message.kind === 'system' && body.text.toLowerCase().startsWith('error:');
    if (isSystemError) {
      return <SystemErrorRow text={body.text} chatId={chatId} stale={!!isStale} />;
    }
    const cls = message.role === 'user' ? 'msg user' : 'msg agent';
    return (
      <div className={cls}>
        <div className="body">
          {message.role === 'user' ? (
            <>
              {body.text && <span style={{ whiteSpace: 'pre-wrap' }}>{body.text}</span>}
              {attachments.length > 0 && <AttachmentList attachments={attachments} />}
            </>
          ) : (
            <div className="prose">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{body.text}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.kind === 'tool') {
    const body = parseBody<MessageBodyTool>(message.body, {
      toolUseId: '',
      name: '',
      args: {},
    });
    if (HIDDEN_TOOL_NAMES.has(body.name)) return null;
    return <ToolBlock body={body} />;
  }

  if (message.kind === 'permission') {
    const body = parseBody<MessageBodyPermission>(message.body, {
      permissionId: '',
      tool: '',
      args: {},
    });
    // If the user already moved on (something newer in the transcript)
    // but the row's body never got the explicit decision write, treat
    // it as decided so it collapses.
    const effective: MessageBodyPermission =
      body.decision === undefined && isStale
        ? { ...body, decision: 'allow' }
        : body;
    // For resolved AskUserQuestion rows we have the paired user answer
    // to render inline as a Q/A block.
    if (qaAnswer !== undefined && body.tool === 'AskUserQuestion' && effective.decision !== undefined) {
      const ask = asAskUserQuestionArgs(body.tool, body.args);
      const question = ask?.questions[0]?.question ?? '(question)';
      return <QAPair question={question} answer={qaAnswer} />;
    }
    // Once a decision has landed (any scope), the chat just shows the
    // tool-use row that follows. The permission card disappears so the
    // transcript reads as if the command always had permission.
    if (effective.decision !== undefined) return null;
    return (
      <PermissionBlock
        body={effective}
        onDecide={onDecide}
        onQuickReply={onQuickReply}
      />
    );
  }

  return null;
}

/** Memoized row. During streaming, `useMessages` patches messages with
 *  `.map`, returning the SAME object reference for every untouched row —
 *  only the row receiving a text-delta / tool-result gets a fresh
 *  reference. With a plain function component, a single delta still
 *  re-rendered every mounted row (re-parsing markdown, re-reconciling
 *  the whole subtree, and churning DOM via add/removeChild), which the
 *  post-commit `useLayoutEffect` then forced a full synchronous layout
 *  over — the multi-hundred-ms "rendering pauses". Shallow prop equality
 *  here lets unchanged rows bail out entirely. The handler props
 *  (`onDecide`/`onQuickReply`) are stable `useCallback` refs from
 *  ChatColumn, and the value props (`consumed`/`qaAnswer`/`isStale`/…)
 *  compare equal by value for unchanged rows, so the bail-out holds. */
const MessageRow = memo(MessageRowImpl);

function AttachmentList({ attachments }: { attachments: ChatAttachment[] }): JSX.Element {
  return (
    <div className="msg-attachments">
      {attachments.map((att) => (
        <button
          key={att.id || att.path}
          type="button"
          className="msg-attachment"
          title={`${att.name}\n${att.originalPath ?? att.path}`}
          onClick={() => void openAttachment(att.path)}
        >
          <i className={`fa-solid ${att.isImage ? 'fa-image' : 'fa-paperclip'}`} aria-hidden />
          <span className="msg-attachment-name">{att.name}</span>
          <span className="msg-attachment-meta">{formatBytes(att.sizeBytes)}</span>
          <i className="fa-solid fa-arrow-up-right-from-square msg-attachment-open" aria-hidden />
        </button>
      ))}
    </div>
  );
}

async function openAttachment(path: string): Promise<void> {
  const result = await window.popbot.files.openAttachment(path);
  if (!result.ok) {
    console.error('files.openAttachment failed', result.error);
    window.alert(result.error);
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

/** Renders an `error: …` system message. While the error is the most
 *  recent activity in the chat (not stale), it shows expanded with the
 *  retry actions. Once newer activity exists, the chat has moved on —
 *  the error collapses to a single red line so the day-old transcript
 *  doesn't get cluttered with huge resolved-error cards. Click the row
 *  to re-expand if you want to read or retry it. */
function SystemErrorRow({ text, chatId, stale }: {
  text: string;
  chatId: string;
  stale: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<boolean>(!stale);
  // First line of the body, with the leading `error:` stripped — what
  // gets shown in the collapsed pill.
  const firstLine = text.replace(/^error:\s*/i, '').split('\n')[0];
  if (!expanded) {
    return (
      <div
        className="msg system-error stale"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(true); }}
        title={t('chat.error.expandTitle')}
      >
        <div className="body system-error-collapsed">
          <i className="fa-solid fa-circle-exclamation msg-error-icon" aria-hidden />
          <span className="system-error-summary">{firstLine}</span>
          <i className="fa-solid fa-chevron-right system-error-chev" aria-hidden />
        </div>
      </div>
    );
  }
  return (
    <div className="msg system-error">
      <div className="body">
        <button
          className="system-error-close"
          onClick={() => setExpanded(false)}
          title={t('chat.error.collapseTitle')}
          aria-label={t('chat.error.collapseAria')}
        >
          <i className="fa-solid fa-xmark" aria-hidden />
        </button>
        <span className="msg-error-icon" aria-hidden>
          <i className="fa-solid fa-circle-exclamation" />{' '}
        </span>
        <div className="prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{text}</ReactMarkdown>
        </div>
        <div className="msg-error-actions">
          <button
            className="btn sm msg-error-retry"
            onClick={() => void window.popbot.agent.recover(chatId)}
            title={t('chat.error.retryTitle')}
          >
            <i className="fa-solid fa-rotate-right" /> {t('chat.error.retry')}
          </button>
          <button
            className="btn sm msg-error-retry"
            onClick={() => void window.popbot.agent.restartWithContext(chatId)}
            title={t('chat.error.restartTitle')}
          >
            <i className="fa-solid fa-arrows-spin" /> {t('chat.error.restart')}
          </button>
        </div>
      </div>
    </div>
  );
}

const TRUNCATE_CHARS = 5000;
const TRUNCATE_LINES = 100;

function truncateOutput(text: string, t: Translator): { display: string; truncated: boolean; hiddenChars: number } {
  if (text.length <= TRUNCATE_CHARS) {
    const lines = text.split('\n');
    if (lines.length <= TRUNCATE_LINES) {
      return { display: text, truncated: false, hiddenChars: 0 };
    }
    const head = lines.slice(0, TRUNCATE_LINES / 2).join('\n');
    const tail = lines.slice(-TRUNCATE_LINES / 2).join('\n');
    const hiddenLines = lines.length - TRUNCATE_LINES;
    const marker = hiddenLines === 1
      ? t('chat.output.linesTruncated', { count: hiddenLines })
      : t('chat.output.linesTruncatedPlural', { count: hiddenLines });
    return {
      display: `${head}\n\n  ${marker}\n\n${tail}`,
      truncated: true,
      hiddenChars: text.length - head.length - tail.length,
    };
  }
  const halfChars = TRUNCATE_CHARS / 2;
  const head = text.slice(0, halfChars);
  const tail = text.slice(-halfChars);
  const hiddenChars = text.length - TRUNCATE_CHARS;
  const marker = hiddenChars === 1
    ? t('chat.output.charsTruncated', { count: hiddenChars })
    : t('chat.output.charsTruncatedPlural', { count: hiddenChars });
  return {
    display: `${head}\n\n  ${marker}\n\n${tail}`,
    truncated: true,
    hiddenChars,
  };
}

/** Per-tool presentation: an icon + a one-line "what's happening" hint
 *  pulled from the most informative arg(s). Lets the row feel like a
 *  Claude-Code-style status line instead of a generic "Bash" label.
 *
 *  When the hint is a file path, `filePath` is set so the renderer can
 *  make it a clickable `vscode://file/<path>` link. */
function presentTool(name: string, args: Record<string, unknown>, t: Translator): {
  icon: string;
  label: string;
  hint: string;
  filePath?: string;
} {
  const a = args as Record<string, unknown>;
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  // Single source of truth for the translated tool name — shared with the
  // monitor card via `toolLabel`. Only icon/hint differ per tool here.
  const label = toolLabel(name, t);
  switch (name) {
    case 'Bash':
      return { icon: 'fa-terminal', label, hint: str('description') || str('command') };
    case 'Edit':
    case 'MultiEdit': {
      const p = str('file_path');
      return { icon: 'fa-pen-to-square', label, hint: p, filePath: p };
    }
    case 'Write': {
      const p = str('file_path');
      return { icon: 'fa-file-pen', label, hint: p, filePath: p };
    }
    case 'Read': {
      const p = str('file_path');
      return { icon: 'fa-file-lines', label, hint: p, filePath: p };
    }
    case 'Glob':
      return { icon: 'fa-magnifying-glass', label, hint: str('pattern') };
    case 'Grep':
      return { icon: 'fa-magnifying-glass', label, hint: str('pattern') };
    case 'WebFetch':
      return { icon: 'fa-globe', label, hint: str('url') };
    case 'WebSearch':
      return { icon: 'fa-globe', label, hint: str('query') };
    case 'Task':
      return { icon: 'fa-robot', label, hint: str('description') || str('subagent_type') };
    case 'TodoWrite':
      return { icon: 'fa-list-check', label, hint: '' };
    case 'NotebookEdit': {
      const p = str('notebook_path');
      return { icon: 'fa-book', label, hint: p, filePath: p };
    }
    default:
      return { icon: 'fa-wrench', label, hint: '' };
  }
}

/** Diffs taller than this are clipped with an "Expand" button. Tuned
 *  on the small side so a single Edit row never dominates the chat. */
const DIFF_COLLAPSED_MAX_PX = 200;

/** Hard cap on how many lines a diff may feed to the (word-level) diff
 *  viewer INLINE. Beyond this we stop running the viewer on the full
 *  text and render only the head of each side, pointing at the pop-out
 *  for the rest.
 *
 *  Why: the inline "collapse-on-tall" path only CSS-clips — it still
 *  builds the entire diff DOM and runs an O(n²)-ish WORDS_WITH_SPACE
 *  diff over the whole text. A single 60 KB Write (≈1.5k lines) then
 *  freezes the renderer main thread for seconds while it word-diffs and
 *  lays out thousands of clipped-but-still-present nodes. Capping the
 *  fed text keeps both the diff compute and the DOM bounded.
 *
 *  Tuned HIGH on purpose: ordinary edits — even large multi-hunk ones —
 *  sit well under this and render in full, unchanged. Only pathological
 *  whole-file dumps get capped. */
const DIFF_INLINE_MAX_LINES = 300;
/** When a diff is capped, how many head lines of each side we still
 *  render inline — ~two-thirds of the cap, enough to read the gist
 *  before the "open full diff" hand-off. */
const DIFF_INLINE_HEAD_LINES = 200;

/** First `n` lines of `text`, plus how many were dropped. */
function headLines(text: string, n: number): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= n) return { text, hidden: 0 };
  return { text: lines.slice(0, n).join('\n'), hidden: lines.length - n };
}

/** Compact horizontal padding for the diff display. We're not losing
 *  any data — the underlying text is unchanged for copy / fidelity —
 *  this only shrinks how it's rendered. */
function compactIndent(text: string): string {
  // 1 tab → 2 spaces. Cheap visual fix for tab-indented files; without
  // this the lib renders tabs at the browser default (8) and lines
  // walk off the right edge.
  return text.replace(/\t/g, '  ');
}

/** Inline diff for Edit / Write. Wraps `react-diff-viewer-continued`
 *  with our dark theme + a collapse-on-tall behavior. */
function DiffView({ before, after, title }: { before: string; after: string; title?: string }): JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [popped, setPopped] = useState(false);
  const compactBefore = useMemo(() => compactIndent(before), [before]);
  const compactAfter = useMemo(() => compactIndent(after), [after]);
  // Use total line count as a cheap proxy for height. ~16 lines ≈ the
  // max-height threshold; below that the container hugs naturally.
  const lineCount = (before.match(/\n/g)?.length ?? 0) + (after.match(/\n/g)?.length ?? 0) + 2;
  // Oversized diffs (e.g. a whole-file Write) are too expensive to
  // word-diff and render inline in full — they're the multi-second
  // renderer freeze. Past the cap we feed the viewer only the head of
  // each side; the full diff stays one click away in the pop-out modal.
  // Modest diffs (the overwhelming majority) skip this entirely and
  // render exactly as before.
  const oversized = lineCount > DIFF_INLINE_MAX_LINES;
  const inlineBefore = useMemo(
    () => (oversized ? headLines(compactBefore, DIFF_INLINE_HEAD_LINES) : { text: compactBefore, hidden: 0 }),
    [compactBefore, oversized],
  );
  const inlineAfter = useMemo(
    () => (oversized ? headLines(compactAfter, DIFF_INLINE_HEAD_LINES) : { text: compactAfter, hidden: 0 }),
    [compactAfter, oversized],
  );
  const hiddenLines = inlineBefore.hidden + inlineAfter.hidden;
  // Whether the inline view was ACTUALLY shortened. `oversized` (combined
  // line count past the cap) is necessary but not sufficient: headLines
  // only drops content when an INDIVIDUAL side exceeds the head cap, so a
  // diff like 151-before + 151-after trips `oversized` yet hides nothing.
  // Key the truncated-footer + collapse handoff off real truncation, not
  // the combined-count proxy, or such a diff renders fully expanded inline
  // with no expand control and no "open full diff" footer.
  const truncatedInline = hiddenLines > 0;
  // The CSS-clip "collapse" path is only for diffs we render in full. A
  // head-truncated diff already shows just its head, so clipping it would
  // hide the head we DID choose to show — and the footer handoff covers it.
  const isTall = !truncatedInline && lineCount > 16;
  const collapsed = isTall && !expanded;

  return (
    <div className="tool-diff">
      <div
        className="tool-diff-frame"
        style={collapsed ? { maxHeight: DIFF_COLLAPSED_MAX_PX, overflow: 'hidden' } : undefined}
      >
        <ReactDiffViewer
          oldValue={inlineBefore.text}
          newValue={inlineAfter.text}
          splitView={false}
          useDarkTheme
          hideLineNumbers={true}
          compareMethod={DiffMethod.WORDS_WITH_SPACE}
          showDiffOnly={true}
          extraLinesSurroundingDiff={0}
          styles={DIFF_STYLES}
        />
        {/* Pop the full diff into a scrollable panel — the inline view
            clips tall hunks, so this is the escape hatch to read it all. */}
        <button
          className="diff-popout-btn"
          onClick={(e) => { e.stopPropagation(); setPopped(true); }}
          title={t('chat.diff.popoutTitle')}
        >
          <i className="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true" />
        </button>
        {isTall && (
          <button
            className="diff-expand-btn"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            title={expanded ? t('chat.diff.collapseTitle') : t('chat.diff.showAllLines', { count: lineCount })}
          >
            {expanded ? t('chat.diff.collapse') : `+${lineCount - 16}`}
          </button>
        )}
      </div>
      {truncatedInline && (
        <button
          className="btn ghost sm diff-truncated-foot"
          onClick={(e) => { e.stopPropagation(); setPopped(true); }}
          title="This diff is large — open the full diff in a panel"
        >
          Diff truncated — open full diff ({hiddenLines.toLocaleString()} more lines)
        </button>
      )}
      {popped && (
        <DiffModal
          before={compactBefore}
          after={compactAfter}
          title={title}
          onClose={() => setPopped(false)}
        />
      )}
    </div>
  );
}

/** Full-screen diff panel — the "pop out" target for inline diffs. Shows
 *  the whole diff with line numbers and surrounding context, scrollable,
 *  so long hunks the chat clips can be read in full. Portaled to body;
 *  click-scrim or Esc closes. */
function DiffModal({ before, after, title, onClose }: {
  before: string;
  after: string;
  title?: string;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="diff-modal-scrim" onMouseDown={onClose}>
      <div
        className="diff-modal"
        role="dialog"
        aria-label={title ? t('chat.diff.modalAriaFor', { title }) : t('chat.diff.modalAria')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="diff-modal-head">
          <i className="fa-solid fa-file-pen" aria-hidden="true" />
          <span className="diff-modal-title" title={title}>{title || t('chat.diff.modalTitleFallback')}</span>
          <button className="diff-modal-close" onClick={onClose} title={t('chat.diff.modalCloseTitle')}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="diff-modal-body">
          <ReactDiffViewer
            oldValue={before}
            newValue={after}
            splitView={false}
            useDarkTheme
            hideLineNumbers={false}
            compareMethod={DiffMethod.WORDS_WITH_SPACE}
            showDiffOnly={false}
            extraLinesSurroundingDiff={3}
            styles={DIFF_MODAL_STYLES}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Inline overrides so the diff viewer matches our dark UI palette
 *  and is stripped of the library's chrome (no title block, no
 *  hide-unchanged summary line, no fold gutters). */
const DIFF_STYLES = {
  variables: {
    dark: {
      diffViewerBackground: 'transparent',
      diffViewerColor: 'var(--fg-1)',
      addedBackground: 'rgba(63, 178, 127, 0.10)',
      addedColor: '#6fd28a',
      removedBackground: 'rgba(214, 80, 80, 0.10)',
      removedColor: '#ee7474',
      wordAddedBackground: 'rgba(63, 178, 127, 0.30)',
      wordRemovedBackground: 'rgba(214, 80, 80, 0.30)',
      gutterBackground: 'transparent',
      gutterBackgroundDark: 'transparent',
      addedGutterBackground: 'rgba(63, 178, 127, 0.10)',
      removedGutterBackground: 'rgba(214, 80, 80, 0.10)',
      gutterColor: 'var(--fg-3)',
      addedGutterColor: 'var(--st-done)',
      removedGutterColor: 'var(--st-err)',
      codeFoldBackground: 'transparent',
      codeFoldGutterBackground: 'transparent',
      codeFoldContentColor: 'var(--fg-3)',
      emptyLineBackground: 'transparent',
    },
  },
  contentText: { fontSize: '10.5px', fontFamily: 'var(--font-mono)' },
  gutter: { padding: '0 6px', minWidth: '24px' },
  // Strip the title (file name row) + the unchanged-fold gutters.
  // Leave the summary row in — the lib's table layout breaks if it's
  // hidden — and just visually flatten it instead.
  titleBlock: { display: 'none' },
  summary: { padding: '2px 8px', fontSize: '10px', color: 'var(--fg-3)' },
  codeFold: { display: 'none' },
  codeFoldGutter: { display: 'none' },
  codeFoldContent: { display: 'none' },
  marker: { padding: '0 4px', minWidth: 0, fontFamily: 'var(--font-mono)' },
};

/** Diff styles for the pop-out modal: same dark palette, but line numbers
 *  + fold context are shown and the type is a touch larger for reading a
 *  long hunk in full. */
const DIFF_MODAL_STYLES = {
  variables: { dark: DIFF_STYLES.variables.dark },
  contentText: { fontSize: '12px', fontFamily: 'var(--font-mono)' },
  gutter: { padding: '0 8px', minWidth: '40px' },
  lineNumber: { color: 'var(--fg-3)' },
  titleBlock: { display: 'none' },
  summary: { padding: '4px 10px', fontSize: '11px', color: 'var(--fg-3)' },
  marker: { padding: '0 6px', minWidth: 0, fontFamily: 'var(--font-mono)' },
};

function ToolBlock({ body }: { body: MessageBodyTool }): JSX.Element {
  const { t } = useTranslation();
  const chatId = useContext(ChatIdContext);
  const expandable = body.result !== undefined;
  const isError = !!body.isError;
  // Edit / Write rows show the diff by default; Bash rows show the
  // command + a short output preview. Both default-open since that's
  // the whole point of glancing at them.
  const defaultOpen =
    body.name === 'Edit' || body.name === 'MultiEdit' ||
    body.name === 'Write' || body.name === 'Bash';
  const [open, setOpen] = useState(defaultOpen);
  const [outputModal, setOutputModal] = useState(false);
  const handleToggle = () => {
    if (expandable || hasRichBody(body)) setOpen((v) => !v);
  };
  const trunc = useMemo(
    () => (body.result !== undefined ? truncateOutput(body.result, t) : null),
    [body.result, t],
  );
  const { icon, label, hint, filePath } = presentTool(body.name, body.args, t);
  // For file-path hints, render just the basename inline; the full path
  // goes in the tooltip. Keeps the row scannable when paths are deep.
  const displayHint = filePath
    ? (filePath.split(/[/\\]/).pop() || filePath)
    : hint;
  // For Edit / MultiEdit / Write rows, locate the change in the file
  // so the file-link jumps the editor directly to the diff. We search
  // for the first non-empty line of `new_string` (or `content` for
  // Write) — that string is in the file *after* the edit applied.
  const [editLine, setEditLine] = useState<number | null>(null);
  useEffect(() => {
    if (!filePath) return;
    // Build a multi-line needle from the first ~4 non-empty lines of
    // the replacement text. A single line often appears multiple times
    // in a file (e.g. `}` or `if (x) {`), which would land us on the
    // wrong location. Stitching ~4 lines is almost always unique to
    // the actual edit site.
    const source =
      (body.name === 'Edit' || body.name === 'MultiEdit')
        ? String(body.args.new_string ?? '')
        : body.name === 'Write' ? String(body.args.content ?? '')
        : '';
    if (!source) return;
    const allLines = source.split('\n');
    const firstContentIdx = allLines.findIndex((l) => l.trim().length > 0);
    if (firstContentIdx < 0) return;
    // Slice from the first content line through up to 4 non-empty
    // lines (preserving any blank lines in between to keep the needle
    // matching the file verbatim).
    let collected = 0;
    let endIdx = firstContentIdx;
    for (let i = firstContentIdx; i < allLines.length && collected < 4; i++) {
      endIdx = i;
      if (allLines[i].trim().length > 0) collected++;
    }
    const needle = allLines.slice(firstContentIdx, endIdx + 1).join('\n');
    if (!needle) return;

    // Edits typically include a few unchanged context lines at the
    // start of old_string/new_string so the match is unique. Skip
    // those — the user wants the cursor on the FIRST actually-changed
    // line, not on the context the agent included for matching.
    let firstChangedOffset = firstContentIdx;
    if (body.name === 'Edit' || body.name === 'MultiEdit') {
      const oldLines = String(body.args.old_string ?? '').split('\n');
      const max = Math.min(oldLines.length, allLines.length);
      let commonPrefix = 0;
      while (commonPrefix < max && oldLines[commonPrefix] === allLines[commonPrefix]) {
        commonPrefix++;
      }
      // commonPrefix lines are unchanged context; the first +/− is at index = commonPrefix.
      firstChangedOffset = commonPrefix;
    }

    let cancelled = false;
    void window.popbot.files.lineOfText(filePath, needle).then((n) => {
      if (cancelled || n === null) return;
      // n is the file line where new_string starts (its firstContentIdx
      // line). The first actually-changed line sits `firstChangedOffset
      // - firstContentIdx` lines further in.
      const target = n + (firstChangedOffset - firstContentIdx);
      setEditLine(Math.max(1, target));
    });
    return () => { cancelled = true; };
  }, [filePath, body.name, body.args]);
  const status = isError ? 'err' : expandable ? 'done' : 'live';
  const canToggle = expandable || hasRichBody(body);

  return (
    <div className={`tool ${canToggle ? 'expandable' : ''} ${open ? 'open' : ''} status-${status}`}>
      <div className="tool-head" onClick={handleToggle} role={canToggle ? 'button' : undefined}>
        <i className={`fa-solid ${icon} tool-icon`} aria-hidden="true" />
        <span className="name">{label}</span>
        {hint && filePath ? (
          <a
            className="hint file-link"
            href={getExternalEditor().fileUrl(filePath, editLine ?? undefined)}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openFileRef(chatId, filePath, editLine ?? undefined);
            }}
            title={`${filePath}${editLine ? `:${editLine}` : ''} — open in editor`}
          >
            {displayHint}
          </a>
        ) : hint ? (
          <span className="hint">{displayHint}</span>
        ) : null}
        <span className="dot" aria-hidden="true" />
        {canToggle && (
          <i
            className={`fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'} tool-chev`}
            aria-hidden="true"
          />
        )}
      </div>
      {open && (
        <div className="tool-body">
          {(body.name === 'Edit' || body.name === 'MultiEdit') && (
            <DiffView
              before={String(body.args.old_string ?? '')}
              after={String(body.args.new_string ?? '')}
              title={filePath}
            />
          )}
          {body.name === 'Write' && (
            <DiffView before="" after={String(body.args.content ?? '')} title={filePath} />
          )}
          {body.name === 'Bash' && (
            <div className="tool-cmd">$ {String(body.args.command ?? '')}</div>
          )}
          {trunc && !isDiffTool(body.name) && (() => {
            // Bash output gets a tighter top-N-lines preview so the
            // chat scroll stays readable. Click the preview to open
            // the full output in a modal. Edit/Write skip this entirely
            // since the diff is the result confirmation.
            const fullText = body.result ?? '';
            const lines = fullText.split('\n');
            const previewLines = body.name === 'Bash' ? 6 : 12;
            const overflowLines = Math.max(0, lines.length - previewLines);
            const overflowChars = trunc.truncated ? trunc.hiddenChars : 0;
            const previewText = lines.slice(0, previewLines).join('\n');
            const hasMore = overflowLines > 0 || trunc.truncated;
            return (
              <>
                <pre
                  className={`tool-output ${hasMore ? 'clickable' : ''}`}
                  onClick={hasMore ? (e) => { e.stopPropagation(); setOutputModal(true); } : undefined}
                  title={hasMore ? t('chat.output.viewFullTitle') : undefined}
                >
                  {previewText}
                </pre>
                {hasMore && (
                  <div className="tool-output-foot">
                    <button
                      className="btn ghost sm"
                      onClick={(e) => { e.stopPropagation(); setOutputModal(true); }}
                    >
                      {t('chat.output.viewFull')}
                      {overflowLines > 0 && t('chat.output.overflowLines', { count: overflowLines })}
                      {overflowChars > 0 && overflowLines === 0 && t('chat.output.overflowChars', { count: overflowChars })}
                    </button>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
      {outputModal && body.result !== undefined && (
        <OutputModal
          title={presentTool(body.name, body.args, t).label}
          subtitle={presentTool(body.name, body.args, t).hint}
          text={body.result}
          onClose={() => setOutputModal(false)}
        />
      )}
    </div>
  );
}

/** Full-output popup. Used by Bash + other tools where we truncate the
 *  inline preview. Renders into the body via portal so chat-scroll
 *  containers can't clip it. */
function OutputModal({
  title,
  subtitle,
  text,
  onClose,
}: {
  title: string;
  subtitle?: string;
  text: string;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  // Portal'd into <body>, but React events bubble up the React tree
  // (not the DOM tree). If we don't stop them here they fire ChatColumn
  // onMouseDown / setFocusedId etc — which is what made the whole
  // panel "redraw" on close.
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return createPortal(
    <div onMouseDown={stop} onClick={stop}>
      <div className="scrim" onClick={onClose} />
      <div className="modal output-modal" data-screen-label="Modal · output">
        <div className="modal-head">
          <h2>{title}</h2>
          {subtitle && <div className="sub mono">{subtitle}</div>}
        </div>
        <div className="modal-body output-modal-body">
          <pre>{text}</pre>
        </div>
        <div className="modal-foot">
          <button
            className="btn ghost"
            onClick={() => { void navigator.clipboard.writeText(text); }}
          >
            {t('common.copy')}
          </button>
          <button className="btn primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Mirror of MessageRow's `return null` cases — used to filter the
 *  visible message list upfront so hidden messages don't leave behind
 *  empty wrappers (which would still contribute to .col-body's gap). */
function isMessageVisible(m: MessageRecord, consumedUserIds: Set<string>): boolean {
  if (consumedUserIds.has(m.id)) return false;
  if (m.kind === 'text') {
    try {
      const body = JSON.parse(m.body) as { text?: string; attachments?: unknown[] };
      return Boolean(body.text) || (Array.isArray(body.attachments) && body.attachments.length > 0);
    } catch {
      return false;
    }
  }
  if (m.kind === 'tool') {
    try {
      const body = JSON.parse(m.body) as { name?: string };
      return !HIDDEN_TOOL_NAMES.has(body.name ?? '');
    } catch {
      return true;
    }
  }
  // Permission + system always render something.
  return m.kind === 'permission' || m.kind === 'system';
}

/** Tools with rich expand-bodies even before they have a result back —
 *  e.g. an Edit row should be expandable to show the planned diff. */
function hasRichBody(body: MessageBodyTool): boolean {
  return body.name === 'Edit' || body.name === 'MultiEdit' || body.name === 'Write' || body.name === 'Bash';
}

/** Tools whose own diff is the confirmation — we don't need the
 *  trailing "The file X has been updated successfully" output noise. */
function isDiffTool(name: string): boolean {
  return name === 'Edit' || name === 'MultiEdit' || name === 'Write';
}

interface AskUserQuestionArgs {
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
}

function asAskUserQuestionArgs(
  tool: string,
  args: Record<string, unknown>,
): AskUserQuestionArgs | null {
  if (tool !== 'AskUserQuestion') return null;
  const qs = (args as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  return args as unknown as AskUserQuestionArgs;
}

type ScopedDecision =
  | 'allow' | 'allow-chat' | 'allow-everywhere' | 'allow-mcp-server'
  | 'deny'  | 'deny-everywhere';

function PermissionBlock({
  body,
  onDecide,
  onQuickReply,
}: {
  body: MessageBodyPermission;
  onDecide?: (permissionId: string, decision: ScopedDecision) => void;
  onQuickReply?: (text: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const decided = body.decision !== undefined;
  const ask = asAskUserQuestionArgs(body.tool, body.args);
  if (ask) {
    // PlanCard still uses the binary callback; convert decide(allow)
    // / decide(deny) into the shape it expects. We don't surface
    // chat / everywhere scope on Q&A cards — those are conversational,
    // not tool-permission decisions.
    return (
      <PlanCard
        body={body}
        ask={ask}
        decided={decided}
        onApprove={(pid) => onDecide?.(pid, 'allow')}
        onDeny={(pid) => onDecide?.(pid, 'deny')}
        onQuickReply={onQuickReply}
      />
    );
  }

  return (
    <div className="banner wait">
      <div className="banner-head">
        <span className="glyph">?</span>
        {t('chat.permission.wantsToUse')} <code>{toolLabel(body.tool, t)}</code>
      </div>
      {body.reason && <div className="banner-body">{body.reason}</div>}
      <div className="banner-body">
        <ArgsBlock args={body.args} />
      </div>
      <div className="banner-actions perm-actions">
        <button className="btn primary sm" onClick={() => onDecide?.(body.permissionId, 'allow')}>{t('chat.permission.allowOnce')}</button>
        <button className="btn sm"         onClick={() => onDecide?.(body.permissionId, 'allow-chat')}>{t('chat.permission.allowChat')}</button>
        <button className="btn sm"         onClick={() => onDecide?.(body.permissionId, 'allow-everywhere')}>{t('chat.permission.allowEverywhere')}</button>
        {/* MCP tools: one grant for the whole server, so its other tools don't
            re-prompt. Only shown for `mcp__<server>__…` tools. */}
        {isMcpTool(body.tool) && (
          <button className="btn sm" onClick={() => onDecide?.(body.permissionId, 'allow-mcp-server')}>
            {t('chat.permission.allowMcpServer', { server: mcpServerOfTool(body.tool) ?? 'MCP' })}
          </button>
        )}
        <button className="btn sm"         onClick={() => onDecide?.(body.permissionId, 'deny')}>{t('chat.permission.deny')}</button>
        <button className="btn sm"         onClick={() => onDecide?.(body.permissionId, 'deny-everywhere')}>{t('chat.permission.denyEverywhere')}</button>
      </div>
    </div>
  );
}

/** Walk the rendered window once: for each resolved AskUserQuestion
 *  permission row, find the next user-text message and pair them. The
 *  rendering then shows a compact Q/A block instead of two separated
 *  items with a big gap. */
function computeQAPairs(messages: MessageRecord[]): {
  consumedUserIds: Set<string>;
  qaAnswers: Map<string, string>;
} {
  const consumedUserIds = new Set<string>();
  const qaAnswers = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind !== 'permission') continue;
    let body: MessageBodyPermission;
    try {
      body = JSON.parse(m.body) as MessageBodyPermission;
    } catch {
      continue;
    }
    if (body.tool !== 'AskUserQuestion') continue;
    const isStale = i < messages.length - 1;
    const isResolved = body.decision !== undefined || isStale;
    if (!isResolved) continue;
    // Find the next user-text message after this permission row.
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next.role !== 'user' || next.kind !== 'text') continue;
      try {
        const text = (JSON.parse(next.body) as { text?: string }).text ?? '';
        qaAnswers.set(m.id, text);
        consumedUserIds.add(next.id);
      } catch {
        /* ignore */
      }
      break;
    }
  }
  return { consumedUserIds, qaAnswers };
}

/** Inline Q/A block for a resolved AskUserQuestion + its paired user
 *  answer. Tight spacing, slight visual differentiation so it doesn't
 *  read as plain prose. */
function QAPair({ question, answer }: { question: string; answer: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      style={{
        borderLeft: '2px solid var(--line-3)',
        paddingLeft: 10,
        margin: '2px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--fg-3)', fontStyle: 'italic' }}>
        {t('chat.qa.questionPrefix')} {question}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>
        <span style={{ color: 'var(--fg-3)' }}>{t('chat.qa.answerPrefix')}</span> {answer}
      </div>
    </div>
  );
}

/** Find the id of the latest agent-text message whose trimmed body ends
 *  with `?`. Used to render that message as a QuestionCard. */
function findQuestionMessageId(messages: MessageRecord[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'agent' || m.kind !== 'text') continue;
    const body = parseBody<MessageBodyText>(m.body, { text: '' });
    if (looksLikeQuestion(body.text)) return m.id;
    return null; // first agent text we see isn't a question; bail
  }
  return null;
}

/** Simple end-of-turn question — agent message that looks like a question
 *  per `looksLikeQuestion`. Uses the YELLOW `.plan.wait` variant so it
 *  reads as "needs you" not "pick a plan." If the question is detected
 *  as yes/no, surfaces Yes / No quick-reply buttons that send the
 *  answer as the next user message. */
function QuestionCard({
  text,
  onQuickReply,
}: {
  text: string;
  onQuickReply?: (text: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const yesNo = isYesNoQuestion(text);
  return (
    <div className="plan wait">
      <div className="plan-head">
        <span className="plan-head-icon">
          <i className="fa-solid fa-circle-question" />
        </span>
        {t('chat.question.heading')}
      </div>
      <div className="plan-q">
        <div className="prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{text}</ReactMarkdown>
        </div>
      </div>
      {yesNo && onQuickReply ? (
        <div className="plan-actions">
          <button className="btn-yn sm" onClick={() => onQuickReply('Yes')}>
            {t('chat.question.yes')}
          </button>
          <button className="btn-yn sm" onClick={() => onQuickReply('No')}>
            {t('chat.question.no')}
          </button>
          <span className="spacer" />
          <span style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
            {t('chat.question.typeLonger')}
          </span>
        </div>
      ) : (
        <div className="plan-foot" style={{ paddingBottom: 12 }}>
          {t('chat.question.replyBelow')}
        </div>
      )}
    </div>
  );
}

/** Multi-choice / planning card — uses the design's `.plan` markup. A
 *  click on a choice submits immediately (no separate Submit button).
 *  An "Other" row at the end opens an inline input so the user can
 *  send a free-text answer. Skip remains as a deny path. */
function PlanCard({
  body,
  ask,
  decided,
  onApprove,
  onDeny,
  onQuickReply,
}: {
  body: MessageBodyPermission;
  ask: AskUserQuestionArgs;
  decided: boolean;
  onApprove?: (permissionId: string) => void;
  onDeny?: (permissionId: string) => void;
  onQuickReply?: (text: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const q = ask.questions[0];
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState('');

  // Once the user has chosen, drop the big card — the answer is already
  // visible as the user's next message bubble. Just leave a quiet
  // one-liner so the question stays in scroll-back context.
  if (decided) {
    return (
      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-3)',
          padding: '2px 0',
          fontStyle: 'italic',
        }}
      >
        {t('chat.plan.asked', { question: q.question })}
      </div>
    );
  }

  const pickChoice = (label: string) => {
    if (decided) return;
    // We don't yet route the chosen label back via PermissionResult.updatedInput
    // — that requires knowing AskUserQuestion's expected input shape. For
    // now: send the chosen label as the user's next message AND approve
    // the tool so the SDK proceeds.
    onQuickReply?.(label);
    onApprove?.(body.permissionId);
  };

  const submitOther = () => {
    if (decided) return;
    const text = otherText.trim();
    if (!text) return;
    onQuickReply?.(text);
    onApprove?.(body.permissionId);
  };

  return (
    <div className="plan">
      <div className="plan-head">
        <span className="plan-head-icon">
          <i className="fa-solid fa-list-check" />
        </span>
        {q.header || t('chat.plan.pickOne')}
      </div>
      {q.question && <div className="plan-q">{q.question}</div>}
      <div className="plan-options">
        {q.options.map((opt, i) => (
          <div
            key={i}
            className="plan-opt"
            onClick={() => pickChoice(opt.label)}
            role="button"
            aria-disabled={decided}
          >
            <span className="plan-opt-key">{String.fromCodePoint(65 + i)}</span>
            <div className="plan-opt-body">
              <span className="plan-opt-title">{opt.label}</span>
              {opt.description && (
                <span className="plan-opt-sub">{opt.description}</span>
              )}
            </div>
          </div>
        ))}
        {!decided && !showOther && (
          <div className="plan-opt" onClick={() => setShowOther(true)} role="button">
            <span className="plan-opt-key">{String.fromCodePoint(65 + q.options.length)}</span>
            <div className="plan-opt-body">
              <span className="plan-opt-title">{t('chat.plan.otherOption')}</span>
            </div>
          </div>
        )}
        {!decided && showOther && (
          <div className="plan-opt sel" style={{ alignItems: 'stretch' }}>
            <span className="plan-opt-key">{String.fromCodePoint(65 + q.options.length)}</span>
            <div className="plan-opt-body" style={{ width: '100%' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', width: '100%' }}>
                <input
                  className="input mono"
                  placeholder={t('chat.plan.otherPlaceholder')}
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitOther();
                    else if (e.key === 'Escape') setShowOther(false);
                  }}
                  autoFocus
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  className="btn primary sm"
                  disabled={!otherText.trim()}
                  onClick={submitOther}
                  style={{ flex: '0 0 auto' }}
                >
                  {t('common.send')}
                </button>
              </div>
              <button
                className="btn ghost sm"
                onClick={() => setShowOther(false)}
                style={{ marginTop: 6, fontSize: 10.5 }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
      {!decided ? (
        <div className="plan-actions">
          <button className="btn sm" onClick={() => onDeny?.(body.permissionId)}>
            {t('chat.plan.skip')}
          </button>
          <span className="spacer" />
          <span style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
            {t('chat.plan.clickToSubmit')}
          </span>
        </div>
      ) : (
        <div className="plan-foot" style={{ paddingBottom: 12 }}>
          {body.decision === 'deny' ? t('chat.plan.skipped') : t('chat.plan.submitted')}
        </div>
      )}
    </div>
  );
}

/** Render tool args either as a single line of `k=v` pairs (when small)
 *  or as a JSON code block (when nested / multi-key / verbose). */
function ArgsBlock({ args }: { args: Record<string, unknown> }): JSX.Element {
  const entries = Object.entries(args);
  if (entries.length === 0) return <></>;
  const inline = formatArgs(args);
  const isComplex =
    inline.length > 80 ||
    entries.some(([, v]) => typeof v === 'object' && v !== null);
  if (!isComplex) {
    return (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{inline}</span>
    );
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: '6px 8px',
        background: 'var(--bg-0)',
        border: '1px solid var(--line-1)',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--fg-1)',
        maxHeight: 240,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {JSON.stringify(args, null, 2)}
    </pre>
  );
}

function parseBody<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join(' ');
}

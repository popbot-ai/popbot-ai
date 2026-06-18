/* global React */
const { useState: useStateN, useEffect: useEffectN, useRef: useRefN } = React;

// ---------- Notifications data (would come from LLM-classified feed in real app) ----------
const NOTIFICATIONS = [
  {
    id: "n1",
    kind: "review",
    urgency: "high",
    source: "GitHub",
    title: "Re-review requested · PR #4419",
    subtitle: "ENG-22134 · Fix character's jump animation",
    actor: { name: "Maya Chen", avatar: "MC", color: "#7e9cf0" },
    summary: "Maya pushed 3 new commits addressing your earlier comments on the jump-anim sync. Wants another pass before merge.",
    age: "4m",
    actions: [
      { kind: "internal", label: "Open in Reviews", target: { tab: "reviews", id: "4419" }, primary: true },
      { kind: "external", label: "View on GitHub", url: "https://github.com/acme/repo/pull/4419" },
      { kind: "spawn", label: "Spawn chat", target: { ticketId: "ENG-22134" } },
    ],
  },
  {
    id: "n2",
    kind: "slack",
    urgency: "high",
    source: "Slack · #server-android",
    title: "@arivera mentioned you",
    subtitle: "Thread: \"server loading for Android\"",
    actor: { name: "Alex Rivera", avatar: "BC", color: "#e5a061" },
    summary: "\"…@you have you seen the resolver hang on cold-launch? happens 1/10 boots on pixel-7. trace looks like the addressables init.\"",
    age: "11m",
    actions: [
      { kind: "internal", label: "Open in Slack tab", target: { tab: "slack", thread: "server-android" }, primary: true },
      { kind: "external", label: "Open in Slack app", url: "slack://thread/T01ABC/C02DEF/p1730000000123456" },
    ],
  },
  {
    id: "n3",
    kind: "ticket",
    urgency: "med",
    source: "Linear",
    title: "Tagged for triage · ENG-22231",
    subtitle: "Lobby clock drift after suspend/resume on iOS",
    actor: { name: "Aiyana Russell", avatar: "AR", color: "#9fbf85" },
    summary: "Aiyana asked you to take a look — the symptom matches your fix in c1 but it reproduces with NETSTAMP_V2 enabled. Probably a separate path.",
    age: "26m",
    actions: [
      { kind: "internal", label: "Open in Tickets", target: { tab: "tickets", id: "ENG-22231" }, primary: true },
      { kind: "spawn", label: "Spawn chat", target: { ticketId: "ENG-22231" } },
      { kind: "external", label: "Open in Linear", url: "https://linear.app/acme/issue/ENG-22231" },
    ],
  },
  {
    id: "n4",
    kind: "slack",
    urgency: "med",
    source: "Slack · DM",
    title: "Daichi Park asked for help",
    subtitle: "DM",
    actor: { name: "Daichi Park", avatar: "DP", color: "#c89bd3" },
    summary: "\"Hey when you have a sec — can you sanity-check the rolledDamage rename? I want to land it in the same release as your stamp work.\"",
    age: "42m",
    actions: [
      { kind: "internal", label: "Open in Slack tab", target: { tab: "slack", thread: "dp-dm" }, primary: true },
      { kind: "external", label: "Reply in Slack", url: "slack://channel/T01ABC/D03GHI" },
    ],
  },
  {
    id: "n5",
    kind: "review",
    urgency: "low",
    source: "GitHub",
    title: "Comment resolved · PR #4402",
    subtitle: "Resolver: drop legacy clientStamp field",
    actor: { name: "Sami Patel", avatar: "SP", color: "#7fb9c6" },
    summary: "Sami marked your suggestion resolved. PR is green; awaiting one more approval before auto-merge.",
    age: "1h",
    actions: [
      { kind: "internal", label: "Open in Reviews", target: { tab: "reviews", id: "4402" }, primary: true },
      { kind: "external", label: "View on GitHub", url: "https://github.com/acme/repo/pull/4402" },
    ],
  },
  {
    id: "n6",
    kind: "ticket",
    urgency: "low",
    source: "Linear",
    title: "Auto-classified · ENG-22198 · low priority",
    subtitle: "Hero portrait flickers in lobby on slow networks",
    actor: { name: "Triage bot", avatar: "TB", color: "#5d6678" },
    summary: "Likely related to your in-flight work on net stamps. Auto-grouped under your ENG-20402 epic. No action required.",
    age: "2h",
    actions: [
      { kind: "internal", label: "Open in Tickets", target: { tab: "tickets", id: "ENG-22198" }, primary: true },
      { kind: "dismiss", label: "Mark as read" },
    ],
  },
  {
    id: "n7",
    kind: "system",
    urgency: "med",
    source: "PopBot",
    title: "Drift detected on chat c3",
    subtitle: "Library cache crash · token usage 78%",
    actor: { name: "PopBot", avatar: "PB", color: "#7e9cf0" },
    summary: "Agent has been chasing the same exception for ~14 turns. Recommend providing a hint or starting a new chat with focused context.",
    age: "3h",
    actions: [
      { kind: "internal", label: "Focus chat c3", target: { focus: "c3" }, primary: true },
      { kind: "external", label: "Open drift report", url: "popbot://drift/c3" },
    ],
  },
  {
    id: "n8",
    kind: "review",
    urgency: "low",
    source: "GitHub",
    title: "PR merged · #4391",
    subtitle: "Cooldown flicker fix (ENG-20512)",
    actor: { name: "auto-merge", avatar: "GH", color: "#5d6678" },
    summary: "Your PR auto-merged after CI passed. Deployed to staging at 14:02 UTC.",
    age: "5h",
    actions: [
      { kind: "external", label: "View deploy", url: "https://deploys.acme/staging/4391", primary: true },
      { kind: "dismiss", label: "Mark as read" },
    ],
  },
];

const URGENCY_META = {
  high: { label: "High",  color: "#f0a8a8", bg: "rgba(214,90,90,0.16)",  border: "rgba(214,90,90,0.40)",  dot: "#e6796f" },
  med:  { label: "Med",   color: "#f4cf86", bg: "rgba(214,161,59,0.14)", border: "rgba(214,161,59,0.34)", dot: "#d6a13b" },
  low:  { label: "Low",   color: "#a8c4f0", bg: "rgba(120,140,255,0.10)",border: "rgba(120,140,255,0.28)",dot: "#7e9cf0" },
};

const KIND_ICON = {
  review:  "fa-code-pull-request",
  slack:   "fa-hashtag",
  ticket:  "fa-ticket",
  system:  "fa-robot",
};

function NotifAction({ action, onAct }) {
  const cls = action.primary ? "notif-act primary" : "notif-act";
  const icon =
    action.kind === "external" ? "fa-arrow-up-right-from-square" :
    action.kind === "spawn"    ? "fa-message" :
    action.kind === "dismiss"  ? "fa-check" :
                                 "fa-arrow-right";
  return (
    <button className={cls} onClick={(e) => { e.stopPropagation(); onAct(action); }}>
      <span>{action.label}</span>
      <i className={`fa-solid ${icon}`} />
    </button>
  );
}

function NotifItem({ n, onAct }) {
  const u = URGENCY_META[n.urgency];
  return (
    <div className={`notif-item u-${n.urgency}`}>
      <div className="notif-rail" style={{ background: u.dot }} />
      <div className="notif-avatar" style={{ background: n.actor.color }}>{n.actor.avatar}</div>
      <div className="notif-main">
        <div className="notif-row1">
          <i className={`fa-solid ${KIND_ICON[n.kind]} notif-kind`} />
          <span className="notif-source">{n.source}</span>
          <span className="notif-urgency" style={{ color: u.color, background: u.bg, borderColor: u.border }}>
            {u.label}
          </span>
          <span className="notif-spacer" />
          <span className="notif-age">{n.age}</span>
        </div>
        <div className="notif-title">{n.title}</div>
        {n.subtitle && <div className="notif-subtitle">{n.subtitle}</div>}
        <div className="notif-summary">{n.summary}</div>
        <div className="notif-actions">
          {n.actions.map((a, i) => <NotifAction key={i} action={a} onAct={onAct} />)}
        </div>
      </div>
    </div>
  );
}

function NotificationsDropdown({ open, onClose, anchorRef, onAct }) {
  const ref = useRefN(null);
  useEffectN(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef.current?.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;
  const counts = NOTIFICATIONS.reduce((m, n) => { m[n.urgency] = (m[n.urgency]||0)+1; return m; }, {});
  return (
    <div className="notif-pop" ref={ref} role="dialog" aria-label="Notifications">
      <div className="notif-pop-arrow" />
      <div className="notif-head">
        <div className="notif-head-title">
          <i className="fa-solid fa-bell" />
          <span>Notifications</span>
          <span className="notif-count">{NOTIFICATIONS.length}</span>
        </div>
        <div className="notif-head-meta">
          <span className="notif-llm">
            <i className="fa-solid fa-wand-magic-sparkles" />
            classified by Haiku
          </span>
        </div>
      </div>
      <div className="notif-summary-bar">
        <span className="notif-sum-chip" style={{ color: URGENCY_META.high.color, background: URGENCY_META.high.bg, borderColor: URGENCY_META.high.border }}>
          <i className="fa-solid fa-circle" /> {counts.high || 0} high
        </span>
        <span className="notif-sum-chip" style={{ color: URGENCY_META.med.color, background: URGENCY_META.med.bg, borderColor: URGENCY_META.med.border }}>
          <i className="fa-solid fa-circle" /> {counts.med || 0} med
        </span>
        <span className="notif-sum-chip" style={{ color: URGENCY_META.low.color, background: URGENCY_META.low.bg, borderColor: URGENCY_META.low.border }}>
          <i className="fa-solid fa-circle" /> {counts.low || 0} low
        </span>
        <span className="notif-spacer" />
        <button className="notif-mark-all" onClick={() => onAct({ kind: "dismiss-all" })}>Mark all read</button>
      </div>
      <div className="notif-list">
        {NOTIFICATIONS.map(n => <NotifItem key={n.id} n={n} onAct={onAct} />)}
      </div>
      <div className="notif-foot">
        <button className="notif-foot-btn">
          <i className="fa-solid fa-gear" /> Notification settings
        </button>
        <button className="notif-foot-btn">
          <i className="fa-solid fa-clock-rotate-left" /> View all history
        </button>
      </div>
    </div>
  );
}

function NotificationsBell({ onAct, unreadCount }) {
  const [open, setOpen] = useStateN(false);
  const anchorRef = useRefN(null);
  return (
    <div className="notif-anchor">
      <button
        ref={anchorRef}
        className={`titlebar-btn notif-bell ${unreadCount > 0 ? "has-unread" : ""}`}
        onClick={() => setOpen(v => !v)}
        title={`${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`}
        aria-label="Notifications"
      >
        <i className="fa-solid fa-bell" />
        {unreadCount > 0 && <span className="notif-badge">{unreadCount}</span>}
      </button>
      <NotificationsDropdown
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        onAct={(a) => { onAct(a); if (a.kind !== "dismiss" && a.kind !== "dismiss-all") setOpen(false); }}
      />
    </div>
  );
}

// ---------- Audio cues (synthesized via Web Audio — no assets) ----------
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
  }
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  return _audioCtx;
}
function playTone(freq, startOffset, duration, gain = 0.18) {
  const ctx = getAudioCtx(); if (!ctx) return;
  const t0 = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}
function playDing() {
  // Soft single chime — two-note interval
  playTone(880, 0, 0.32, 0.14);
  playTone(1320, 0.04, 0.36, 0.10);
}
function playBingBing() {
  // Stronger two-pulse alert — repeated rising interval
  playTone(660, 0,    0.18, 0.20);
  playTone(990, 0.02, 0.22, 0.16);
  playTone(660, 0.30, 0.18, 0.20);
  playTone(990, 0.32, 0.26, 0.16);
}

// ---------- Toaster ----------
function ToastItem({ n, onAct, onDismiss }) {
  const u = URGENCY_META[n.urgency];
  const [leaving, setLeaving] = useStateN(false);
  useEffectN(() => {
    const ttl = n.urgency === "high" ? 9000 : 6500;
    const t = setTimeout(() => setLeaving(true), ttl);
    return () => clearTimeout(t);
  }, []);
  useEffectN(() => {
    if (!leaving) return;
    const t = setTimeout(() => onDismiss(n.id), 280);
    return () => clearTimeout(t);
  }, [leaving]);
  const primary = n.actions.find(a => a.primary) || n.actions[0];
  return (
    <div className={`toast u-${n.urgency} ${leaving ? "leaving" : ""}`}>
      <div className="toast-rail" style={{ background: u.dot }} />
      <div className="toast-avatar" style={{ background: n.actor.color }}>{n.actor.avatar}</div>
      <div className="toast-main">
        <div className="toast-row1">
          <i className={`fa-solid ${KIND_ICON[n.kind]} toast-kind`} />
          <span className="toast-source">{n.source}</span>
          <span className="toast-urgency" style={{ color: u.color, background: u.bg, borderColor: u.border }}>
            {u.label}
          </span>
          <span className="notif-spacer" />
          <button className="toast-x" onClick={() => setLeaving(true)} title="Dismiss">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="toast-title">{n.title}</div>
        {n.subtitle && <div className="toast-subtitle">{n.subtitle}</div>}
        <div className="toast-actions">
          {primary && (
            <button className="notif-act primary" onClick={() => { onAct(primary); setLeaving(true); }}>
              <span>{primary.label}</span>
              <i className="fa-solid fa-arrow-right" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NotificationToaster({ toasts, onAct, onDismiss }) {
  return (
    <div className="toast-stack" role="region" aria-label="New notifications">
      {toasts.map(n => (
        <ToastItem key={n.id} n={n} onAct={onAct} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

// ---------- Manager: holds unread count + active toasts + simulates incoming ----------
function useNotificationManager() {
  const [unread, setUnread] = useStateN(3); // pretend we already have a few unseen
  const [toasts, setToasts] = useStateN([]);
  const seenRef = useRefN(new Set(NOTIFICATIONS.map(n => n.id))); // baseline: seed are "history"

  const pushToast = (n) => {
    setToasts(ts => [...ts.filter(t => t.id !== n.id), n].slice(-4)); // cap at 4 visible
    setUnread(c => c + 1);
    if (n.urgency === "high") playBingBing();
    else playDing();
  };
  const dismissToast = (id) => setToasts(ts => ts.filter(t => t.id !== id));
  const clearUnread = () => setUnread(0);

  return { unread, toasts, pushToast, dismissToast, clearUnread };
}

Object.assign(window, {
  NotificationsBell,
  NotificationToaster,
  useNotificationManager,
  playDing,
  playBingBing,
  NOTIFICATIONS,
});

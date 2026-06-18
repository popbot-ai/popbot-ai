/* global React */
const { useState: useStateB, useRef: useRefB, useEffect: useEffectB } = React;

// ---------- Logs (Panel D) ----------
const UNITY_LOGS = [
  ["00:14:22.481", "info",  "[CooldownView] subscribed to ability_resolved · slot=Q"],
  ["00:14:22.612", "info",  "[Resolver] tick 0 hero=huntress ability=Q seed=8821"],
  ["00:14:23.014", "warn",  "[Addressables] group 'vfx_boss_holiday' loaded on bootstrap (412MB)"],
  ["00:14:23.118", "info",  "[NetTime] drift=2ms server=49.2.114.7"],
  ["00:14:23.402", "info",  "[Resolver] tick 90 cd=2.500 ui=2.5"],
  ["00:14:23.880", "warn",  "[CooldownView] localExpiry vs serverExpiry mismatch by 1 frame"],
  ["00:14:24.001", "info",  "[Resolver] tick 180 cd=0.000 ui=0.0"],
  ["00:14:24.018", "error", "[CooldownView] flicker frame: ui=0.0 expected≥0.0 (frame 18341)"],
  ["00:14:24.140", "info",  "[Fixture] captured screenshot shots/cd-flicker-180.png"],
  ["00:14:24.402", "info",  "[Resolver] tick 270 cd=12.000 ui=12.0"],
  ["00:14:24.998", "info",  "[Hero.huntress] cast Q (cooldown=12.0)"],
  ["00:14:25.220", "exc",   "OverflowException at AssetBundleManifest.LoadAsync (offset=8721234112)"],
  ["00:14:25.221", "exc",   "  at LibraryCache.OpenChunk (path='boss_arena.bundle', offset=8721234112)"],
  ["00:14:25.450", "info",  "[GC] collected 24.1MB · paused 8ms"],
  ["00:14:26.012", "info",  "[Profiler] frame=18412 cpu=8.2ms gpu=4.1ms drawcalls=412"],
];

const SERVER_LOGS = [
  ["00:14:22.402", "info",  "POST /v1/match/ability_resolve  hero=huntress slot=Q  ok 8ms"],
  ["00:14:22.480", "info",  "broadcast ability_resolved seq=18341 cd_expires=49.2.16+12000ms"],
  ["00:14:23.011", "info",  "POST /v1/inventory/move   ok 4ms"],
  ["00:14:23.402", "info",  "broadcast ability_resolved seq=18342 cd_expires=49.2.18+9500ms"],
  ["00:14:23.612", "info",  "session.huntress hb ok rtt=18ms"],
  ["00:14:23.999", "warn",  "ability_resolve seq=18343 server-stamp=0 (client local-only)"],
  ["00:14:24.011", "info",  "broadcast ability_resolved seq=18343"],
  ["00:14:24.412", "info",  "POST /v1/match/ability_resolve  ok 6ms"],
  ["00:14:24.700", "info",  "session.huntress hb ok rtt=20ms"],
  ["00:14:25.020", "info",  "POST /v1/asset/manifest  size=8.7GB  ok 220ms"],
  ["00:14:25.225", "error", "client huntress reported asset overflow on 'boss_arena.bundle'"],
  ["00:14:25.290", "info",  "telemetry.exception logged · id=evt_88a1"],
  ["00:14:25.610", "info",  "POST /v1/match/ability_resolve  ok 7ms"],
  ["00:14:26.001", "info",  "broadcast ability_resolved seq=18344"],
];

function LogPane({ title, lines, scope, syncOn }) {
  const [filter, setFilter] = useStateB("all");
  const [q, setQ] = useStateB("");
  const filtered = lines.filter(([_, lvl, msg]) => {
    if (filter === "errors" && !["error", "exc"].includes(lvl)) return false;
    if (filter === "warnings" && lvl !== "warn") return false;
    if (q && !msg.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  return (
    <div className="log-pane">
      <div className="log-pane-head">
        <b>{title}</b>
        <span className="pill done" style={{ fontSize: 9 }}><span className="glyph">✓</span>:{scope}</span>
        <span style={{ flex: 1 }} />
        <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All</button>
        <button className={`chip ${filter === "errors" ? "active" : ""}`} onClick={() => setFilter("errors")}>Errors</button>
        <button className={`chip ${filter === "warnings" ? "active" : ""}`} onClick={() => setFilter("warnings")}>Warn</button>
        <input className="filter" placeholder="regex…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="log-body">
        {filtered.map((l, i) => (
          <div key={i} className={`log-line ${l[1]}`}>
            <span className="t">{l[0]}</span>
            <span className="lvl">{l[1].toUpperCase()}</span>
            <span className="msg">{l[2]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Terminal() {
  return (
    <div className="terminal">
{`mk@popbot `}<span className="path">eng/20512-cooldown-display</span>{` $ `}<span className="cmd">git status</span>{`
On branch eng/20512-cooldown-display
Your branch is up to date with 'origin/eng/20512-cooldown-display'.

Changes not staged for commit:
  modified:   Assets/UI/HUD/CooldownView.cs

`}<span className="out-dim">no changes added to commit (use "git add")</span>{`

mk@popbot `}<span className="path">eng/20512-cooldown-display</span>{` $ `}<span className="cmd">popbot fixture run combat-ability-loop --iter 10</span>{`
▶ booting unity (slot 1)        `}<span className="out-dim">PID 88421 · port :5101</span>{`
▶ scene PvE_Test_01             ok    420ms
▶ iteration 1/10                ok  1,240ms  cd-flicker=0
▶ iteration 2/10                ok  1,180ms  cd-flicker=0
▶ iteration 3/10                ok  1,210ms  cd-flicker=0
▶ iteration 4/10                `}<span className="cursor"></span>
    </div>
  );
}

function PanelD({ focusedChat }) {
  const [tab, setTab] = useStateB("logs");
  const [sync, setSync] = useStateB(true);
  return (
    <div className="bottom" data-screen-label="Panel D · Multifunction">
      <div className="bottom-head">
        <div className="bottom-tabs">
          <button className="bottom-tab" aria-selected={tab === "logs"} onClick={() => setTab("logs")}>Logs</button>
          <button className="bottom-tab" aria-selected={tab === "term"} onClick={() => setTab("term")}>Terminal</button>
          <button className="bottom-tab" style={{ color: "var(--fg-3)" }}>+</button>
        </div>
        <div className="bottom-actions">
          <span className="label">focused: {focusedChat?.name?.split(" ").slice(0, 2).join(" ") || "—"}</span>
          {tab === "logs" && (
            <>
              <button className={`chip ${sync ? "active" : ""}`} style={{ fontSize: 10, padding: "2px 8px", border: "1px solid var(--line-2)", borderRadius: 8, color: sync ? "var(--acc-hi)" : "var(--fg-2)", background: sync ? "var(--acc-bg)" : "transparent" }} onClick={() => setSync(s => !s)}>
                ⇅ sync scroll
              </button>
              <button className="iconbtn" title="Clear">⌫</button>
            </>
          )}
        </div>
      </div>
      <div className="bottom-body">
        {tab === "logs" ? (
          <>
            <LogPane title="Unity"  scope="slot-1 · :5101" lines={UNITY_LOGS} />
            <LogPane title="Server" scope="local · :8080" lines={SERVER_LOGS} />
          </>
        ) : (
          <Terminal />
        )}
      </div>
    </div>
  );
}

Object.assign(window, { PanelD });

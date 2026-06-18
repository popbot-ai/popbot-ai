/* global React */
const { useState: useStateC, useRef: useRefC, useEffect: useEffectC } = React;

// ---------- Chat column body content ----------
function ToolCall({ name, args, summary, body, defaultOpen }) {
  const [open, setOpen] = useStateC(!!defaultOpen);
  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen(v => !v)}>
        <span style={{ color: "var(--fg-3)" }}>{open ? "▾" : "▸"}</span>
        <span className="name">{name}</span>
        <span className="args">{args}</span>
        <span className="badge">{summary}</span>
      </div>
      {open && body && <div className="tool-body">{body}</div>}
    </div>
  );
}

function Diff({ path, add, rem, lines }) {
  return (
    <div className="diff">
      <div className="diff-head">
        <span style={{ color: "var(--fg-3)" }}>≡</span>
        <span className="path">{path}</span>
        <span className="stats"><span className="add">+{add}</span> <span className="rem">−{rem}</span></span>
      </div>
      <div className="diff-body">
        {lines.map((l, i) => (
          <div key={i} className={`ln ${l[0] === "+" ? "add" : l[0] === "-" ? "rem" : ""}`}>
            <span className="gut">{l[1]}</span>
            <span className="src">{l[2]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PermissionBanner({ kind, title, body, primary, secondary, remember, onApprove, onDeny }) {
  return (
    <div className={`banner ${kind || "wait"}`}>
      <div className="banner-head">
        <span className="glyph">{kind === "err" ? "✗" : "?"}</span>
        {title}
      </div>
      <div className="banner-body">{body}</div>
      <div className="banner-actions">
        <button className="btn primary sm" onClick={onApprove}>{primary || "Approve"}</button>
        <button className="btn sm" onClick={onDeny}>{secondary || "Deny"}</button>
        {remember && <label className="banner-check"><input type="checkbox" defaultChecked /> {remember}</label>}
      </div>
    </div>
  );
}

// ---------- Chat content per chat ----------
function ChatBody({ chat, onApprove, onDeny }) {
  if (chat.id === "c1") {
    return (
      <>
        <div className="msg agent">
          <div className="body">
            Looking at <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>ENG-20512</code>: ability cooldown intermittently shows 0.0s on the client.
            Reproducing in fixture <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>combat-ability-loop</code> first.
          </div>
        </div>
        <ToolCall
          name="unity.run_fixture"
          args={`fixture="combat-ability-loop" iterations=3`}
          summary="3/3 ok · 14.2s"
          defaultOpen
          body={`▶ booting scene PvE_Test_01\n▶ spawning hero  hero_huntress  lvl=12\n▶ tick 0    ability Q.cd=12.000 → ui=12.0s ✓\n▶ tick 90   ability Q.cd=2.500  → ui=2.5s  ✓\n▶ tick 180  ability Q.cd=0.000  → ui=0.0s  ⚠ flicker frame +1\n   captured screenshot: shots/cd-flicker-180.png`}
        />
        <div className="msg agent">
          <div className="body">
            Found it — the cooldown HUD reads <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>localExpiry</code> instead of the server-stamped one for one frame after resolve. Patching <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>CooldownView.Update</code>:
          </div>
        </div>
        <Diff
          path="Assets/UI/HUD/CooldownView.cs"
          add={4} rem={2}
          lines={[
            [" ", 84, "    void Update() {"],
            [" ", 85, "        var ability = Hero.Abilities[slot];"],
            ["-", 86, "        var remaining = ability.localExpiry - Time.time;"],
            ["-", 87, "        if (remaining < 0f) remaining = 0f;"],
            ["+", 86, "        var expiry = ability.serverExpiry > 0 ? ability.serverExpiry : ability.localExpiry;"],
            ["+", 87, "        var remaining = Mathf.Max(0f, expiry - NetTime.Now);"],
            ["+", 88, "        if (ability.lastResolveFrame == Time.frameCount) remaining = 0f; // suppress flicker frame"],
            ["+", 89, "        label.text = remaining.ToString(\"0.0\");"],
            [" ", 90, "    }"],
          ]}
        />
        <div className="msg user"><div className="body">Run fixture 10× to confirm; if green push a draft PR.</div></div>
        <div className="msg agent">
          <div className="body">On it. Re-running fixture <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>combat-ability-loop</code> ×10…</div>
        </div>
      </>
    );
  }
  if (chat.id === "c2") {
    return (
      <>
        <div className="msg agent">
          <div className="body">
            <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>ENG-20447</code>: crash reproduces when Library cache exceeds 8 GB. Trace points at <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>AssetBundleManifest.LoadAsync</code> hitting a 32-bit offset overflow.
          </div>
        </div>
        <ToolCall name="unity.read_log" args={`pattern="OverflowException"`} summary="3 matches" body={`OverflowException: Arithmetic operation resulted in an overflow.\n  at AssetBundleManifest.LoadAsync (UnityEngine.AssetBundle bundle, System.Int64 offset)\n  at LibraryCache.OpenChunk (System.String path, System.Int64 offset)`} />
        <div className="msg agent"><div className="body">Promoting offsets to <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>long</code>. Want to back up progress before more invasive changes.</div></div>
        <PermissionBanner
          title="Agent wants to push to remote"
          body={<>Run <code>git push origin eng/20447-library-cache</code> to back up the worktree before continuing.</>}
          remember="Always approve git push for this chat"
          onApprove={onApprove} onDeny={onDeny}
        />
      </>
    );
  }
  if (chat.id === "c3") {
    return (
      <>
        <div className="msg agent">
          <div className="body">Reviewing <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>PR #7401</code> — deterministic seeds for ability resolver. 8 hunks.</div>
        </div>
        <ToolCall name="git.diff" args={`base=develop head=pr/7401`} summary="8 files · +312 −188" />
        <div className="msg agent">
          <div className="body">
            Hunks 1-2 look clean — seed is threaded through <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>Resolver.Step</code> correctly. Hunk 3 worries me: the seed is being read by <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>HUD/AbilityHints</code>, which couples sim to UI.
          </div>
        </div>
        <Diff path="Assets/UI/AbilityHints.cs" add={2} rem={0} lines={[
          [" ", 41, "  void RebuildHints() {"],
          ["+", 42, "    var seed = Resolver.CurrentSeed; // ← UI reaching into sim"],
          ["+", 43, "    var rng = new System.Random(seed);"],
          [" ", 44, "    foreach (var ability in Hero.Abilities) {"],
        ]} />
        <div className="msg agent"><div className="body">Drafting a comment suggesting we expose a stable hint-rng via the resolver's public surface instead.</div></div>
      </>
    );
  }
  if (chat.id === "c4") {
    return (
      <>
        <div className="msg agent"><div className="body">Boss arena loadtime: profiled bootstrap. Three addressable groups loading on boot that don't need to.</div></div>
        <ToolCall name="unity.profile" args={`scene="BossArena_01" budget=1500ms`} summary="3 violations · saved trace" body={`group: vfx_boss_holiday      reason: marked label='boot'  size=412 MB  load=820ms\ngroup: cinematics_intro_v2    reason: ref by SpawnerPrefab  size=128 MB  load=240ms\ngroup: ambient_audio_arena_2  reason: marked label='boot'  size=64 MB   load=110ms`} />
        <Diff path="Assets/Addressables/groups/boss_arena.asset" add={3} rem={3} lines={[
          ["-", 12, "    label: 'boot'"],
          ["+", 12, "    label: 'arena_lazy'"],
          [" ", 13, "  - group: cinematics_intro_v2"],
          ["-", 14, "    refs: [SpawnerPrefab]"],
          ["+", 14, "    refs: [] # spawner now lazy-loads"],
          ["-", 16, "    label: 'boot'"],
          ["+", 16, "    label: 'arena_lazy'"],
        ]} />
        <div className="msg agent"><div className="body">Re-profiled: bootstrap down from <b>2,840ms → 1,220ms</b>. Opened <a style={{color:"var(--acc-hi)"}}>PR #7402</a>. Marking task done.</div></div>
        <div className="banner" style={{ background: "var(--st-done-bg)", borderColor: "rgba(63,178,127,0.4)" }}>
          <div className="banner-head" style={{ color: "#9fdbbb" }}>
            <span className="glyph">✓</span> Done — pushed branch, opened PR, posted summary to ENG-20355.
          </div>
        </div>
      </>
    );
  }
  // c5 idle
  return (
    <>
      <div className="msg agent"><div className="body">Reproduced inventory drag-preview flicker in fixture <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>inv-stack-resize</code>. Two possible fixes; want your call before proceeding.</div></div>
      <div className="msg agent"><div className="body"><b>Option A:</b> let the drag-preview own its own count, only sync on drop. Simple, but one frame of stale state during drag.<br/><b>Option B:</b> subscribe drag-preview directly to <code style={{fontFamily:"var(--font-mono)",fontSize:"11.5px",background:"var(--bg-2)",padding:"1px 5px",borderRadius:"3px"}}>InventoryStore.stackChanged$</code>. Tighter, but couples preview to store internals.</div></div>
      <div className="msg user"><div className="body">…</div></div>
    </>
  );
}

// ---------- Chat column ----------
function ChatColumn({ chat, onClose, onOpenSettings, onApprovePerm, onDenyPerm, isForeground, onToggleForeground, isActive, onActivate }) {
  const tokenPct = Math.min(100, (chat.tokens.used / chat.tokens.budget) * 100);
  const unityState = chat.status === "err" ? "err" : chat.status === "idle" ? "idle" : chat.status === "run" ? "run" : "ok";
  const agent = chat.agent || "claude";
  const statusIcon = chat.status === "run" ? "fa-circle-play" : chat.status === "done" ? "fa-circle-check" : chat.status === "wait" ? "fa-circle-question" : chat.status === "err" ? "fa-circle-xmark" : "fa-circle";
  return (
    <div className={`col ${isForeground ? "foreground" : "background"} ${isActive ? "is-active" : ""}`}
         data-screen-label={`Chat · ${chat.name}`}
         onMouseDown={onActivate}>
      {isActive && <div className="active-rail" aria-hidden="true" />}
      <div className="col-head">
        <button className="col-close" title="Close chat" onClick={onClose}><i className="fa-solid fa-xmark" /></button>
        {isActive && (
          <span className="active-chip" title="This chat receives your keystrokes">
            <i className="fa-solid fa-keyboard" /> ACTIVE
          </span>
        )}
        <span className="col-name" title={chat.name}>
          <span className="col-id">{chat.id}</span>
          <span className="col-title">{chat.name}</span>
        </span>
        <span className="col-meta">
          <button
            className={`fg-btn ${isForeground ? "foreground" : ""}`}
            onClick={(e) => { e.stopPropagation(); onToggleForeground(); }}
            title={isForeground
              ? "This chat's Unity & server are foregrounded. Click to send to background."
              : "Bring this chat's Unity & server to the foreground for testing"}>
            <span className="dot" />
            <i className={`fa-solid ${isForeground ? "fa-display" : "fa-window-restore"}`} />
            {isForeground ? "Foreground" : "Bring forward"}
          </button>
          <span className={`pill ${chat.status}`} title={`status: ${chat.status}`}>
            <i className={`fa-solid ${statusIcon}`} style={{ fontSize: 9 }} />
            {chat.status === "run" ? "running" : chat.status === "done" ? "done" : chat.status === "wait" ? "needs you" : chat.status === "err" ? "error" : "idle"}
          </span>
          <button className="iconbtn" style={{ width: 22, height: 22, borderRadius: 4, color: "var(--fg-2)" }}
                  onClick={(e) => { e.stopPropagation(); onOpenSettings(); }} title="Per-chat settings"><i className="fa-solid fa-gear" /></button>
        </span>
      </div>
      <div className="runtime-strip">
        <span className={`seg-item ${unityState === "err" ? "err" : unityState === "idle" ? "idle" : "ok"}`}>
          <i className={`fa-solid ${unityState === "err" ? "fa-circle-xmark" : unityState === "idle" ? "fa-circle" : "fa-circle-check"} g`} />
          Unity {unityState === "idle" ? "off" : unityState === "err" ? "crashed" : ":5101"}
        </span>
        <span className="sep">·</span>
        <span className={`seg-item ${chat.status === "err" ? "err" : "ok"}`}>
          <i className={`fa-solid ${chat.status === "err" ? "fa-circle-xmark" : "fa-circle-check"} g`} />
          Server {chat.status === "err" ? "drift" : ":8080"}
        </span>
        <span className="sep">·</span>
        <span className="seg-item idle">
          <i className="fa-solid fa-cube g" />slot 1
        </span>
        <span className={`where ${isForeground ? "fg" : "bg"}`}>
          <i className={`fa-solid ${isForeground ? "fa-display" : "fa-window-restore"}`} style={{ marginRight: 4 }} />
          {isForeground ? "on screen 1 · foreground" : "shrunken · screen 2"}
        </span>
      </div>
      <div className="col-body">
        <div style={{ fontSize: 10, color: "var(--fg-3)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: -4 }}>
          <i className="fa-solid fa-code-branch" style={{ marginRight: 4 }} />{chat.branch} · {chat.type === "lite" ? "Lite" : "Client Test"}{chat.ticket ? ` · ${chat.ticket}` : ""}{chat.pr ? ` · PR #${chat.pr}` : ""}
        </div>
        <ChatBody chat={chat} onApprove={onApprovePerm} onDeny={onDenyPerm} />
      </div>
      <div className="col-foot">
        <div className={`input-wrap ${isActive ? "active" : ""}`}>
          <textarea placeholder={isActive
            ? (chat.status === "run" ? "Agent running… type to queue a message" : "Send a message…")
            : "Click to make this the active chat"} />
          <div className="input-row">
            <button className="iconbtn" title="Attach screenshot"><i className="fa-solid fa-camera" /></button>
            <button className="iconbtn" title="Attach file"><i className="fa-solid fa-paperclip" /></button>
            <button className={`agent-select ${agent}`} title={`Model: ${agent === "claude" ? "Claude" : "Codex"} · click to change`}>
              <span className="agent-select-label">{agent === "claude" ? "Claude" : "Codex"}</span>
              <i className="fa-solid fa-caret-down" />
            </button>
            <span className="spacer" />
            <span className="token-counter"><b>{fmtTokens(chat.tokens.used)}</b> / {fmtTokens(chat.tokens.budget)}</span>
            {chat.status === "run"
              ? <button className="btn danger sm" title="Stop agent"><i className="fa-solid fa-stop" /> Stop</button>
              : <button className="btn primary sm">Send <span className="kbd">⌘↵</span></button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Empty / new column ----------
function EmptyColumn({ onClose }) {
  return (
    <div className="col" data-screen-label="Chat · Empty">
      <div className="col-head">
        <button className="col-close" title="Close" onClick={onClose}>×</button>
        <span className="col-name" style={{ color: "var(--fg-2)" }}>New chat</span>
      </div>
      <div className="col-empty">
        <div style={{ fontFamily: "var(--font-mono)", color: "var(--fg-3)", fontSize: 22 }}>＋</div>
        <h3>Start a new chat</h3>
        <p>Click a ticket or PR on the left to seed a chat, or pick a starting point below.</p>
        <div className="options">
          <button className="btn">+ Lite chat</button>
          <button className="btn primary">+ Client Test chat</button>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 12, lineHeight: 1.6 }}>
          <span className="kbd">⌘T</span> new chat · <span className="kbd">⌘⇧T</span> from clipboard URL · <span className="kbd">⌘K</span> palette
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ChatColumn, EmptyColumn, ChatBody, Diff, ToolCall, PermissionBanner });

/* global React */
const { useState: useStateC, useRef: useRefC, useEffect: useEffectC } = React;

// ---------- Chat column body content ----------
function ToolCall({ name, args, summary, body, defaultOpen }) {
  const [open, setOpen] = useStateC(!!defaultOpen);
  const expandable = !!body;
  return (
    <div className={`tool ${expandable ? "expandable" : ""} ${open ? "open" : ""}`}>
      <div className="tool-head" onClick={() => expandable && setOpen(v => !v)} role={expandable ? "button" : undefined}>
        <i className={`fa-solid ${open ? "fa-chevron-down" : "fa-chevron-right"} tool-chev`} aria-hidden="true" />
        <span className="name">{name}</span>
        <span className="args">{args}</span>
        <span className="badge">{summary}</span>
        {expandable && (
          <span className="tool-toggle" title={open ? "Collapse" : "Expand response"}>
            {open ? "hide" : "show"}
          </span>
        )}
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

// ---------- Rich content components ----------
function TurnMeta({ model = "claude", time, label }) {
  return (
    <div className="turn-meta">
      <i className="fa-solid fa-sparkles" style={{ fontSize: 9 }} />
      <span className={`model ${model}`}>{model === "codex" ? "Codex" : "Claude Sonnet 4.5"}</span>
      {label && <><span className="dot">·</span><span>{label}</span></>}
      {time && <><span className="dot">·</span><span>{time}</span></>}
    </div>
  );
}

function Thinking({ children }) {
  return (
    <div className="thinking">
      <i className="fa-solid fa-brain thinking-icon" style={{ fontSize: 10 }} />
      <span>{children}</span>
    </div>
  );
}

function Callout({ kind = "note", title, children, icon }) {
  const iconCls = icon || (kind === "warn" ? "fa-triangle-exclamation" : "fa-circle-info");
  return (
    <div className={`callout ${kind}`}>
      <i className={`fa-solid ${iconCls} callout-icon`} />
      <div className="callout-body">
        {title && <strong>{title}</strong>}{title && " — "}{children}
      </div>
    </div>
  );
}

function CodeBlock({ lang = "ts", code, file }) {
  // very light keyword highlighter
  const tokens = code.split(/(\b(?:public|private|class|struct|var|let|const|function|return|if|else|new|async|await|using|namespace|interface|void|int|float|string|bool|long|short|true|false|null|throw|try|catch)\b|"[^"]*"|'[^']*'|\/\/[^\n]*|\b\d+(?:\.\d+)?[ms]?\b)/g);
  const kw = /^(public|private|class|struct|var|let|const|function|return|if|else|new|async|await|using|namespace|interface|void|int|float|string|bool|long|short|true|false|null|throw|try|catch)$/;
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="lang">{lang}</span>
        {file && <span style={{ color: "var(--fg-3)" }}>· {file}</span>}
        <button className="copy" title="Copy"><i className="fa-regular fa-copy" style={{ fontSize: 10, marginRight: 4 }} />copy</button>
      </div>
      <div className="code-block-body">
        {tokens.map((tk, i) => {
          if (!tk) return null;
          if (kw.test(tk)) return <span key={i} className="kw">{tk}</span>;
          if (/^["']/.test(tk)) return <span key={i} className="str">{tk}</span>;
          if (/^\/\//.test(tk)) return <span key={i} className="com">{tk}</span>;
          if (/^\d/.test(tk)) return <span key={i} className="num">{tk}</span>;
          return <span key={i}>{tk}</span>;
        })}
      </div>
    </div>
  );
}

function Plan({ heading, question, options, defaultSel, footer }) {
  const [sel, setSel] = useStateC(defaultSel ?? null);
  return (
    <div className="plan">
      <div className="plan-head">
        <span className="plan-head-icon"><i className="fa-solid fa-list-check" /></span>
        {heading || "Pick one"}
      </div>
      {question && <div className="plan-q">{question}</div>}
      <div className="plan-options">
        {options.map((o, i) => (
          <div key={i} className={`plan-opt ${sel === i ? "sel" : ""}`} onClick={() => setSel(i)}>
            <span className="plan-opt-key">{o.key || String.fromCharCode(65 + i)}</span>
            <div className="plan-opt-body">
              <span className="plan-opt-title">{o.title}</span>
              {o.sub && <span className="plan-opt-sub">{o.sub}</span>}
              {o.tags && (
                <div className="plan-opt-tags">
                  {o.tags.map((t, j) => (
                    <span key={j} className={`plan-opt-tag ${t.kind || ""}`}>{t.label}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {footer && <div className="plan-foot">{footer}</div>}
    </div>
  );
}

function Figure({ src, label, name, meta, svg }) {
  return (
    <div className="fig">
      {svg ? svg : <img className="fig-img" src={src} alt={name} />}
      <div className="fig-cap">
        <span className="label">{label || "screenshot"}</span>
        <span className="name">{name}</span>
        {meta && <span className="meta">{meta}</span>}
      </div>
    </div>
  );
}

// Inline SVG screenshot placeholder so demo works without remote assets
function ScreenshotSVG({ title, subtitle, accent = "#7e8df0" }) {
  return (
    <svg viewBox="0 0 640 360" className="fig-img" style={{ aspectRatio: "16/9" }} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0f1320" />
          <stop offset="1" stopColor="#06070d" />
        </linearGradient>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0v40" fill="none" stroke="#1a2032" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect width="640" height="360" fill="url(#bg)" />
      <rect width="640" height="360" fill="url(#grid)" />
      {/* Mock HUD elements */}
      <circle cx="120" cy="180" r="44" fill="none" stroke={accent} strokeWidth="3" opacity="0.4" />
      <circle cx="120" cy="180" r="44" fill="none" stroke={accent} strokeWidth="3" strokeDasharray="276 276" strokeDashoffset="60" transform="rotate(-90 120 180)" />
      <text x="120" y="186" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="22" fontWeight="600" fill="#e4e7ef">2.5s</text>
      <rect x="220" y="160" width="280" height="6" rx="3" fill="#1a2032" />
      <rect x="220" y="160" width="186" height="6" rx="3" fill={accent} opacity="0.7" />
      <rect x="220" y="180" width="200" height="4" rx="2" fill="#1a2032" />
      <rect x="220" y="194" width="160" height="4" rx="2" fill="#1a2032" />
      <text x="220" y="225" fontFamily="Inter, sans-serif" fontSize="11" fill="#9aa3b8">{subtitle || "PvE_Test_01 · frame 180"}</text>
      <text x="32" y="36" fontFamily="JetBrains Mono, monospace" fontSize="10" fill="#5a6378" letterSpacing="0.1em">UNITY 2023.2 · PVE_TEST_01</text>
      <text x="32" y="52" fontFamily="Inter, sans-serif" fontSize="13" fontWeight="600" fill="#e4e7ef">{title || "Cooldown HUD"}</text>
      {/* fake fps badge */}
      <rect x="560" y="24" width="56" height="20" rx="3" fill="#0a0c11" stroke="#1a2032" />
      <text x="588" y="38" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="10" fill="#9fdbbb">120 fps</text>
    </svg>
  );
}

function MiniTable({ cols, rows }) {
  return (
    <div className="tbl">
      <table>
        <thead>
          <tr>{cols.map((c, i) => <th key={i} style={c.w ? { width: c.w } : null}>{c.h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => {
                const c = cols[j] || {};
                const cls = typeof cell === "object" && cell.cls ? cell.cls : c.cls || "";
                const v = typeof cell === "object" ? cell.v : cell;
                return <td key={j} className={cls}>{v}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
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
  if (chat.id === "c6") {
    return (
      <>
        <div className="msg user"><div className="body">Look at ENG-20402 and propose how to add server timestamps to ability resolve packets.</div></div>

        <TurnMeta model="claude" time="0:14" label="exploring" />
        <div className="msg agent"><div className="prose">
          <Thinking>Need to understand the current packet shape, who reads it, and what client code stamps locally before designing.</Thinking>
        </div></div>

        <ToolCall name="bash" args={`cat Assets/Net/Resolver.cs | sed -n '120,180p'`} summary="61 lines · exit 0"
          body={`public sealed class Resolver {
    readonly INetClock _clock;
    readonly IPacketSink _sink;

    public Resolver(INetClock clock, IPacketSink sink) {
        _clock = clock;
        _sink  = sink;
    }

    // called once per tick from CombatLoop.FixedTick()
    public void Emit(int tick, int slot, uint target, float dmg) {
        var pkt = new AbilityResolvePacket {
            tickIndex = tick,
            abilitySlot = slot,
            damage = dmg,                  // <-- legacy name, see ENG-19847
        };
        _sink.Send(pkt);
    }

    // NOTE: clients re-derive wall-clock from tick via NetTime.ServerTimeForTick(tick).
    // This is the source of the drift fixed in c1 — packets that arrive mid-frame
    // race the local tick boundary by up to ~33ms.
}

// 14 more matches truncated. Use grep for full list.`} />
        <ToolCall name="bash" args={`git log -- "Assets/Net/" --grep="resolver" -10 --format="%h %ad %an  %s" --date=short`} summary="10 commits · 4 authors"
          body={`a4f7c91 2025-09-12 Maya Chen      Resolver: skip emit when ability cancelled mid-cast
71b2e0d 2025-08-28 Daichi Park    Resolver.Emit: rename damage -> rolledDamage (deferred)
e88a4a3 2025-08-14 Maya Chen      Move tick stamping into NetClock for replay parity
1c2f5ee 2025-07-30 Sami Patel     fix: Resolver double-emits on rejoin
0bfa912 2025-07-22 Daichi Park    Resolver: drop legacy clientStamp field
9d4187a 2025-06-30 Marco Reyes    Resolver: gate emit behind feature flag NETSTAMP_V2
3a72c01 2025-06-19 Maya Chen      Add Resolver fixture for desync repro
... 3 more`} />
        <ToolCall name="bash" args={`rg "AbilityResolvePacket" Assets/ --no-heading -n`} summary="14 matches in 9 files"
          body={`Assets/Net/AbilityResolvePacket.cs:8:    public struct AbilityResolvePacket {
Assets/Net/Resolver.cs:131:        var pkt = new AbilityResolvePacket {
Assets/Net/NetSerializer.cs:402:    public static int Write(ref AbilityResolvePacket p, Span<byte> dst) {
Assets/Net/NetSerializer.cs:418:    public static AbilityResolvePacket ReadAbilityResolvePacket(ReadOnlySpan<byte> src) {
Assets/UI/CooldownView.cs:54:    void OnResolve(AbilityResolvePacket p) {
Assets/UI/BuffTracker.cs:88:    public void Apply(AbilityResolvePacket p) {
Assets/Combat/AbilityLog.cs:217:    public void Record(AbilityResolvePacket p) {
Assets/Replay/ReplaySink.cs:44:    public void Capture(in AbilityResolvePacket p) { ... }
Assets/Test/Net/Fixture.AbilityResolve.cs:11: ... 5 more matches in this file`} />

        <TurnMeta model="claude" time="0:42" />
        <div className="msg agent"><div className="prose">
          <h2>Server timestamp design — three options</h2>
          <p>The packet currently carries <code>tickIndex</code> only; the client converts that to a wall-clock for the HUD via <code>NetTime.ServerTimeForTick(tick)</code>. <strong>That's fine for animation</strong> but it's the root cause of the cooldown flicker we just fixed in <code>c1</code> — the local conversion can drift up to <strong>one tick (~33ms)</strong> ahead of the authoritative time when the packet arrives mid-frame.</p>

          <p>Here's what I found while reading <code>Resolver.cs</code> and the call sites:</p>
          <ul>
            <li><strong>Five readers</strong> rely on <code>tickIndex</code> today — <code>CooldownView</code>, <code>BuffTracker</code>, <code>AbilityLog</code>, <code>ReplaySink</code>, and the desync fixture.</li>
            <li><strong>Two of those</strong> (<code>CooldownView</code>, <code>BuffTracker</code>) re-derive wall-clock and are the ones flickering.</li>
            <li><code>ReplaySink</code> <em>requires</em> <code>tickIndex</code> stays in the packet for deterministic playback — we can't replace it.</li>
            <li>The wire encoder in <code>NetSerializer.cs</code> is <strong>auto-generated</strong> from <code>schema/packets.proto</code>, so any field add means running <code>./tools/gen-packets.sh</code>.</li>
            <li>An older <code>clientStamp</code> field was removed in <code>0bfa912</code> — worth knowing because the wire-compat layer in <code>NetWire.cs:88</code> already handles unknown fields by skipping. <strong>Old clients won't crash on a new field.</strong></li>
          </ul>

          <p>Three ways to expose a real server timestamp. Each is a different tradeoff between <strong>wire cost</strong>, <strong>refactor blast radius</strong>, and how much it helps adjacent bugs:</p>

          <h4>Option summary</h4>
          <MiniTable
            cols={[
              { h: "Option", w: "26%" },
              { h: "+wire/pkt", cls: "num" },
              { h: "Refactor", cls: "mono" },
              { h: "Helps drift?", cls: "dim" },
            ]}
            rows={[
              [{ v: "A · raw int64 µs", cls: "" }, "8 B", "small", { v: "yes", cls: "dim" }],
              [{ v: "B · delta from tick", cls: "" }, "2 B", "med", { v: "yes", cls: "dim" }],
              [{ v: "C · full TimeSync block", cls: "" }, "16 B", "large", { v: "yes + RTT", cls: "dim" }],
            ]}
          />

          <Plan
            heading="Pick a direction"
            question="Which approach should I implement? I'll wire up a fixture and PR after you choose."
            defaultSel={1}
            options={[
              { key: "A", title: "Raw int64 microseconds since epoch",
                sub: "Add stampUs to AbilityResolvePacket. Client uses it directly; tickIndex stays for replay. Cheapest to ship.",
                tags: [{label:"+8 B/pkt"}, {label:"low risk", kind:"good"}] },
              { key: "B", title: "Δ-encoded micros from tick boundary",
                sub: "Send a uint16 offset within the tick. Reconstructs to int64 client-side; same precision at 4× less wire. My recommendation.",
                tags: [{label:"+2 B/pkt", kind:"good"}, {label:"shared encoder", kind:"warn"}] },
              { key: "C", title: "Full TimeSync sub-block",
                sub: "Carry stampUs, recvUs, and an RTT estimate. Lets us also fix the lobby-clock drift bug, but touches every other resolve path.",
                tags: [{label:"+16 B/pkt"}, {label:"large refactor", kind:"warn"}] },
            ]}
            footer={<><i className="fa-regular fa-clock" style={{ fontSize: 10, marginRight: 4 }} />Awaiting choice · context 286k / 1M</>}
          />
        </div></div>

        <div className="msg user"><div className="body">Show me what the packet change actually looks like for B.</div></div>

        <TurnMeta model="claude" time="1:08" />
        <div className="msg agent"><div className="prose">
          <p>Here's the wire-format change for <strong>Option B</strong>. The new field <code>tickOffsetUs</code> is a <code>uint16</code> microseconds-since-tick-start; client reconstructs <code>stampUs = tickStartUs(tick) + tickOffsetUs</code>.</p>
          <p>What you're looking at in the diff below:</p>
          <ul>
            <li><strong>One added field</strong> — <code>ushort tickOffsetUs</code>, sitting between <code>tickIndex</code> and <code>abilitySlot</code> for cache locality.</li>
            <li><strong>One renamed field</strong> — <code>damage</code> → <code>rolledDamage</code>, picking up the rename Daichi deferred in <code>71b2e0d</code>. Ride-along, easy revert if you want it pulled.</li>
            <li><strong>Stamping happens at <code>Emit()</code></strong>, not at packet construction, so test fixtures can inject a fake clock.</li>
            <li><strong>Mask is <code>0x7FFF</code></strong> — keeps offsets in <code>[0, 32767)</code> µs (one tick = 33,333 µs), so we never overflow the high bit.</li>
          </ul>
        </div></div>

        <CodeBlock lang="cs" file="Assets/Net/AbilityResolvePacket.cs" code={`// before
public struct AbilityResolvePacket {
    public int    tickIndex;
    public int    abilitySlot;
    public uint   targetEntityId;
    public float  rolledDamage;
}

// after
public struct AbilityResolvePacket {
    public int    tickIndex;
    public ushort tickOffsetUs;   // 0..32767, server-stamped
    public int    abilitySlot;
    public uint   targetEntityId;
    public float  rolledDamage;
}

public static long StampUs(in AbilityResolvePacket p) {
    return NetTime.TickStartUs(p.tickIndex) + p.tickOffsetUs;
}`} />

          <Diff path="Assets/Net/Resolver.cs" add={3} rem={1} lines={[
            [" ", 142, "    public void Emit(int tick, int slot, uint target, float dmg) {"],
            [" ", 143, "        var pkt = new AbilityResolvePacket {"],
            [" ", 144, "            tickIndex = tick,"],
            ["+", 145, "            tickOffsetUs = (ushort)((NowUs() - TickStartUs(tick)) & 0x7FFF),"],
            [" ", 146, "            abilitySlot = slot,"],
            ["+", 147, "            targetEntityId = target,"],
            ["-", 148, "            damage = dmg,"],
            ["+", 149, "            rolledDamage = dmg,"],
            [" ", 150, "        };"],
            [" ", 151, "    }"],
          ]} />

          <div className="msg agent"><div className="prose">
            <p>And here's what the HUD sees with the new stamp — re-ran <code>combat-ability-loop</code> against a local prototype build:</p>
          </div></div>

          <Figure
            label="screenshot"
            name="cooldown-hud-with-stamped-tick.png"
            meta="640×360 · 31 KB"
            svg={<ScreenshotSVG title="CooldownView · stamped" subtitle="serverExpiry from tickOffsetUs · drift = 0.0ms" />}
          />

          <div className="msg agent"><div className="prose">
            <Callout kind="warn" title="One thing to confirm">
              The encoder/decoder lives in <code>NetSerializer.cs</code> (auto-generated from <code>schema/packets.proto</code>). I'll need to regenerate after editing the schema — that touches ~40 files but the diff is mechanical. Approve regeneration when you say go.
            </Callout>
          </div></div>

          <PermissionBanner
            title="Agent wants to run code generator"
            body={<>Run <code>./tools/gen-packets.sh</code> after the schema edit. Modifies ~40 generated files under <code>Assets/Net/Generated/</code>.</>}
            remember="Always approve gen-packets for this chat"
            onApprove={onApprove} onDeny={onDeny}
          />

        <TurnMeta model="claude" time="1:22" />
        <div className="msg agent"><div className="prose">
          <h3>Implementation checklist</h3>
          <p>Once you approve the regeneration, here's the sequence I'll run:</p>
          <ol>
            <li>Edit <code>schema/packets.proto</code> — add <code>tick_offset_us</code> to <code>AbilityResolvePacket</code></li>
            <li>Run <code>./tools/gen-packets.sh</code> — regenerates serializer + 40 generated files</li>
            <li>Update <code>Resolver.Emit()</code> to stamp at send time (diff above)</li>
            <li>Update <code>NetTime.StampUs()</code> helper for client read</li>
            <li>Migrate <code>CooldownView</code> and <code>BuffTracker</code> to use stamped time
              <ul>
                <li>Both currently re-derive from <code>tickIndex</code></li>
                <li>One-line change each</li>
              </ul>
            </li>
            <li>Add fixture <code>net/server-stamp-precision</code> — asserts client/server agree to within 100µs over 10k packets</li>
            <li>Open draft PR against <code>develop</code></li>
          </ol>
          <blockquote>Risk note: <em>Old clients connecting to a new server will see the new field as garbage in the legacy slot.</em> The wire compat layer in <code>NetWire.cs:88</code> handles unknown fields by skipping, so this is safe — but worth calling out.</blockquote>
          <p>Ready when you are. Reply <strong>go</strong> to start, or <code>switch to A</code> / <code>switch to C</code> to change direction.</p>
        </div></div>
      </>
    );
  }
  // c5 idle (default fallback)
  return (
    <>
      <div className="msg agent"><div className="prose">Reproduced inventory drag-preview flicker in fixture <code>inv-stack-resize</code>. Two possible fixes; want your call before proceeding.</div></div>
      <Plan
        heading="Pick one"
        question="Where should the drag-preview's stack count come from?"
        options={[
          { key: "A", title: "Drag-preview owns its own count", sub: "Only sync on drop. Simple, but one frame of stale state during drag.", tags: [{label:"simple", kind:"good"}] },
          { key: "B", title: "Subscribe to InventoryStore.stackChanged$", sub: "Tighter, but couples preview to store internals.", tags: [{label:"tight"}, {label:"coupling", kind:"warn"}] },
        ]}
      />
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

Object.assign(window, { ChatColumn, EmptyColumn, ChatBody, Diff, ToolCall, PermissionBanner, Plan, CodeBlock, Figure, ScreenshotSVG, MiniTable, Callout, Thinking, TurnMeta });

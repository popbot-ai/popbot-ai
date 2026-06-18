/* global React */
const { useState: useStateP2 } = React;

/* PreferencesWindow
 * App-level preferences. Modal-style overlay with left-nav + body.
 * Sections cover the realistic pref categories an operator-multiagent tool
 * needs without being exhaustive. Each control is wired to local state only.
 */
function PreferencesWindow({ onClose }) {
  const [section, setSection] = useStateP2("general");

  const SECTIONS = [
    { id: "general",    label: "General",            icon: "fa-sliders" },
    { id: "appearance", label: "Appearance",         icon: "fa-palette" },
    { id: "agents",     label: "Agents & Models",    icon: "fa-robot" },
    { id: "automation", label: "Automation & Safety",icon: "fa-shield-halved" },
    { id: "runtime",    label: "Runtime & Slots",    icon: "fa-microchip" },
    { id: "windows",    label: "Windows & Display",  icon: "fa-display" },
    { id: "logs",       label: "Logs & Terminal",    icon: "fa-rectangle-list" },
    { id: "notify",     label: "Notifications",      icon: "fa-bell" },
    { id: "shortcuts",  label: "Shortcuts",          icon: "fa-keyboard" },
    { id: "integ",      label: "Integrations",       icon: "fa-plug" },
    { id: "git",        label: "Source control",     icon: "fa-code-branch" },
    { id: "privacy",    label: "Privacy & Telemetry",icon: "fa-user-shield" },
    { id: "advanced",   label: "Advanced",           icon: "fa-flask" },
  ];

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="prefs" data-screen-label="Preferences">
        <div className="prefs-head">
          <h2><i className="fa-solid fa-gear" /> Preferences</h2>
          <input className="prefs-search" placeholder="Search preferences…" />
          <button className="iconbtn" onClick={onClose} style={{ width: 28, height: 28 }} title="Close ⌘W">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="prefs-body">
          <nav className="prefs-nav">
            {SECTIONS.map(s => (
              <button key={s.id}
                      className={`prefs-nav-item ${section === s.id ? "active" : ""}`}
                      onClick={() => setSection(s.id)}>
                <i className={`fa-solid ${s.icon}`} />
                <span>{s.label}</span>
              </button>
            ))}
            <div className="prefs-nav-foot">
              <div className="prefs-account">
                <span className="prefs-avatar" style={{ background: avatarColor("you") }}>YO</span>
                <div>
                  <div className="prefs-account-name">you@example.com</div>
                  <div className="prefs-account-org">org · acme-demo-app</div>
                </div>
              </div>
            </div>
          </nav>
          <div className="prefs-content">
            {section === "general"    && <PrefsGeneral />}
            {section === "appearance" && <PrefsAppearance />}
            {section === "agents"     && <PrefsAgents />}
            {section === "automation" && <PrefsAutomation />}
            {section === "runtime"    && <PrefsRuntime />}
            {section === "windows"    && <PrefsWindows />}
            {section === "logs"       && <PrefsLogs />}
            {section === "notify"     && <PrefsNotify />}
            {section === "shortcuts"  && <PrefsShortcuts />}
            {section === "integ"      && <PrefsIntegrations />}
            {section === "git"        && <PrefsGit />}
            {section === "privacy"    && <PrefsPrivacy />}
            {section === "advanced"   && <PrefsAdvanced />}
          </div>
        </div>
        <div className="prefs-foot">
          <span className="prefs-foot-meta">PopBot v0.4.2 · build 1284 · electron 30.1</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost">Reset section</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}

/* ---------- Reusable building blocks ---------- */
function PrefRow({ title, desc, children, wide }) {
  return (
    <div className={`pref-row ${wide ? "wide" : ""}`}>
      <div className="pref-label">
        <div className="pref-title">{title}</div>
        {desc && <div className="pref-desc">{desc}</div>}
      </div>
      <div className="pref-control">{children}</div>
    </div>
  );
}

function PrefSection({ title, desc, children }) {
  return (
    <section className="pref-section">
      <header>
        <h3>{title}</h3>
        {desc && <p className="pref-section-desc">{desc}</p>}
      </header>
      <div className="pref-rows">{children}</div>
    </section>
  );
}

function Toggle({ on, onChange }) {
  const [v, setV] = useStateP2(on === undefined ? false : on);
  return (
    <button className={`pref-toggle ${v ? "on" : ""}`}
            onClick={() => { setV(!v); onChange && onChange(!v); }}
            aria-pressed={v}>
      <span className="pref-toggle-thumb" />
    </button>
  );
}

function Select({ value, options }) {
  const [v, setV] = useStateP2(value);
  return (
    <select className="pref-select" value={v} onChange={e => setV(e.target.value)}>
      {options.map(o => <option key={o.value || o} value={o.value || o}>{o.label || o}</option>)}
    </select>
  );
}

function Stepper({ value, suffix }) {
  const [v, setV] = useStateP2(value);
  return (
    <div className="pref-stepper">
      <button onClick={() => setV(x => Math.max(0, x - 1))}><i className="fa-solid fa-minus" /></button>
      <input value={v} onChange={e => setV(parseInt(e.target.value) || 0)} />
      {suffix && <span className="pref-stepper-suffix">{suffix}</span>}
      <button onClick={() => setV(x => x + 1)}><i className="fa-solid fa-plus" /></button>
    </div>
  );
}

function Segmented({ value, options }) {
  const [v, setV] = useStateP2(value);
  return (
    <div className="pref-segmented">
      {options.map(o => (
        <button key={o.value || o}
                className={v === (o.value || o) ? "on" : ""}
                onClick={() => setV(o.value || o)}>
          {o.label || o}
        </button>
      ))}
    </div>
  );
}

function ColorChip({ color, label, on }) {
  const [v, setV] = useStateP2(!!on);
  return (
    <button className={`pref-colorchip ${v ? "on" : ""}`} onClick={() => setV(true)} title={label}>
      <span style={{ background: color }} />
      <span className="lbl">{label}</span>
    </button>
  );
}

function Kbd({ children }) {
  return <span className="kbd">{children}</span>;
}

/* ---------- Panels ---------- */

function PrefsGeneral() {
  return (
    <>
      <PrefSection title="Startup">
        <PrefRow title="On launch" desc="What PopBot does when you open it.">
          <Select value="restore" options={[
            { value: "restore", label: "Restore last session" },
            { value: "fresh",   label: "Open a fresh window" },
            { value: "ask",     label: "Ask each time" },
          ]} />
        </PrefRow>
        <PrefRow title="Open at login">
          <Toggle on={true} />
        </PrefRow>
        <PrefRow title="Default new-chat workspace" desc="The folder freshly-spawned chats will reference.">
          <Select value="demo-app" options={["acme-demo-app", "acme-tools", "acme-server"]} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Sessions">
        <PrefRow title="Auto-archive done chats after"
                 desc="Completed chats move to Inactive automatically.">
          <Select value="24h" options={["1h", "8h", "24h", "3d", "Never"]} />
        </PrefRow>
        <PrefRow title="Max active chats"
                 desc="When you exceed this, you'll be asked to evict one.">
          <Stepper value={6} />
        </PrefRow>
        <PrefRow title="Confirm before closing window with running agents">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Updates">
        <PrefRow title="Channel">
          <Segmented value="stable" options={["stable", "beta", "nightly"]} />
        </PrefRow>
        <PrefRow title="Auto-install updates" desc="Restarts on next idle window.">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsAppearance() {
  return (
    <>
      <PrefSection title="Theme">
        <PrefRow title="Mode">
          <Segmented value="dark" options={["system", "light", "dark"]} />
        </PrefRow>
        <PrefRow title="Accent" wide>
          <div className="pref-swatchrow">
            <ColorChip color="#6b7cff" label="Indigo" on />
            <ColorChip color="#8a6df0" label="Violet" />
            <ColorChip color="#3fb27f" label="Forest" />
            <ColorChip color="#d99647" label="Amber" />
            <ColorChip color="#e36b8c" label="Rose" />
            <ColorChip color="#5cb8d1" label="Cyan" />
          </div>
        </PrefRow>
        <PrefRow title="Sidebar density"
                 desc="Compact reduces row padding in Panels A and B.">
          <Segmented value="comfortable" options={["compact", "comfortable", "spacious"]} />
        </PrefRow>
        <PrefRow title="Reduce motion"
                 desc="Disables pulses, blinking cursors, and slide-in animations.">
          <Toggle on={false} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Typography">
        <PrefRow title="UI font">
          <Select value="inter" options={[
            { value: "inter", label: "Inter (default)" },
            { value: "system", label: "System UI" },
            { value: "ibm",  label: "IBM Plex Sans" },
          ]} />
        </PrefRow>
        <PrefRow title="Mono font" desc="Used for branches, logs, and tool calls.">
          <Select value="jetbrains" options={[
            { value: "jetbrains", label: "JetBrains Mono" },
            { value: "iosevka",   label: "Iosevka" },
            { value: "fira",      label: "Fira Code" },
            { value: "menlo",     label: "Menlo" },
          ]} />
        </PrefRow>
        <PrefRow title="Base size">
          <Stepper value={13} suffix="px" />
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsAgents() {
  return (
    <>
      <PrefSection title="Default model"
                   desc="Used when spawning a new chat. Per-chat override available in column settings.">
        <PrefRow title="Model">
          <Select value="claude" options={[
            { value: "claude", label: "Claude — sonnet 4.5 (default)" },
            { value: "claude-haiku", label: "Claude — haiku 4.5" },
            { value: "codex",  label: "OpenAI Codex" },
            { value: "gpt",    label: "OpenAI GPT-5" },
          ]} />
        </PrefRow>
        <PrefRow title="Max tokens / turn">
          <Stepper value={32_000} />
        </PrefRow>
        <PrefRow title="Context budget per chat" desc="Soft cap before token bar turns red.">
          <Stepper value={1_000_000} />
        </PrefRow>
        <PrefRow title="Allow model auto-switch" desc="Drops to a smaller model when within 10% of budget.">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="System prompts">
        <PrefRow title="Default system prompt" desc="Used for ad-hoc chats." wide>
          <textarea className="pref-textarea" rows={3}
                    defaultValue="You are a senior Unity engineer working in the acme-demo-app repo. Prefer minimal diffs. Read related files before editing. When in doubt, ask." />
        </PrefRow>
        <PrefRow title="Append repo CLAUDE.md if present" desc="Picked up automatically from project root.">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Conversation behavior">
        <PrefRow title="Show thinking blocks">
          <Segmented value="collapsed" options={["off", "collapsed", "expanded"]} />
        </PrefRow>
        <PrefRow title="Auto-summarize when context > 80%">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsAutomation() {
  return (
    <>
      <PrefSection title="Permission policy"
                   desc="Default approval level for tool calls. Per-chat override available in settings.">
        <PrefRow title="Default mode">
          <Segmented value="ask-tools" options={[
            { value: "read-only",  label: "Read-only" },
            { value: "ask-tools",  label: "Ask before tool calls" },
            { value: "ask-writes", label: "Ask before writes" },
            { value: "auto",       label: "Full autonomy" },
          ]} />
        </PrefRow>
        <PrefRow title="Always allow these tools" wide
                 desc="Comma-separated. Globs supported.">
          <input className="pref-input" defaultValue="read_file, list_files, grep, eval_js, get_webview_logs" />
        </PrefRow>
        <PrefRow title="Always require approval for"
                 desc="These tools always prompt regardless of mode." wide>
          <input className="pref-input" defaultValue="run_terminal, write_file, delete_file, push, force_push" />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Safety rails">
        <PrefRow title="Pause when working tree drifts" desc="Stops the agent if `origin/main` advances mid-task.">
          <Toggle on={true} />
        </PrefRow>
        <PrefRow title="Block writes outside repo">
          <Toggle on={true} />
        </PrefRow>
        <PrefRow title="Block deletes of >50 files" desc="Hard guardrail; agent must ask explicitly.">
          <Toggle on={true} />
        </PrefRow>
        <PrefRow title="Idle timeout" desc="Auto-stop a running agent that hasn't produced output.">
          <Select value="10m" options={["3m", "10m", "30m", "Never"]} />
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsRuntime() {
  return (
    <>
      <PrefSection title="Unity slots"
                   desc="Each slot owns a Unity process and a port range. One slot's instance can be foreground; the rest run shrunken.">
        <PrefRow title="Number of slots">
          <Stepper value={4} />
        </PrefRow>
        <PrefRow title="Unity port base"
                 desc="Slot N uses base + N. e.g. 5101, 5102, …">
          <Stepper value={5101} />
        </PrefRow>
        <PrefRow title="Game-server port base">
          <Stepper value={8080} />
        </PrefRow>
        <PrefRow title="Auto-restart on crash">
          <Toggle on={true} />
        </PrefRow>
        <PrefRow title="Restart cap before manual reset" desc="Slot is held until you click 'Reset slot'.">
          <Stepper value={3} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Build pipeline">
        <PrefRow title="Pre-foreground action" desc="Run before bringing a chat's runtime forward.">
          <Select value="incremental" options={[
            { value: "none",        label: "Nothing" },
            { value: "incremental", label: "Incremental build" },
            { value: "clean",       label: "Clean build" },
          ]} />
        </PrefRow>
        <PrefRow title="Headless mode for background slots" desc="Saves ~40% memory and GPU per shrunken instance.">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsWindows() {
  return (
    <>
      <PrefSection title="Foreground window">
        <PrefRow title="Pin to monitor">
          <Select value="2" options={["1 — primary", "2 — right (default)", "3 — left", "Wherever PopBot is"]} />
        </PrefRow>
        <PrefRow title="Default size">
          <Select value="1280x720" options={["1280x720", "1600x900", "1920x1080", "Match game design"]} />
        </PrefRow>
        <PrefRow title="Always-on-top while testing">
          <Toggle on={false} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Background windows"
                   desc="Shrunken windows for non-foreground chats. They're alive but tucked away.">
        <PrefRow title="Layout">
          <Segmented value="grid" options={["grid", "row", "stack", "hidden"]} />
        </PrefRow>
        <PrefRow title="Size">
          <Select value="240x135" options={["180x101", "240x135", "320x180", "480x270"]} />
        </PrefRow>
        <PrefRow title="Click to bring forward" desc="Otherwise, only the column 'Bring forward' button does.">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsLogs() {
  return (
    <>
      <PrefSection title="Capture">
        <PrefRow title="Unity log levels">
          <div className="pref-checkrow">
            <label><input type="checkbox" defaultChecked /> info</label>
            <label><input type="checkbox" defaultChecked /> warn</label>
            <label><input type="checkbox" defaultChecked /> error</label>
            <label><input type="checkbox" defaultChecked /> trace</label>
          </div>
        </PrefRow>
        <PrefRow title="Server log levels">
          <div className="pref-checkrow">
            <label><input type="checkbox" defaultChecked /> info</label>
            <label><input type="checkbox" defaultChecked /> warn</label>
            <label><input type="checkbox" defaultChecked /> error</label>
            <label><input type="checkbox" /> debug</label>
          </div>
        </PrefRow>
        <PrefRow title="Buffer size per source">
          <Select value="20mb" options={["5 MB", "20 MB", "100 MB", "1 GB"]} />
        </PrefRow>
        <PrefRow title="Persist logs across restarts">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Display">
        <PrefRow title="Sync-scroll Unity ↔ Server">
          <Toggle on={true} />
        </PrefRow>
        <PrefRow title="Wrap long lines">
          <Toggle on={false} />
        </PrefRow>
        <PrefRow title="Highlight stack traces in red">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Terminal">
        <PrefRow title="Default shell">
          <Select value="zsh" options={["zsh", "bash", "fish", "pwsh"]} />
        </PrefRow>
        <PrefRow title="Working directory">
          <Select value="repo" options={[
            { value: "repo",     label: "Repo root" },
            { value: "home",     label: "Home" },
            { value: "lastChat", label: "Last active chat's branch checkout" },
          ]} />
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsNotify() {
  return (
    <>
      <PrefSection title="When an agent…">
        <PrefRow title="…asks for permission">
          <Segmented value="banner_sound" options={[
            { value: "off",          label: "Off" },
            { value: "banner",       label: "Banner" },
            { value: "banner_sound", label: "Banner + sound" },
          ]} />
        </PrefRow>
        <PrefRow title="…finishes a turn">
          <Segmented value="banner" options={["off", "banner", "banner_sound"]} />
        </PrefRow>
        <PrefRow title="…hits an error">
          <Segmented value="banner_sound" options={["off", "banner", "banner_sound"]} />
        </PrefRow>
        <PrefRow title="…approaches token budget (90%)">
          <Segmented value="banner" options={["off", "banner", "banner_sound"]} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Mentions">
        <PrefRow title="Slack `@you`">
          <Segmented value="banner_sound" options={["off", "banner", "banner_sound"]} />
        </PrefRow>
        <PrefRow title="PR review requested">
          <Segmented value="banner" options={["off", "banner", "banner_sound"]} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Sound">
        <PrefRow title="Sound theme">
          <Select value="soft" options={["off", "soft", "classic", "8-bit"]} />
        </PrefRow>
        <PrefRow title="Volume">
          <input type="range" min="0" max="100" defaultValue="40" className="pref-range" />
        </PrefRow>
        <PrefRow title="Quiet hours" desc="No sound between these hours.">
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input className="pref-input small" defaultValue="22:00" />
            <span style={{ color: "var(--fg-3)" }}>to</span>
            <input className="pref-input small" defaultValue="08:00" />
          </div>
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsShortcuts() {
  const ROWS = [
    ["Spawn from anywhere (fuzzy)",       ["⌘", "K"]],
    ["Open Preferences",                   ["⌘", ","]],
    ["Close active chat",                  ["⌘", "W"]],
    ["Send message",                       ["⌘", "↵"]],
    ["Stop running agent",                 ["⌘", "."]],
    ["Focus chat 1–9",                     ["⌘", "1–9"]],
    ["Toggle Foreground for active chat",  ["⌘", "⇧", "F"]],
    ["Make focused chat Active",           ["⌘", "⇧", "A"]],
    ["Toggle bottom panel",                ["⌘", "J"]],
    ["Toggle left column",                 ["⌘", "B"]],
    ["Switch to Logs / Terminal",          ["⌘", "⇧", "L"]],
    ["New chat from current selection",    ["⌘", "N"]],
    ["Approve permission request",         ["⌘", "↵"]],
    ["Deny permission request",            ["⌘", "⌫"]],
  ];
  return (
    <PrefSection title="Keyboard shortcuts" desc="Click a row to rebind.">
      <div className="pref-shortcuts">
        {ROWS.map(([label, keys]) => (
          <div className="pref-shortcut-row" key={label}>
            <div className="pref-shortcut-label">{label}</div>
            <div className="pref-shortcut-keys">
              {keys.map((k, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="kbd-sep">+</span>}
                  <Kbd>{k}</Kbd>
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PrefSection>
  );
}

function PrefsIntegrations() {
  const items = [
    { id: "linear", name: "Linear",  desc: "Tickets feed in Panel A.",                  state: "connected", account: "acme" },
    { id: "github", name: "GitHub",  desc: "PRs, reviews, branches.",                   state: "connected", account: "you@example.com" },
    { id: "slack",  name: "Slack",   desc: "Mentions and channel pings.",                state: "connected", account: "acme.slack.com" },
    { id: "jira",   name: "Jira",    desc: "Alternate ticket source.",                  state: "off" },
    { id: "sentry", name: "Sentry",  desc: "Stream errors as new chats automatically.", state: "needs_auth" },
    { id: "figma",  name: "Figma",   desc: "Drop frames into chats as references.",     state: "off" },
    { id: "discord",name: "Discord", desc: "Mentions in server channels.",              state: "off" },
  ];
  return (
    <PrefSection title="Integrations">
      <div className="pref-integ-grid">
        {items.map(i => (
          <div className={`pref-integ ${i.state}`} key={i.id}>
            <div className="pref-integ-head">
              <span className="pref-integ-name">{i.name}</span>
              {i.state === "connected" && <span className="pref-integ-state ok"><i className="fa-solid fa-circle-check" /> Connected</span>}
              {i.state === "needs_auth" && <span className="pref-integ-state warn"><i className="fa-solid fa-circle-question" /> Auth expired</span>}
              {i.state === "off" && <span className="pref-integ-state muted"><i className="fa-regular fa-circle" /> Not connected</span>}
            </div>
            <div className="pref-integ-desc">{i.desc}</div>
            <div className="pref-integ-foot">
              {i.account && <span className="pref-integ-account">{i.account}</span>}
              <span style={{ flex: 1 }} />
              {i.state === "connected" && <button className="btn ghost sm">Disconnect</button>}
              {i.state === "needs_auth" && <button className="btn primary sm">Reconnect</button>}
              {i.state === "off" && <button className="btn ghost sm">Connect</button>}
            </div>
          </div>
        ))}
      </div>
    </PrefSection>
  );
}

function PrefsGit() {
  return (
    <>
      <PrefSection title="Branches">
        <PrefRow title="Default branch prefix"
                 desc="Used when spawning a new chat from a ticket.">
          <input className="pref-input" defaultValue="eng/" />
        </PrefRow>
        <PrefRow title="Spawn from a clean checkout" desc="Re-clone if the working copy is dirty.">
          <Toggle on={false} />
        </PrefRow>
        <PrefRow title="Auto-rebase against origin/main" desc="Rebases at the start of every agent turn.">
          <Toggle on={true} />
        </PrefRow>
        <PrefRow title="On rebase conflict">
          <Segmented value="pause" options={[
            { value: "pause",  label: "Pause and ask" },
            { value: "abort",  label: "Abort + notify" },
            { value: "branch", label: "Branch from old base" },
          ]} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Commits & pushes">
        <PrefRow title="Commit author">
          <Select value="agent" options={[
            { value: "agent", label: "Agent (Co-authored-by: you)" },
            { value: "you",   label: "You" },
          ]} />
        </PrefRow>
        <PrefRow title="Sign commits (GPG/SSH)">
          <Toggle on={true} />
        </PrefRow>
        <PrefRow title="Force-push policy">
          <Segmented value="ask" options={["never", "ask", "auto"]} />
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsPrivacy() {
  return (
    <>
      <PrefSection title="Telemetry"
                   desc="PopBot can phone home with anonymous usage data. Code, prompts, and outputs are never included.">
        <PrefRow title="Send crash reports">
          <Toggle on={true} />
        </PrefRow>
        <PrefRow title="Send anonymous usage stats">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Data retention">
        <PrefRow title="Local chat history">
          <Select value="90d" options={["7 days", "30 days", "90 days", "Forever"]} />
        </PrefRow>
        <PrefRow title="Clear logs older than">
          <Select value="14d" options={["1 day", "7 days", "14 days", "30 days", "Never"]} />
        </PrefRow>
        <PrefRow title="Wipe all local data" desc="Cannot be undone.">
          <button className="btn danger sm">Erase…</button>
        </PrefRow>
      </PrefSection>

      <PrefSection title="API endpoints">
        <PrefRow title="Anthropic">
          <input className="pref-input" defaultValue="https://api.anthropic.com" />
        </PrefRow>
        <PrefRow title="OpenAI">
          <input className="pref-input" defaultValue="https://api.openai.com/v1" />
        </PrefRow>
      </PrefSection>
    </>
  );
}

function PrefsAdvanced() {
  return (
    <>
      <PrefSection title="Experimental"
                   desc="Off by default. May change or break between versions.">
        <PrefRow title="Multi-agent debate" desc="Spawn two agents on the same prompt and have them critique each other.">
          <Toggle on={false} />
        </PrefRow>
        <PrefRow title="Speculative tool calls" desc="Pre-fetch likely-needed files while the model is still drafting.">
          <Toggle on={false} />
        </PrefRow>
        <PrefRow title="Inline `npm` /  `pnpm` cache reuse across slots">
          <Toggle on={true} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Diagnostics">
        <PrefRow title="Open developer tools">
          <button className="btn ghost sm">Open</button>
        </PrefRow>
        <PrefRow title="Reveal config folder">
          <button className="btn ghost sm">Show in Finder</button>
        </PrefRow>
        <PrefRow title="Reset all preferences">
          <button className="btn danger sm">Reset…</button>
        </PrefRow>
      </PrefSection>
    </>
  );
}

Object.assign(window, { PreferencesWindow });

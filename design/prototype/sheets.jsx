/* global React */
const { useState: useStateS } = React;

function Field({ label, children, stack }) {
  return (
    <div className={`field ${stack ? "stack" : ""}`}>
      <label>{label}</label>
      <div>{children}</div>
    </div>
  );
}

function Seg({ value, onChange, options }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)} disabled={o.disabled}>
          {o.label}{o.disabled ? " (soon)" : ""}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange }) {
  return <button className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

function ScreenLayout({ slot, position, onChange }) {
  // Tiny visual mock: 2 displays, draggable rect for active slot
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <div style={{ position: "relative", width: 110, height: 62, background: "var(--bg-2)", border: "1px solid var(--line-2)", borderRadius: 4 }}>
        <div style={{ position: "absolute", top: 4, left: 4, width: 50, height: 30, background: "#0a0c11", border: "1px solid var(--line-3)", borderRadius: 2, fontSize: 8, color: "var(--fg-3)", display: "flex", alignItems: "center", justifyContent: "center" }}>screen 1</div>
        <div style={{ position: "absolute", top: 4, right: 4, width: 50, height: 40, background: "#0a0c11", border: "1px solid var(--line-3)", borderRadius: 2, fontSize: 8, color: "var(--fg-3)", display: "flex", alignItems: "center", justifyContent: "center" }}>screen 2</div>
        <div style={{ position: "absolute", top: 12, right: 10, width: 26, height: 18, background: "var(--acc-bg)", border: "1px solid var(--acc)", borderRadius: 2, fontSize: 7, color: "var(--acc-hi)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab" }}>slot {slot}</div>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.5 }}>Drag the slot tile<br/>to set its placement.</div>
    </div>
  );
}

function ChatSettingsSheet({ chat, onClose }) {
  const [mode, setMode] = useStateS("interactive");
  const [server, setServer] = useStateS("local");
  const [windowMode, setWindowMode] = useStateS("screen2");
  const [tokenBudget, setTokenBudget] = useStateS(1000);
  const [timeBudget, setTimeBudget] = useStateS(60);
  const [loopDetect, setLoopDetect] = useStateS(true);
  const [autoShot, setAutoShot] = useStateS(true);
  const [verbose, setVerbose] = useStateS(false);
  const [timeScale, setTimeScale] = useStateS(1);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" data-screen-label="Sheet · Per-chat settings">
        <div className="sheet-head">
          <div style={{ flex: 1 }}>
            <h2>{chat.name}</h2>
            <div className="sub">⎇ {chat.branch}</div>
          </div>
          <button className="iconbtn" onClick={onClose} style={{ width: 26, height: 26 }}>×</button>
        </div>
        <div className="sheet-body">
          <div className="section">
            <h3>Identity</h3>
            <Field label="Chat name"><input className="input" defaultValue={chat.name} /></Field>
            <Field label="Branch"><input className="input mono" defaultValue={chat.branch} /></Field>
            <Field label="Linked">
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="pill muted">{chat.ticket || (chat.pr && `PR #${chat.pr}`) || "none"}</span>
                <button className="btn ghost sm">Change…</button>
              </div>
            </Field>
          </div>

          <div className="section">
            <h3>Mode</h3>
            <Field label="Run mode">
              <Seg value={mode} onChange={setMode} options={[
                { value: "interactive", label: "Interactive" },
                { value: "autonomous", label: "Autonomous" },
              ]} />
            </Field>
            <Field label="Token budget">
              <div className="slider-row">
                <input type="range" min="100" max="2000" step="50" value={tokenBudget} onChange={e => setTokenBudget(+e.target.value)} />
                <span className="val">{tokenBudget}k</span>
              </div>
            </Field>
            <Field label="Time budget">
              <div className="slider-row">
                <input type="range" min="5" max="240" step="5" value={timeBudget} onChange={e => setTimeBudget(+e.target.value)} />
                <span className="val">{timeBudget} min</span>
              </div>
            </Field>
            <Field label="Loop detection">
              <Toggle on={loopDetect} onChange={setLoopDetect} />
            </Field>
          </div>

          <div className="section">
            <h3>Server</h3>
            <Field label="Source">
              <Seg value={server} onChange={setServer} options={[
                { value: "local", label: "Local" },
                { value: "remote", label: "Remote-dev" },
              ]} />
            </Field>
            <Field label="Health">
              <span className="pill done"><span className="glyph">✓</span>running on :5101</span>
            </Field>
          </div>

          <div className="section">
            <h3>Window placement</h3>
            <Field label="Visibility">
              <Seg value={windowMode} onChange={setWindowMode} options={[
                { value: "screen2", label: "Screen 2" },
                { value: "headless", label: "Headless" },
                { value: "visible", label: "Visible" },
              ]} />
            </Field>
            <Field label="Position">
              <ScreenLayout slot="1" />
            </Field>
          </div>

          <div className="section">
            <h3>Game view</h3>
            <Field label="Resolution">
              <select className="input mono">
                <option>1920 × 1080</option>
                <option>1280 × 720</option>
                <option>800 × 600</option>
                <option>Custom…</option>
              </select>
            </Field>
            <Field label="Time scale">
              <div className="slider-row">
                <input type="range" min="0.25" max="5" step="0.25" value={timeScale} onChange={e => setTimeScale(+e.target.value)} />
                <span className="val">{timeScale}×</span>
              </div>
            </Field>
            <Field label="Auto-screenshot"><Toggle on={autoShot} onChange={setAutoShot} /></Field>
            <Field label="Default fixture">
              <select className="input mono">
                <option>combat-ability-loop</option>
                <option>inv-stack-resize</option>
                <option>arena-bootstrap</option>
              </select>
            </Field>
          </div>

          <div className="section">
            <h3>Agent</h3>
            <Field label="Backend">
              <Seg value="claude" onChange={() => {}} options={[
                { value: "claude", label: "Claude" },
                { value: "codex", label: "Codex", disabled: true },
              ]} />
            </Field>
            <Field label="Verbose logs"><Toggle on={verbose} onChange={setVerbose} /></Field>
          </div>
        </div>
        <div className="sheet-foot">
          <button className="btn ghost">Reset to defaults</button>
          <button className="btn primary" onClick={onClose}>Apply</button>
        </div>
      </aside>
    </>
  );
}

// ---------- Modal: drift detection / dial-up / slot reset / branch in use ----------
function Modal({ kind, onClose }) {
  if (!kind) return null;

  let head, body, foot;
  if (kind === "drift") {
    head = (<><h2>Server out of sync with this branch</h2><div className="sub">Drift detected on chat <code>ENG-20512</code></div></>);
    body = (<>
      The dev server you're connecting to is on a different commit than your worktree.<br/><br/>
      <ul>
        <li>Server commit: <code>abc123f · "merge develop into feature/cooldown"</code></li>
        <li>Worktree expects: <code>def456a · "patch CooldownView for flicker"</code></li>
      </ul>
      Tests will likely produce false positives until this is resolved.
    </>);
    foot = (<>
      <button className="btn ghost" onClick={onClose}>Dismiss</button>
      <button className="btn" onClick={onClose}>Sync develop</button>
      <button className="btn primary" onClick={onClose}>Switch to local</button>
    </>);
  } else if (kind === "dialup") {
    head = (<><h2>Dial up Unity capacity?</h2><div className="sub">Agent is blocked: needs a Unity instance</div></>);
    body = (<>
      You're at the maximum of <b>2 / 2</b> active Unity instances. Allow PopBot to launch a third?<br/><br/>
      <ul>
        <li>Will use ≈ <b>3.5 GB</b> additional RAM</li>
        <li>Hard ceiling (auto-approve cap): <b>4 instances</b></li>
        <li>Affected chat: <code>ENG-20447 · library cache crash</code></li>
      </ul>
    </>);
    foot = (<>
      <button className="btn ghost" onClick={onClose}>Deny</button>
      <button className="btn primary" onClick={onClose}>Approve · launch Unity 3</button>
    </>);
  } else if (kind === "reset") {
    head = (<><h2>Reset slot 'eng-20033'?</h2><div className="sub">This is a destructive action.</div></>);
    body = (<>
      <ul>
        <li>Quit Unity if running</li>
        <li>Delete the worktree and Library (~14 GB freed)</li>
        <li>Recreate from master Library</li>
      </ul>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
        <input type="checkbox" /> Stash uncommitted changes first
      </label>
    </>);
    foot = (<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn danger" onClick={onClose}>Reset slot</button>
    </>);
  } else if (kind === "branch") {
    head = (<><h2>Branch <code>develop</code> already in use</h2><div className="sub">It's checked out in slot <code>main</code>.</div></>);
    body = (<>
      <ul>
        <li><b>Use slot 'main'</b> for this chat (recommended)</li>
        <li>Create a temp branch <code>develop-slot-2</code> in this slot</li>
        <li>Cancel</li>
      </ul>
    </>);
    foot = (<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn" onClick={onClose}>Temp branch</button>
      <button className="btn primary" onClick={onClose}>Use slot 'main'</button>
    </>);
  } else if (kind === "evict") {
    head = (<><h2>Evict idle slot?</h2><div className="sub">All slots busy on other branches.</div></>);
    body = (<>
      To start your task on <code>ENG-20512</code>, evict the LRU slot <b>'review-global-chat'</b> (idle for 4h)?
    </>);
    foot = (<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn" onClick={onClose}>Queue instead</button>
      <button className="btn primary" onClick={onClose}>Evict</button>
    </>);
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" data-screen-label={`Modal · ${kind}`}>
        <div className="modal-head">{head}</div>
        <div className="modal-body">{body}</div>
        <div className="modal-foot">{foot}</div>
      </div>
    </>
  );
}

Object.assign(window, { ChatSettingsSheet, Modal });

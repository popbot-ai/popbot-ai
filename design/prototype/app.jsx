/* global React, ReactDOM */
const { useState: useStateA, useEffect: useEffectA, useMemo: useMemoA, useRef: useRefA } = React;

function Titlebar({ onOpenModal }) {
  return (
    <div className="titlebar">
      <div className="lights">
        <span className="light r"></span>
        <span className="light y"></span>
        <span className="light g"></span>
      </div>
      <div className="title">
        <b>POPBOT</b> &nbsp;<span style={{ color: "var(--fg-3)" }}>·</span>&nbsp;
        demo-app <span style={{ color: "var(--fg-3)" }}>/</span> 3 active <span style={{ color: "var(--fg-3)" }}>·</span> 2 / 3 slots
      </div>
      <div className="right">
        <button title="Demo: drift modal" onClick={() => onOpenModal("drift")}>⚠</button>
        <button title="Demo: dial-up modal" onClick={() => onOpenModal("dialup")}>⇪</button>
        <button title="Preferences ⌘,">⚙</button>
      </div>
    </div>
  );
}

function App() {
  const [chats, setChats] = useStateA(INITIAL_CHATS);
  const [openColIds, setOpenColIds] = useStateA(["c1", "c2", "c3"]);
  const [focusedId, setFocusedId] = useStateA("c1");
  const [foregroundId, setForegroundId] = useStateA("c1");
  const [settingsForId, setSettingsForId] = useStateA(null);
  const [modal, setModal] = useStateA(null);
  const [colWidth, setColWidth] = useStateA(280);
  const [bottomHeight, setBottomHeight] = useStateA(240);
  const wsRef = useRefA(null);

  // Resize handle: left column width
  const startResizeH = (e) => {
    e.preventDefault();
    const onMove = (ev) => setColWidth(Math.max(220, Math.min(420, ev.clientX)));
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const startResizeV = (e) => {
    e.preventDefault();
    const onMove = (ev) => {
      const h = window.innerHeight - ev.clientY;
      setBottomHeight(Math.max(120, Math.min(window.innerHeight - 220, h)));
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // assign agent backend to chats for demo purposes (claude default; one codex)
  const chatsWithAgent = chats.map((c, i) => ({ ...c, agent: c.agent || (i === 2 ? "codex" : "claude") }));
  const focusedChat = chatsWithAgent.find(c => c.id === focusedId);
  const settingsChat = chatsWithAgent.find(c => c.id === settingsForId);

  const ensureOpen = (id) => {
    setOpenColIds(prev => prev.includes(id) ? prev : [...prev, id].slice(-3));
    setFocusedId(id);
  };

  const closeCol = (id) => {
    setOpenColIds(prev => prev.filter(x => x !== id));
    if (focusedId === id) {
      const remaining = openColIds.filter(x => x !== id);
      if (remaining.length) setFocusedId(remaining[0]);
    }
  };

  const handleSpawnFromTicket = (t) => {
    const newId = "tnew_" + t.id;
    if (!chats.find(c => c.id === newId)) {
      setChats(prev => [{
        id: newId, name: `${t.id} · ${t.title.slice(0, 28)}…`,
        branch: `eng/${t.id.toLowerCase().replace("eng-", "")}-new`,
        status: "run",
        timestamp: "starting…",
        tokens: { used: 0, budget: 1_000_000 },
        snippet: `Spawned from ticket ${t.id}.`,
        type: "client_test", ticket: t.id,
      }, ...prev]);
    }
    ensureOpen(newId);
  };
  const handleSpawnFromPR = (p) => {
    const newId = "pnew_" + p.num;
    if (!chats.find(c => c.id === newId)) {
      setChats(prev => [{
        id: newId, name: `PR #${p.num} review`,
        branch: `review/${p.num}-` + p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24),
        status: "run", timestamp: "starting…",
        tokens: { used: 0, budget: 1_000_000 },
        snippet: `Reviewing PR #${p.num}.`,
        type: "lite", pr: p.num,
      }, ...prev]);
    }
    ensureOpen(newId);
  };
  const handleSpawnFromSlack = (s) => {
    const newId = "snew_" + (s.who || "slack") + "_" + (s.t || "").replace(/[^a-z0-9]/gi, "");
    if (!chats.find(c => c.id === newId)) {
      setChats(prev => [{
        id: newId, name: `${s.ch} · ${s.who}`,
        branch: `wip/slack-${(s.who || "x").toLowerCase()}`,
        status: "wait", timestamp: "starting…",
        tokens: { used: 0, budget: 1_000_000 },
        snippet: s.text,
        type: "lite",
      }, ...prev]);
    }
    ensureOpen(newId);
  };

  return (
    <div className="app" data-screen-label="PopBot · Main">
      <Titlebar onOpenModal={setModal} />
      <div className="workspace" ref={wsRef}
           style={{ "--col-left": colWidth + "px", "--row-bottom": bottomHeight + "px" }}>
        <div className="left">
          <PanelA onSpawnFromTicket={handleSpawnFromTicket} onSpawnFromPR={handleSpawnFromPR} onSpawnFromSlack={handleSpawnFromSlack} />
          <PanelB chats={chats} inactive={INACTIVE_CHATS} focusedId={focusedId}
                  setFocusedId={(id) => ensureOpen(id)} />
        </div>
        <div className="resize-h" onMouseDown={startResizeH} style={{ position: "absolute", left: colWidth, top: 32, bottom: 0, width: 4, zIndex: 10 }} />

        <div className="center">
          {/* Thumbnail strip */}
          <div className="center-head">
            <div className="thumbstrip">
              {chatsWithAgent.map(c => (
                <MonitorCard key={c.id} chat={c}
                  isFocused={c.id === focusedId}
                  isForeground={c.id === foregroundId}
                  onClick={() => ensureOpen(c.id)}
                  onBringForward={() => setForegroundId(prev => prev === c.id ? null : c.id)}
                />
              ))}
            </div>
            <div className="center-actions">
              <button className="iconbtn" title="Command palette ⌘K">⌘K</button>
              <button className="iconbtn primary" title="New chat ⌘T"
                      onClick={() => {
                        const id = "new_" + Date.now();
                        setOpenColIds(prev => [...prev, id]);
                      }}>+</button>
            </div>
          </div>

          <div className="columns">
            {openColIds.map(id => {
              const chat = chatsWithAgent.find(c => c.id === id);
              if (!chat) return <EmptyColumn key={id} onClose={() => closeCol(id)} />;
              return (
                <ChatColumn key={id} chat={chat}
                            isForeground={foregroundId === id}
                            isActive={focusedId === id}
                            onActivate={() => setFocusedId(id)}
                            onToggleForeground={() => setForegroundId(prev => prev === id ? null : id)}
                            onClose={() => closeCol(id)}
                            onOpenSettings={() => setSettingsForId(id)}
                            onApprovePerm={() => setChats(prev => prev.map(c => c.id === id ? { ...c, status: "run", timestamp: "active now" } : c))}
                            onDenyPerm={() => setChats(prev => prev.map(c => c.id === id ? { ...c, status: "idle", timestamp: "denied" } : c))}
                />
              );
            })}
          </div>
        </div>

        <div className="resize-v" onMouseDown={startResizeV}
             style={{ position: "absolute", left: colWidth + 4, right: 0, bottom: bottomHeight, height: 4, zIndex: 10 }} />

        <PanelD focusedChat={focusedChat} />
      </div>

      {settingsChat && <ChatSettingsSheet chat={settingsChat} onClose={() => setSettingsForId(null)} />}
      {modal && <Modal kind={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

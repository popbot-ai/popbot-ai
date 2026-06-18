/* global React */
const { useState: useStateM, useEffect: useEffectM } = React;

/* MonitorCard — a tiny mock of the chat itself.
 * Priority: agent prose (largest, most lines) > user turns > tool/diff/perm (one-line gutters).
 * Layout: header strip · transcript body · footer strip.
 * No competing borders inside the body — we want it to read as one little chat,
 * not three tiny widgets stacked.
 */
function MonitorCard({ chat, isFocused, isForeground, onClick, onBringForward }) {
  const activity = (window.CHAT_ACTIVITY && window.CHAT_ACTIVITY[chat.id]) || [
    { kind: "say", text: chat.snippet || "(idle)" },
  ];
  const tokenPct = Math.min(100, (chat.tokens.used / chat.tokens.budget) * 100);

  const [, setTick] = useStateM(0);
  useEffectM(() => {
    if (chat.status !== "run") return;
    const id = setInterval(() => setTick(t => t + 1), 1400);
    return () => clearInterval(id);
  }, [chat.status]);

  // Show transcript newest-at-bottom (chat-style), max ~5 entries
  const lines = activity.slice(0, 6).reverse();
  const lastIdx = lines.length - 1;

  const glyph =
    chat.status === "run"  ? <i className="fa-solid fa-circle-play" /> :
    chat.status === "done" ? <i className="fa-solid fa-circle-check" /> :
    chat.status === "wait" ? <i className="fa-solid fa-circle-question" /> :
    chat.status === "err"  ? <i className="fa-solid fa-circle-xmark" /> :
                             <i className="fa-regular fa-circle" />;

  // Short branch label
  const shortBranch = chat.branch
    .replace(/^eng\//, "").replace(/^review\//, "PR/").replace(/^wip\//, "");

  return (
    <div className={`monitor ${chat.status} ${isFocused ? "focused" : ""} ${isForeground ? "is-foreground" : ""}`}
         onClick={onClick}>
      {isForeground && <span className="fg-tag">FG</span>}

      {/* Header strip — id/title + status + tokens */}
      <div className="mon-head">
        <span className={`mon-glyph status-${chat.status}`}>{glyph}</span>
        <span className="mon-id">{chat.id}</span>
        <span className="mon-name" title={chat.name}>{chat.name}</span>
        <span className="mon-tok" title={`${chat.tokens.used.toLocaleString()} / ${chat.tokens.budget.toLocaleString()} tokens`}>
          {fmtTokens(chat.tokens.used)}
        </span>
      </div>

      {/* Sub-strip — branch / agent / time */}
      <div className="mon-sub">
        <span className="mon-branch" title={chat.branch}><i className="fa-solid fa-code-branch" /> {shortBranch}</span>
        <span className="mon-agent">{chat.agent === "codex" ? "codex" : "claude"}</span>
        <span className="mon-time">{chat.timestamp}</span>
      </div>

      {/* Transcript — newest at bottom */}
      <div className="mon-trans">
        {lines.map((a, i) => {
          const isLast = i === lastIdx;
          if (a.kind === "say") {
            return (
              <div key={i} className={`tline say ${isLast && chat.status === "run" ? "live" : ""}`}>
                <span className="tline-text">{a.text}</span>
                {isLast && chat.status === "run" && <span className="tline-cursor" />}
              </div>
            );
          }
          if (a.kind === "user") {
            return (
              <div key={i} className="tline user">
                <span className="tline-tag">you</span>
                <span className="tline-text">{a.text}</span>
              </div>
            );
          }
          if (a.kind === "tool") {
            return (
              <div key={i} className="tline tool">
                <i className="fa-solid fa-wrench tline-icon" />
                <span className="tline-mono"><b>{a.name}</b> <span className="dim">{a.args}</span></span>
              </div>
            );
          }
          if (a.kind === "diff") {
            return (
              <div key={i} className="tline tool">
                <i className="fa-solid fa-pen-to-square tline-icon" />
                <span className="tline-mono">
                  <b>{a.path.split("/").pop()}</b>{" "}
                  <span style={{ color: "var(--st-done)" }}>+{a.add}</span>{" "}
                  <span style={{ color: "var(--st-err)" }}>−{a.rem}</span>
                </span>
              </div>
            );
          }
          if (a.kind === "perm") {
            return (
              <div key={i} className="tline perm">
                <i className="fa-solid fa-circle-question tline-icon" />
                <span className="tline-text">{a.text}</span>
              </div>
            );
          }
          return null;
        })}
      </div>

      {/* Footer strip — token bar + FG button */}
      <div className="mon-foot">
        <div className={`token-bar ${tokenBarClass(chat.tokens.used, chat.tokens.budget)}`}>
          <i style={{ width: tokenPct + "%" }} />
        </div>
        <button
          className={`mon-fg ${isForeground ? "on" : ""}`}
          onClick={(e) => { e.stopPropagation(); onBringForward(); }}
          title={isForeground ? "Foregrounded · click to background" : "Bring Unity & server forward"}>
          {isForeground
            ? <><i className="fa-solid fa-circle" /> FG</>
            : <><i className="fa-regular fa-circle" /> bring</>}
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { MonitorCard });

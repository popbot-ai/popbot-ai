/* global React */
const { useState: useStateP } = React;

// ---------- Panel A: Tickets / Reviews ----------
function PanelA({ onSpawnFromTicket, onSpawnFromPR, onSpawnFromSlack }) {
  const [tab, setTab] = useStateP("tickets");
  const slackUnread = (window.SLACK || []).filter(s => s.unread).length;
  const slackMentions = (window.SLACK || []).filter(s => s.mention && s.unread).length;
  return (
    <div className="panel-a" data-screen-label="Panel A · Work Queues">
      <div className="panel-head">
        <div className="panel-tabs">
          <button className="panel-tab" aria-selected={tab === "tickets"} onClick={() => setTab("tickets")}>
            Tickets <span className="count">{TICKETS.length}</span>
          </button>
          <button className="panel-tab" aria-selected={tab === "reviews"} onClick={() => setTab("reviews")}>
            Reviews <span className="count">{PRS.length}</span>
          </button>
          <button className="panel-tab" aria-selected={tab === "slack"} onClick={() => setTab("slack")}>
            Slack {slackMentions > 0
              ? <span className="count mention">@{slackMentions}</span>
              : <span className="count">{slackUnread}</span>}
          </button>
        </div>
        <div className="panel-actions">
          <button className="iconbtn" title="Refresh"><i className="fa-solid fa-arrows-rotate" /></button>
          <button className="iconbtn" title="Filter"><i className="fa-solid fa-filter" /></button>
        </div>
      </div>
      <div className="panel-body">
        {tab === "tickets" && (
          TICKETS.map(t => (
            <div key={t.id} className="row" onClick={() => onSpawnFromTicket(t)}>
              <span className={`priority-dot ${t.priority}`} title={`priority: ${t.priority}`} />
              <span className="id">{t.id}</span>
              <span className="title">{t.title}</span>
              <span className="meta">
                <span className={`pill ${t.status === "In Progress" ? "run" : t.status === "Triage" ? "wait" : "muted"}`}>
                  {t.status === "In Progress" && <span className="glyph">▶</span>}
                  {t.status === "Triage"      && <span className="glyph">?</span>}
                  {t.status}
                </span>
                <button className="iconbtn ext-icon" title="Open in Linear" onClick={(e) => e.stopPropagation()}>↗</button>
              </span>
            </div>
          ))
        )}
        {tab === "reviews" && (
          PRS.map(p => (
            <div key={p.num} className="row" onClick={() => onSpawnFromPR(p)}>
              <span className="avatar" style={{ background: avatarColor(p.author) }}>{p.author}</span>
              <span className="id">#{p.num}</span>
              <span className="title">{p.title}</span>
              <span className="meta">
                {p.state === "wait_you" && <span className="pill wait"><span className="glyph">?</span>You</span>}
                {p.state === "rabbit"   && <span className="pill done"><span className="glyph">✓</span>Rabbit</span>}
                {p.state === "checks"   && <span className="pill err"><span className="glyph">✗</span>Checks</span>}
                {p.state === "noreview" && <span className="pill muted">No reviewer</span>}
                {p.comments > 0 && <span className="pill muted">💬 {p.comments}</span>}
                <button className="iconbtn ext-icon" title="Open on GitHub" onClick={(e) => e.stopPropagation()}>↗</button>
              </span>
            </div>
          ))
        )}
        {tab === "slack" && (
          (window.SLACK || []).map((s, i) => (
            <div key={i} className={`slack-row ${s.unread ? "unread" : ""} ${s.mention ? "mention" : ""}`}
                 onClick={() => onSpawnFromSlack && onSpawnFromSlack(s)}>
              <span className="slack-rail" />
              <span className="slack-ch">{s.ch}</span>
              <span className="slack-who" style={{ background: avatarColor((s.who || "").slice(0,2)) }}>
                {(s.who || "").slice(0,2)}
              </span>
              <div className="slack-body">
                <div className="slack-meta">
                  <span className="slack-name">{s.who}</span>
                  {s.bot && <span className="slack-bot">BOT</span>}
                  {s.mention && <span className="slack-mention">@you</span>}
                  <span className="slack-t">{s.t}</span>
                </div>
                <div className="slack-text">{s.text}</div>
                {s.thread > 0 && (
                  <div className="slack-thread"><i className="fa-solid fa-comment" /> {s.thread} {s.thread === 1 ? "reply" : "replies"}</div>
                )}
              </div>
              <button className="iconbtn ext-icon" title="Open in Slack" onClick={(e) => e.stopPropagation()}>↗</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------- Panel B: Chat list ----------
function ChatRow({ chat, focused, onClick, inactive }) {
  const tokenPct = chat.tokens ? Math.min(100, (chat.tokens.used / chat.tokens.budget) * 100) : 0;
  return (
    <div className={`chat-row ${focused ? "focused" : ""} ${inactive ? "inactive" : ""}`} onClick={onClick}>
      <span className={`status-glyph status-${chat.status}`} style={{ color: `var(--st-${chat.status})` }}>
        {chat.status === "run" ? "▶" : chat.status === "done" ? "✓" : chat.status === "wait" ? "?" : chat.status === "err" ? "✗" : "○"}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="name">{chat.name}</div>
        <div className="meta-line">
          <span className="branch" title={chat.branch}>⎇ {chat.branch}</span>
          <span style={{ flex: 1 }} />
          <span className="timestamp">{chat.timestamp}</span>
        </div>
        {!inactive && chat.tokens && (
          <div className={`token-bar ${tokenBarClass(chat.tokens.used, chat.tokens.budget)}`}>
            <i style={{ width: tokenPct + "%" }} />
          </div>
        )}
      </div>
    </div>
  );
}

function PanelB({ chats, inactive, focusedId, setFocusedId }) {
  const [openActive, setOpenActive] = useStateP(true);
  const [openInactive, setOpenInactive] = useStateP(true);
  return (
    <div className="panel-b" data-screen-label="Panel B · Chat List">
      <div className={`list-section ${openActive ? "" : "collapsed"}`}>
        <div className="list-section-head" onClick={() => setOpenActive(v => !v)}>
          <span className="caret">▼</span>
          Active
          <span className="count">{chats.length}</span>
        </div>
        <div className="list-section-body">
          {chats.map(c => (
            <ChatRow key={c.id} chat={c} focused={c.id === focusedId} onClick={() => setFocusedId(c.id)} />
          ))}
          {chats.length === 0 && (
            <div className="empty">
              <div className="ico">○</div>
              <div>No active chats.</div>
              <button className="btn primary sm">+ New chat</button>
            </div>
          )}
        </div>
      </div>
      {inactive.length > 0 && (
        <div className={`list-section ${openInactive ? "" : "collapsed"}`}>
          <div className="list-section-head" onClick={() => setOpenInactive(v => !v)}>
            <span className="caret">▼</span>
            Inactive
            <span className="count">{inactive.length}</span>
          </div>
          <div className="list-section-body">
            {inactive.map(c => (
              <ChatRow key={c.id} chat={c} inactive />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { PanelA, PanelB });

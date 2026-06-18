import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChatRecord } from '@shared/persistence';

interface SessionEntry {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
}

interface FieldProps {
  label: string;
  children: ReactNode;
  stack?: boolean;
}

function Field({ label, children, stack }: FieldProps): JSX.Element {
  return (
    <div className={`field ${stack ? 'stack' : ''}`}>
      <label>{label}</label>
      <div>{children}</div>
    </div>
  );
}

interface ChatSettingsSheetProps {
  chat: ChatRecord;
  onClose: () => void;
}

function fmtBytes(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtAge(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function ChatSettingsSheet({ chat, onClose }: ChatSettingsSheetProps): JSX.Element {
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void window.popbot.agent.listSessions(chat.id).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setSessions(res.sessions);
        // Default to the pinned session, else most-recent.
        setSelectedId(chat.sessionId ?? res.sessions[0]?.sessionId ?? null);
      } else {
        setLoadError(res.reason === 'no-worktree'
          ? 'No working directory configured for this chat — Linear/git settings need a repo path before sessions can be discovered.'
          : `Couldn't load sessions: ${res.error ?? res.reason}`);
      }
    });
    return () => { cancelled = true; };
  }, [chat.id, chat.sessionId, version]);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      s.sessionId.toLowerCase().includes(q) ||
      (s.firstPrompt ?? '').toLowerCase().includes(q) ||
      (s.gitBranch ?? '').toLowerCase().includes(q) ||
      (s.summary ?? '').toLowerCase().includes(q),
    );
  }, [sessions, search]);

  const selected = filtered.find((s) => s.sessionId === selectedId)
    ?? sessions?.find((s) => s.sessionId === selectedId)
    ?? null;

  const reconnect = async (): Promise<void> => {
    if (!selectedId) return;
    setBusy(true);
    try {
      await window.popbot.agent.setSession(chat.id, selectedId);
      setVersion((v) => v + 1);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Reconnect failed:\n\n${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const restartWithContext = async (): Promise<void> => {
    if (!confirm(
      'Spawn a fresh Claude session and feed it this chat\'s prior transcript so the agent ' +
      'picks up where it left off?\n\nThis uses tokens (the transcript becomes the agent\'s ' +
      'first message). Older middle turns may be omitted to keep the prompt size reasonable.',
    )) return;
    setBusy(true);
    try {
      await window.popbot.agent.restartWithContext(chat.id);
      onClose();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Restart failed:\n\n${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const ticketLink =
    chat.ticket ? chat.ticket :
    chat.pr ? `PR #${chat.pr}` :
    'none';

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" data-screen-label="Sheet · Per-chat settings">
        <div className="sheet-head">
          <div style={{ flex: 1 }}>
            <h2>{chat.name}</h2>
            <div className="sub">⎇ {chat.branch ?? '(no branch)'}</div>
          </div>
          <button className="iconbtn" onClick={onClose} style={{ width: 26, height: 26 }}>×</button>
        </div>
        <div className="sheet-body">
          <div className="section">
            <h3>Identity</h3>
            <Field label="Linked"><span className="pill muted">{ticketLink}</span></Field>
            <Field label="Slot">
              <span className="mono">{chat.slotId == null ? '(none)' : `slot ${chat.slotId}`}</span>
            </Field>
            <Field label="Worktree">
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)', wordBreak: 'break-all' }}>
                {chat.worktreePath ?? '(none)'}
              </span>
            </Field>
            <Field label="Agent">
              <span className="mono">
                {chat.agent === 'codex'
                  ? `${chat.agent} · ${chat.codexModel} · ${chat.codexReasoningEffort}`
                  : `${chat.agent} · ${chat.claudeModel} · ${chat.claudeReasoningEffort}`}
              </span>
            </Field>
            <Field label={chat.agent === 'codex' ? 'Codex thread' : 'Pinned session'}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>
                {(chat.agent === 'codex' ? chat.codexThreadId : chat.sessionId) ?? '(none — fresh on next send)'}
              </span>
            </Field>
          </div>

          <div className="section">
            <h3>Recover context</h3>
            <p className="pref-section-desc" style={{ marginBottom: 12 }}>
              Use when the agent has lost memory of this chat (e.g. the transcript above
              shows real work but the agent thinks it\'s a fresh session). Spawns a new
              agent session and primes it with this chat\'s text history so it can pick
              up where things left off — first 3 turns and the most recent turns are
              kept; very old middle turns may be omitted.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="btn primary"
                onClick={() => void restartWithContext()}
                disabled={busy}
                title="Spawn a fresh agent session primed with this chat's transcript"
              >
                {busy ? 'Restarting…' : 'Restart with context'}
              </button>
            </div>
          </div>

          {chat.agent === 'claude' && (
          <div className="section">
            <h3>Try reconnect</h3>
            <p className="pref-section-desc" style={{ marginBottom: 12 }}>
              Pick a saved Claude session for this chat's worktree. Useful if
              auto-reconnect picked the wrong one and you want to force a
              specific transcript. The picked session will be pinned and the
              agent re-spawned into it.
            </p>
            {loading && <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>Loading sessions…</div>}
            {loadError && <div style={{ color: '#e89696', fontSize: 12 }}>{loadError}</div>}
            {sessions && sessions.length === 0 && (
              <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>
                No sessions on disk for this worktree.
              </div>
            )}
            {sessions && sessions.length > 0 && (
              <>
                <input
                  className="input"
                  placeholder={`Search ${sessions.length} session${sessions.length === 1 ? '' : 's'}…`}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: '100%', marginBottom: 8 }}
                />
                <div className="session-list-bounded">
                  {filtered.length === 0 ? (
                    <div className="session-empty">No sessions match.</div>
                  ) : filtered.map((s) => {
                    const isCurrent = chat.sessionId === s.sessionId;
                    const isSelected = selectedId === s.sessionId;
                    return (
                      <button
                        key={s.sessionId}
                        type="button"
                        className={`session-pick-row ${isSelected ? 'selected' : ''} ${isCurrent ? 'current' : ''}`}
                        onClick={() => setSelectedId(s.sessionId)}
                      >
                        <span className="session-id mono">{s.sessionId.slice(0, 8)}</span>
                        {s.gitBranch && (
                          <span className="session-branch mono" title="git branch">
                            ⎇ {s.gitBranch}
                          </span>
                        )}
                        <span className="session-pick-prompt">
                          {s.firstPrompt?.trim() || s.summary || '(no first prompt)'}
                        </span>
                        <span className="session-meta">{fmtAge(s.lastModified)}</span>
                      </button>
                    );
                  })}
                </div>
                {selected && (
                  <div className="session-preview">
                    <div className="session-preview-head">
                      <span className="session-id mono">{selected.sessionId}</span>
                      <span style={{ flex: 1 }} />
                      <span className="session-meta">{fmtAge(selected.lastModified)}</span>
                      {selected.fileSize != null && (
                        <span className="session-meta mono">{fmtBytes(selected.fileSize)}</span>
                      )}
                    </div>
                    {selected.gitBranch && (
                      <div className="session-meta mono" style={{ marginBottom: 6 }}>
                        ⎇ {selected.gitBranch}
                      </div>
                    )}
                    <div className="session-preview-prompt">
                      {selected.firstPrompt?.trim() || selected.summary || '(no first prompt)'}
                    </div>
                  </div>
                )}
                {selected && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                    <button
                      className="btn primary"
                      disabled={busy || selected.sessionId === chat.sessionId}
                      onClick={() => void reconnect()}
                      title={
                        selected.sessionId === chat.sessionId
                          ? 'Already pinned'
                          : 'Pin the selected session and re-spawn the agent into it'
                      }
                    >
                      {busy ? 'Connecting…' : (selected.sessionId === chat.sessionId ? 'Connected' : 'Connect')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          )}
        </div>
        <div className="sheet-foot">
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </aside>
    </>
  );
}

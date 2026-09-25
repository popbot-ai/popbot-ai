import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChatRecord } from '@shared/persistence';
import { useTranslation } from '../lib/i18n';
import type { Translator } from '@shared/i18n';

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
  /** Fork this chat (App does the work and focuses the fork). */
  onFork?: () => Promise<void> | void;
}

function fmtBytes(t: Translator, n?: number): string {
  if (n == null) return '';
  if (n < 1024) return t('chatSettings.bytesB', { n });
  if (n < 1024 * 1024) return t('chatSettings.bytesKB', { n: (n / 1024).toFixed(1) });
  return t('chatSettings.bytesMB', { n: (n / 1024 / 1024).toFixed(1) });
}

function fmtAge(t: Translator, ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return t('time.secondsAgo', { count: Math.floor(d) });
  if (d < 3600) return t('time.minutesAgo', { count: Math.floor(d / 60) });
  if (d < 86400) return t('time.hoursAgo', { count: Math.floor(d / 3600) });
  return t('time.daysAgo', { count: Math.floor(d / 86400) });
}

export function ChatSettingsSheet({ chat, onClose, onFork }: ChatSettingsSheetProps): JSX.Element {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [threadIdCopied, setThreadIdCopied] = useState(false);
  // Cloud chats: the outcome of the last pull (the transcript gets a row too).
  const [cloudNote, setCloudNote] = useState<{ ok: boolean; text: string } | null>(null);

  const pullCloud = async (): Promise<void> => {
    setBusy(true);
    setCloudNote(null);
    try {
      const res = await window.popbot.cloud.pull(chat.id);
      setCloudNote(res.ok ? { ok: true, text: res.summary } : { ok: false, text: res.error });
    } finally {
      setBusy(false);
    }
  };

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
          ? t('chatSettings.noWorktreeError')
          : t('chatSettings.loadSessionsError', { error: res.error ?? res.reason }));
      }
    });
    return () => { cancelled = true; };
  }, [chat.id, chat.sessionId, version, t]);

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
    if (!confirm(t('chatSettings.restartConfirm'))) return;
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
    t('common.none');
  const activeThreadId = chat.agent === 'codex' ? chat.codexThreadId : chat.sessionId;

  const copyThreadId = async (): Promise<void> => {
    if (!activeThreadId) return;
    await navigator.clipboard.writeText(activeThreadId);
    setThreadIdCopied(true);
    window.setTimeout(() => setThreadIdCopied(false), 1400);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" data-screen-label="Sheet · Per-chat settings">
        <div className="sheet-head">
          <div style={{ flex: 1 }}>
            <h2>{chat.name}</h2>
            <div className="sub">⎇ {chat.branch ?? t('chatSettings.noBranch')}</div>
          </div>
          <button className="iconbtn" onClick={onClose} style={{ width: 26, height: 26 }}>×</button>
        </div>
        <div className="sheet-body">
          <div className="section">
            <h3>{t('chatSettings.identity')}</h3>
            <Field label={t('chatSettings.linked')}>
              {chat.pr && chat.prUrl ? (
                <button
                  type="button"
                  className="pill muted"
                  title={t('chat.pr.chipTitle', { number: chat.pr, label: '' })}
                  onClick={() => window.open(chat.prUrl!, '_blank')}
                >
                  PR #{chat.pr} <i className="fa-solid fa-arrow-up-right-from-square" aria-hidden />
                </button>
              ) : <span className="pill muted">{ticketLink}</span>}
            </Field>
            <Field label={t('chatSettings.slot')}>
              <span className="mono">{chat.slotId == null ? t('chatSettings.slotNone') : t('chatSettings.slotN', { slotId: chat.slotId })}</span>
            </Field>
            <Field label={t('chatSettings.worktree')}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)', wordBreak: 'break-all' }}>
                {chat.worktreePath ?? t('chatSettings.worktreeNone')}
              </span>
            </Field>
            <Field label={t('chatSettings.agent')}>
              <span className="mono">
                {chat.agent === 'codex'
                  ? `${chat.agent} · ${chat.codexModel} · ${chat.codexReasoningEffort}`
                  : `${chat.agent} · ${chat.claudeModel} · ${chat.claudeReasoningEffort}`}
              </span>
            </Field>
            <Field label={chat.agent === 'codex' ? t('chatSettings.codexThread') : t('chatSettings.pinnedSession')}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>
                  {activeThreadId ?? t('chatSettings.sessionNone')}
                </span>
                {activeThreadId && (
                  <button
                    type="button"
                    className="iconbtn"
                    style={{ width: 25, height: 25, flex: '0 0 auto' }}
                    title={t('common.copy')}
                    aria-label={t('common.copy')}
                    onClick={() => void copyThreadId()}
                  >
                    <i className={`fa-solid ${threadIdCopied ? 'fa-check' : 'fa-copy'}`} aria-hidden />
                  </button>
                )}
              </span>
            </Field>
          </div>

          {chat.cloud && (
            <div className="section">
              <h3>{t('chatSettings.cloud')}</h3>
              <p className="pref-section-desc" style={{ marginBottom: 12 }}>
                {t('chatSettings.cloudDesc')}
              </p>
              <Field label={t('chatSettings.cloudSession')}>
                {chat.cloud.sessionId ? (
                  <span className="mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                    {chat.cloud.sessionId}
                    {chat.cloud.ended && (
                      <span style={{ color: 'var(--fg-3)', fontFamily: 'inherit' }}> · {t('chatSettings.cloudEnded')}</span>
                    )}
                  </span>
                ) : (
                  <span style={{ color: 'var(--fg-3)' }}>{t('chatSettings.cloudNone')}</span>
                )}
              </Field>
              {chat.cloud.mountPath && (
                <Field label={t('chatSettings.cloudRepo')}>
                  <span className="mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                    {chat.cloud.mountPath}{chat.cloud.branch ? ` · ${chat.cloud.branch}` : ''}
                  </span>
                </Field>
              )}
              {(chat.cloud.branch ?? chat.branch) && (
                <>
                  <p className="pref-section-desc" style={{ marginTop: 14, marginBottom: 8 }}>
                    {t('chatSettings.cloudPullDesc')}
                  </p>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
                    {cloudNote && (
                      <span style={{ color: cloudNote.ok ? 'var(--fg-3)' : '#e89696', fontSize: 12 }}>{cloudNote.text}</span>
                    )}
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void pullCloud()}
                      title={t('chat.cloud.pull')}
                    >
                      <i className="fa-solid fa-cloud-arrow-down" aria-hidden /> {t('chatSettings.cloudPull')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {chat.host && (
            <div className="section">
              <h3>{t('chatSettings.host')}</h3>
              <p className="pref-section-desc" style={{ marginBottom: 12 }}>
                {t('chatSettings.hostDesc')}
              </p>
              <Field label={t('chatSettings.hostName')}>
                <span className="mono" style={{ fontSize: 11 }}>{chat.host.hostName}</span>
              </Field>
              <Field label={t('chatSettings.hostWorkspace')}>
                <span className="mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                  {chat.host.repoId
                    ? (chat.host.branch
                      ? `${chat.host.repoId} · ${chat.host.branch}`
                      : t('chatSettings.hostRoot', { repo: chat.host.repoId }))
                    : t('chatSettings.hostScratch')}
                </span>
              </Field>
              <Field label={t('chatSettings.hostCwd')}>
                {chat.host.cwd ? (
                  <span className="mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{chat.host.cwd}</span>
                ) : (
                  <span style={{ color: 'var(--fg-3)' }}>{t('chatSettings.hostNoCwd')}</span>
                )}
              </Field>
            </div>
          )}

          {onFork && !chat.cloud && !chat.host && (
            <div className="section">
              <h3>{t('chatSettings.fork')}</h3>
              <p className="pref-section-desc" style={{ marginBottom: 12 }}>
                {t('chatSettings.forkDesc')}
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
                {chat.status === 'run' && (
                  <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('chatSettings.forkRunningHint')}</span>
                )}
                <button
                  className="btn primary"
                  onClick={() => void onFork()}
                  // A fork copies the agent's session as it stands; mid-turn
                  // that is a half-written transcript.
                  disabled={busy || chat.status === 'run'}
                  title={t('chatSettings.forkButton')}
                >
                  <i className="fa-solid fa-code-fork" aria-hidden /> {t('chatSettings.forkButton')}
                </button>
              </div>
            </div>
          )}

          {!chat.cloud && (
          <div className="section">
            <h3>{t('chatSettings.recoverContext')}</h3>
            <p className="pref-section-desc" style={{ marginBottom: 12 }}>
              {t('chatSettings.recoverDesc')}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="btn primary"
                onClick={() => void restartWithContext()}
                disabled={busy}
                title={t('chatSettings.restartTooltip')}
              >
                {busy ? t('chatSettings.restarting') : t('chatSettings.restartWithContext')}
              </button>
            </div>
          </div>
          )}

          {chat.agent === 'claude' && !chat.cloud && (
          <div className="section">
            <h3>{t('chatSettings.tryReconnect')}</h3>
            <p className="pref-section-desc" style={{ marginBottom: 12 }}>
              {t('chatSettings.reconnectDesc')}
            </p>
            {loading && <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>{t('chatSettings.loadingSessions')}</div>}
            {loadError && <div style={{ color: '#e89696', fontSize: 12 }}>{loadError}</div>}
            {sessions && sessions.length === 0 && (
              <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>
                {t('chatSettings.noSessionsOnDisk')}
              </div>
            )}
            {sessions && sessions.length > 0 && (
              <>
                <input
                  className="input"
                  placeholder={sessions.length === 1
                    ? t('chatSettings.searchSessions', { count: sessions.length })
                    : t('chatSettings.searchSessionsPlural', { count: sessions.length })}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: '100%', marginBottom: 8 }}
                />
                <div className="session-list-bounded">
                  {filtered.length === 0 ? (
                    <div className="session-empty">{t('chatSettings.noSessionsMatch')}</div>
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
                          <span className="session-branch mono" title={t('chatSettings.gitBranchTooltip')}>
                            ⎇ {s.gitBranch}
                          </span>
                        )}
                        <span className="session-pick-prompt">
                          {s.firstPrompt?.trim() || s.summary || t('chatSettings.noFirstPrompt')}
                        </span>
                        <span className="session-meta">{fmtAge(t, s.lastModified)}</span>
                      </button>
                    );
                  })}
                </div>
                {selected && (
                  <div className="session-preview">
                    <div className="session-preview-head">
                      <span className="session-id mono">{selected.sessionId}</span>
                      <span style={{ flex: 1 }} />
                      <span className="session-meta">{fmtAge(t, selected.lastModified)}</span>
                      {selected.fileSize != null && (
                        <span className="session-meta mono">{fmtBytes(t, selected.fileSize)}</span>
                      )}
                    </div>
                    {selected.gitBranch && (
                      <div className="session-meta mono" style={{ marginBottom: 6 }}>
                        ⎇ {selected.gitBranch}
                      </div>
                    )}
                    <div className="session-preview-prompt">
                      {selected.firstPrompt?.trim() || selected.summary || t('chatSettings.noFirstPrompt')}
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
                          ? t('chatSettings.alreadyPinned')
                          : t('chatSettings.reconnectRowTooltip')
                      }
                    >
                      {busy ? t('chatSettings.connecting') : (selected.sessionId === chat.sessionId ? t('chatSettings.connected') : t('chatSettings.connect'))}
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
          <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        </div>
      </aside>
    </>
  );
}

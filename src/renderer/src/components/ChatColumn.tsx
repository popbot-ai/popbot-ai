import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import {
  CLAUDE_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  RAW_CHAT_REPO_ID,
  type ChatRecord,
  type ClaudeModelId,
  type ClaudeReasoningEffort,
  type CodexModelId,
  type CodexReasoningEffort,
  closestReasoningEffort,
} from '@shared/persistence';
import type { PickedAttachment } from '@shared/ipc';
import type { GitPrInfo } from '@shared/git';
import { fmtTokens } from '../fixtures/data';
import { LiveChatBody } from './LiveChatBody';
import { useAppsRunning } from '../lib/useAppsRunning';
import { LinearStateIcon, isPausedState, PAUSED_COLOR } from '../lib/linearIcons';
import { colAccentStyle } from '../lib/repoColor';
import { ConfirmDialog } from './ConfirmDialog';

/** Build an `rgba(r,g,b,alpha)` from a `#rrggbb` color. Used by chips
 *  to derive their background + border tints from the state's primary
 *  color in one place rather than hand-curating each variant. */
function tintFromHex(hex: string, alpha: number): string {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex);
  if (!m) return `rgba(150,150,150,${alpha})`;
  const num = Number.parseInt(m[1], 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Linear ticket status chip. Color/icon driven by the workflow state
 *  passed in from App's shared `useLinearIssues` poll. Click anywhere
 *  on the chip opens the ticket page; the trailing ↗ icon makes that
 *  affordance obvious without taking a separate click target. */
function TicketChip({ identifier, state, url }: {
  identifier: string;
  state: { name: string; type: string; color?: string };
  url: string;
}): JSX.Element {
  // Paused/blocked: force the brown PAUSED_COLOR so they stay visually
  // distinct from In Progress even when Linear's workflow palette
  // assigns them similar hues. Other states keep their workflow color.
  const stateColor = isPausedState(state) ? PAUSED_COLOR : (state.color || '#94a3b8');
  return (
    <button
      type="button"
      className="chat-status-chip"
      style={{
        color: stateColor,
        background: tintFromHex(stateColor, 0.12),
        borderColor: tintFromHex(stateColor, 0.45),
      }}
      title={`${identifier} · ${state.name} — open in Linear`}
      onClick={() => window.open(url, '_blank')}
    >
      <LinearStateIcon state={state} size={11} />
      <span>{state.name}</span>
      <i className="fa-solid fa-arrow-up-right-from-square chat-status-chip-ext" aria-hidden />
    </button>
  );
}

/** GitHub PR status chip. Same shape as TicketChip but with PR-state
 *  palette and a fa-code-* icon. */
function PrChip({ pr }: { pr: GitPrInfo }): JSX.Element {
  // GitHub PR state palette:
  //   OPEN   → green (active work)
  //   MERGED → purple (committed; what GitHub itself uses)
  //   CLOSED → brown (rejected or abandoned, distinct from merged)
  // Drafts get a muted treatment regardless of state.
  const palette = pr.isDraft
    ? { color: 'var(--fg-2)', bg: 'rgba(150,150,150,0.10)', border: 'rgba(150,150,150,0.35)', icon: 'fa-code-pull-request' }
    : pr.state === 'MERGED'
      ? { color: '#b88aff', bg: 'rgba(184,138,255,0.12)', border: 'rgba(184,138,255,0.45)', icon: 'fa-code-merge' }
      : pr.state === 'CLOSED'
        ? { color: '#c08660', bg: 'rgba(192,134,96,0.12)', border: 'rgba(192,134,96,0.45)', icon: 'fa-circle-xmark' }
        : { color: 'var(--st-done)', bg: 'var(--st-done-bg)', border: 'rgba(63,178,127,0.45)', icon: 'fa-code-pull-request' };
  const label = pr.isDraft ? 'Draft' : pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : 'Open';
  return (
    <button
      type="button"
      className="chat-status-chip"
      style={{ color: palette.color, background: palette.bg, borderColor: palette.border }}
      title={`PR #${pr.number} · ${label} — open on GitHub`}
      onClick={() => window.open(pr.url, '_blank')}
    >
      <i className={`fa-solid ${palette.icon}`} aria-hidden />
      <span>PR #{pr.number} · {label}</span>
      <i className="fa-solid fa-arrow-up-right-from-square chat-status-chip-ext" aria-hidden />
    </button>
  );
}

const MODEL_OPTIONS = [
  {
    value: `claude:${DEFAULT_CLAUDE_MODEL}`,
    label: 'Claude Opus 4.8',
    agent: 'claude' as const,
    claudeModel: DEFAULT_CLAUDE_MODEL,
    reasoningEfforts: CLAUDE_REASONING_EFFORTS,
  },
  {
    value: 'claude:claude-fable-5',
    label: 'Claude Fable 5',
    agent: 'claude' as const,
    claudeModel: 'claude-fable-5' as const,
    reasoningEfforts: CLAUDE_REASONING_EFFORTS,
  },
  {
    value: `codex:${DEFAULT_CODEX_MODEL}`,
    label: 'GPT-5.5',
    agent: 'codex' as const,
    codexModel: DEFAULT_CODEX_MODEL,
    reasoningEfforts: CODEX_REASONING_EFFORTS,
  },
] as const;

const REASONING_LABELS: Record<ClaudeReasoningEffort | CodexReasoningEffort, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

interface PendingAgentSwitch {
  agent: 'claude' | 'codex';
  claudeModel?: ClaudeModelId;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexModel?: CodexModelId;
  codexReasoningEffort?: CodexReasoningEffort;
}

interface ChatColumnProps {
  chat: ChatRecord;
  isForeground: boolean;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onChatUpdated?: () => void;
  /** Open Preferences (optionally jumping to a specific section).
   *  Used by SlotAppButtons to route Unity-not-configured to the
   *  Unity prefs page. */
  onOpenPrefs?: (section?: string) => void;
  /** Live Linear workflow state + url for this chat's ticket, lifted
   *  from App's shared `useLinearIssues` poll. Null when the chat has
   *  no ticket or the issue isn't currently in the user's queue.
   *  Updates on every Linear refresh — that's how the chip on the
   *  runtime strip stays in sync with the Tickets tab. */
  ticket: {
    state: { name: string; type: string; color?: string };
    url: string;
  } | null;
  /** Live PR info for this chat's PR, lifted from App's shared
   *  `usePrStatusByChat` poll. Null until the first poll completes
   *  for chats with a PR; null forever for chats without one. */
  pr: GitPrInfo | null;
}

export function ChatColumn({
  chat,
  isForeground,
  isActive,
  onActivate,
  onClose,
  onOpenSettings,
  onChatUpdated,
  onOpenPrefs,
  ticket,
  pr,
}: ChatColumnProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [configuringAgent, setConfiguringAgent] = useState(false);
  const [pendingAgentSwitch, setPendingAgentSwitch] = useState<PendingAgentSwitch | null>(null);
  const [inputHeight, setInputHeight] = useState<number>(36);
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  // Latest `sending` value held in a ref so the memoized send handlers
  // below can early-out without changing identity each render. Without
  // this every keystroke (which flips a draft state, re-rendering
  // ChatColumn) would hand LiveChatBody fresh callback functions and
  // remount the entire transcript above the textarea.
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  // Auto-scroll-to-bottom is now handled by react-virtuoso inside
  // LiveChatBody (followOutput="smooth"), which respects user scroll
  // position correctly across variable-height items.

  const agent = chat.agent || 'claude';
  const selectedModelValue = agent === 'codex'
    ? `codex:${chat.codexModel || DEFAULT_CODEX_MODEL}`
    : `claude:${chat.claudeModel || DEFAULT_CLAUDE_MODEL}`;
  const selectedModel = MODEL_OPTIONS.find((m) => m.value === selectedModelValue) ?? MODEL_OPTIONS[0];
  const reasoningEfforts = selectedModel.reasoningEfforts;
  const selectedReasoningEffort = agent === 'codex'
    ? closestReasoningEffort(
      chat.codexReasoningEffort,
      CODEX_REASONING_EFFORTS,
      DEFAULT_CODEX_REASONING_EFFORT,
    )
    : closestReasoningEffort(
      chat.claudeReasoningEffort,
      CLAUDE_REASONING_EFFORTS,
      DEFAULT_CLAUDE_REASONING_EFFORT,
    );
  const statusIcon =
    chat.status === 'run'  ? 'fa-circle-play' :
    chat.status === 'done' ? 'fa-circle-check' :
    chat.status === 'wait' ? 'fa-circle-question' :
    chat.status === 'err'  ? 'fa-circle-xmark' :
                              'fa-circle';

  const handleSettings = (e: MouseEvent) => {
    e.stopPropagation();
    onOpenSettings();
  };

  const sendText = useCallback(async (text: string, atts?: PickedAttachment[]): Promise<void> => {
    const trimmed = text.trim();
    // Allow attachments-only sends (no typed text). Reject only the
    // empty case where the user has neither typed anything nor
    // attached anything — that's a no-op submit.
    if ((!trimmed && (!atts || atts.length === 0)) || sendingRef.current) return;
    setSending(true);
    try {
      await window.popbot.agent.send({ chatId: chat.id, text: trimmed, attachments: atts });
    } catch (err) {
      console.error('agent.send failed', err);
    } finally {
      setSending(false);
    }
  }, [chat.id]);

  const onQuickReply = useCallback((text: string) => {
    void sendText(text);
  }, [sendText]);

  const send = async (): Promise<void> => {
    // Pass attachments straight through — main reads images and emits
    // proper Anthropic image content blocks (no more inline path
    // references the agent has to Read separately). Non-image files
    // still get their path injected as a text block on the main side.
    const text = draft;
    const atts = attachments;
    setDraft('');
    setAttachments([]);
    await sendText(text, atts);
  };

  const pickAttachment = async (kind: 'image' | 'any') => {
    try {
      const picked = await window.popbot.files.pickAttachment(kind);
      if (picked && picked.length > 0) setAttachments((prev) => [...prev, ...picked]);
    } catch (err) {
      console.error('files.pickAttachment failed', err);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const stop = async () => {
    try {
      await window.popbot.agent.stop(chat.id);
    } catch (err) {
      console.error('agent.stop failed', err);
    }
  };

  const configureAgent = async (input: {
    agent: 'claude' | 'codex';
    claudeModel?: ClaudeModelId;
    claudeReasoningEffort?: ClaudeReasoningEffort;
    codexModel?: CodexModelId;
    codexReasoningEffort?: CodexReasoningEffort;
  }) => {
    setConfiguringAgent(true);
    try {
      await window.popbot.agent.configure({
        chatId: chat.id,
        ...input,
      });
      onChatUpdated?.();
    } catch (err) {
      console.error('agent.configure failed', err);
    } finally {
      setConfiguringAgent(false);
    }
  };

  const switchAgentAndRestart = async (input: PendingAgentSwitch) => {
    setConfiguringAgent(true);
    try {
      await window.popbot.agent.configure({
        chatId: chat.id,
        ...input,
      });
      await window.popbot.agent.restartWithContext(chat.id);
      onChatUpdated?.();
    } catch (err) {
      console.error('agent switch/restart failed', err);
    } finally {
      setConfiguringAgent(false);
      setPendingAgentSwitch(null);
    }
  };

  const changeModel = (value: string) => {
    const next = MODEL_OPTIONS.find((m) => m.value === value);
    if (!next) return;
    if (next.agent === 'claude') {
      const config = {
        agent: 'claude',
        claudeModel: next.claudeModel,
        claudeReasoningEffort: closestReasoningEffort(
          chat.claudeReasoningEffort,
          CLAUDE_REASONING_EFFORTS,
          DEFAULT_CLAUDE_REASONING_EFFORT,
        ),
      } satisfies PendingAgentSwitch;
      if (chat.agent !== 'claude') {
        setPendingAgentSwitch(config);
      } else {
        void configureAgent(config);
      }
      return;
    }
    const config = {
      agent: 'codex',
      codexModel: next.codexModel,
      codexReasoningEffort: closestReasoningEffort(
        chat.codexReasoningEffort,
        CODEX_REASONING_EFFORTS,
        DEFAULT_CODEX_REASONING_EFFORT,
      ),
    } satisfies PendingAgentSwitch;
    if (chat.agent !== 'codex') {
      setPendingAgentSwitch(config);
    } else {
      void configureAgent(config);
    }
  };

  const changeReasoning = (value: ClaudeReasoningEffort | CodexReasoningEffort) => {
    if (agent === 'codex') {
      void configureAgent({
        agent: 'codex',
        codexModel: chat.codexModel || DEFAULT_CODEX_MODEL,
        codexReasoningEffort: value as CodexReasoningEffort,
      });
      return;
    }
    void configureAgent({
      agent: 'claude',
      claudeModel: chat.claudeModel || DEFAULT_CLAUDE_MODEL,
      claudeReasoningEffort: value as ClaudeReasoningEffort,
    });
  };

  const onTextareaKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;          // Shift+Enter inserts a newline
    e.preventDefault();
    void send();                     // Enter or ⌘/Ctrl+Enter submits
  };

  const startResizeInput = (e: MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = inputHeight;
    const onMove = (ev: globalThis.MouseEvent) => {
      const next = startH + (startY - ev.clientY);
      setInputHeight(Math.max(36, Math.min(window.innerHeight - 200, next)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const textareaStyle: CSSProperties = {
    height: inputHeight,
    maxHeight: 'none',
  };

  // Single decide() handler that takes the full PermissionDecision —
  // the permission card emits one of six values (once / this-chat /
  // everywhere × allow / deny). Backend persists the rule when the
  // scope is permanent.
  const decidePermission = useCallback(async (
    permissionId: string,
    decision: 'allow' | 'allow-chat' | 'allow-everywhere' | 'deny' | 'deny-everywhere',
  ) => {
    try {
      await window.popbot.agent.approve({ chatId: chat.id, permissionId, decision });
    } catch (err) {
      console.error('agent.approve failed', err);
    }
  }, [chat.id]);
  const repoTitle = chat.repoId === RAW_CHAT_REPO_ID ? 'No repo' : `Repo · ${chat.repoId}`;

  return (
    <>
    <div
      className={`col col-status-${chat.status} ${isForeground ? 'foreground' : 'background'} ${isActive ? 'is-active' : ''}`}
      data-screen-label={`Chat · ${chat.name}`}
      onMouseDown={onActivate}
      // Per-column accent → lights up the foreground/active/rail
      // gradients in this chat's repo color via CSS color-mix tints,
      // and ships a perceptual-brightness `--col-accent-fg` so primary
      // buttons + the slot pip stay readable on bright accents. No
      // repoColor falls back to the global apple-blue --acc.
      style={colAccentStyle(chat.repoColor)}
    >
      {isActive && <div className="active-rail" aria-hidden="true" />}
      <div className="col-head">
        <button className="col-close" title="Close chat" onClick={onClose}>
          <i className="fa-solid fa-xmark" />
        </button>
        <span className="col-name" title={chat.name}>
          {/* Repo color blip — same dot used in the chat-list rows
              and thumbnail strip so the three lists are read-equivalent.
              Inherits `--col-accent` from the col element. */}
          <span className="col-name-dot" aria-hidden="true" title={repoTitle} />
          <span className="col-title">{chat.name}</span>
          {/* Open-in-browser is now exposed as part of the runtime-
              strip ticket/PR chips below — having a second copy here
              was redundant noise. */}
        </span>
        <span className="col-meta">
          <span className={`pill ${chat.status}`} title={`status: ${chat.status}`}>
            <i className={`fa-solid ${statusIcon}`} style={{ fontSize: 9 }} />
            {chat.status === 'run' ? 'running' :
             chat.status === 'done' ? 'done' :
             chat.status === 'wait' ? 'needs you' :
             chat.status === 'err' ? 'error' :
             'idle'}
          </span>
          <button
            className="iconbtn"
            style={{ width: 22, height: 22, borderRadius: 4, color: 'var(--fg-2)' }}
            onClick={handleSettings}
            title="Per-chat settings"
          >
            <i className="fa-solid fa-gear" />
          </button>
        </span>
      </div>
      <div className="runtime-strip">
        <SlotAppButtons worktreePath={chat.worktreePath ?? null} onOpenPrefs={onOpenPrefs} />
        {/* Both chips render side-by-side when applicable so the user
            can jump to either Linear or GitHub from the chat header. */}
        {ticket && chat.ticket && (
          <TicketChip identifier={chat.ticket} state={ticket.state} url={ticket.url} />
        )}
        {pr && <PrChip pr={pr} />}
      </div>
      <div className="col-body">
        <div className="col-branch-strip">
          {chat.slotId != null && (
            <span
              className="slot-pip occupied slot-pip-wide"
              title={`Workspace slot ${chat.slotId} · ${chat.repoId}`}
            >
              {/* Compose `${prefix}-${slotId}` from the live repo
                  record (joined into ChatRecord). Reading from the
                  stored `worktreePath` basename was unreliable for
                  chats whose path was set under an earlier-buggy
                  resolver — they'd show `slot-N` even when the repo
                  was later configured with prefix `ops`. */}
              {chat.repoSlotPrefix
                ? `${chat.repoSlotPrefix}-${chat.slotId}`
                : (chat.worktreePath?.split('/').pop() ?? `Slot ${chat.slotId}`)}
            </span>
          )}
          {/* Ephemeral chats have no slot id — they get an outline-style
              pill labelled with the worktree's folder name (the slug
              we picked at create time) so the user can still see at a
              glance which workspace this chat owns. Same repo color as
              the slot pip, but rendered as an outline to make the mode
              difference immediately readable. */}
          {chat.slotId == null && chat.worktreePath && chat.repoMode === 'ephemeral' && (
            <span
              className="slot-pip slot-pip-wide slot-pip-outline"
              style={chat.repoColor ? { color: chat.repoColor, borderColor: chat.repoColor } : undefined}
              title={`Worktree · ${chat.worktreePath}`}
            >
              {chat.worktreePath.split('/').pop()}
            </span>
          )}
          {chat.branch && (
            <span className="col-branch" title={`Branch · ${chat.branch}`}>
              <i className="fa-solid fa-code-branch col-branch-icon" />
              <span className="col-branch-name mono">{chat.branch}</span>
            </span>
          )}
          <span className="col-branch-meta">
            {chat.type === 'lite' ? 'Lite' : 'Client Test'}
            {chat.ticket ? ` · ${chat.ticket}` : ''}
            {chat.pr ? ` · PR #${chat.pr}` : ''}
          </span>
        </div>
        <LiveChatBody
          chatId={chat.id}
          chatStatus={chat.status}
          onQuickReply={onQuickReply}
          onDecidePermission={decidePermission}
        />
      </div>
      <div
        className="col-foot-resize"
        onMouseDown={startResizeInput}
        title="Drag to resize the input"
        role="separator"
        aria-orientation="horizontal"
      />
      <div className="col-foot">
        <div className={`input-wrap ${isActive ? 'active' : ''}`}>
          {attachments.length > 0 && (
            <div className="attachment-chips">
              {attachments.map((a) => (
                <span key={a.id} className="attachment-chip" title={a.path}>
                  <i className={`fa-solid ${a.isImage ? 'fa-image' : 'fa-paperclip'}`} />
                  <span className="attachment-chip-name">{a.name}</span>
                  <button
                    className="attachment-chip-x"
                    onClick={() => removeAttachment(a.id)}
                    title="Remove attachment"
                  >
                    <i className="fa-solid fa-xmark" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            placeholder={
              isActive
                ? chat.status === 'run'
                  ? 'Agent running… type to queue a message  ·  Shift+Enter for newline'
                  : 'Send a message…  ·  Shift+Enter for newline'
                : 'Click to make this the active chat'
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onTextareaKey}
            style={textareaStyle}
          />
          <div className="input-row">
            <button
              className="iconbtn"
              title="Attach image"
              onClick={() => void pickAttachment('image')}
            >
              <i className="fa-solid fa-image" />
            </button>
            <button
              className="iconbtn"
              title="Attach file"
              onClick={() => void pickAttachment('any')}
            >
              <i className="fa-solid fa-paperclip" />
            </button>
            <select
              className={`agent-select ${agent}`}
              title="Model"
              aria-label="Model"
              value={selectedModelValue}
              disabled={configuringAgent || chat.status === 'run'}
              onChange={(e) => changeModel(e.currentTarget.value)}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <select
              className={`reasoning-select ${agent}`}
              title="Effort"
              aria-label="Effort"
              value={selectedReasoningEffort}
              disabled={configuringAgent || chat.status === 'run'}
              onChange={(e) => changeReasoning(
                e.currentTarget.value as ClaudeReasoningEffort | CodexReasoningEffort,
              )}
            >
              {reasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>{REASONING_LABELS[effort]}</option>
              ))}
            </select>
            <span className="spacer" />
            <span className="token-counter">
              <b>{fmtTokens(chat.tokensUsed)}</b> / {fmtTokens(chat.tokensBudget)}
            </span>
            {chat.status === 'run' ? (
              <button className="btn danger sm" title="Stop agent" onClick={stop}>
                <i className="fa-solid fa-stop" /> Stop
              </button>
            ) : (
              <button
                className="btn primary sm"
                onClick={() => void send()}
                disabled={sending || !draft.trim()}
              >
                Send <span className="kbd">↵</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
    {pendingAgentSwitch && (
      <ConfirmDialog
        title="Resume with a different agent?"
        message={
          'The current agent session id will be kept, so you can switch back later. ' +
          'The new agent uses its own session and will be restarted with this chat transcript as context. ' +
          'Some private agent state may be lost.'
        }
        cancelLabel="Cancel"
        confirmLabel="Restart"
        onCancel={() => setPendingAgentSwitch(null)}
        onConfirm={() => void switchAgentAndRestart(pendingAgentSwitch)}
      />
    )}
    </>
  );
}

/** Per-slot launcher row: terminal, editor, git client, unity. Buttons
 *  are gray + disabled when the chat has no worktree (e.g. ad-hoc
 *  Slack chats); colored + clickable otherwise. */
// Git client deliberately omitted for now: GitHub Desktop doesn't
// support worktrees, so launching it would point at the parent repo
// instead of the slot. Re-add once we have a worktree-friendly client.
const APP_BUTTONS: Array<{
  kind: 'terminal' | 'editor' | 'unity';
  icon: string;
  label: string;
  color: string;
}> = [
  { kind: 'terminal', icon: 'fa-solid fa-terminal',         label: 'Terminal',  color: '#7fb676' },
  { kind: 'editor',   icon: 'fa-solid fa-code',             label: 'Editor',    color: '#4f8bff' },
  { kind: 'unity',    icon: 'fa-solid fa-cube',             label: 'Unity',     color: '#d6a13b' },
];

function SlotAppButtons({
  worktreePath,
  onOpenPrefs,
}: {
  worktreePath: string | null;
  onOpenPrefs?: (section?: string) => void;
}): JSX.Element {
  const enabled = !!worktreePath;
  const running = useAppsRunning();
  // Main reports running state by slot basename (e.g. 'slot-3') so
  // we don't have to worry about per-app path conventions in the
  // renderer (Unity's project-subpath setting, etc.).
  const slotName = worktreePath ? worktreePath.split('/').pop() ?? '' : '';
  const open = async (kind: 'terminal' | 'editor' | 'git' | 'unity') => {
    if (!worktreePath) return;
    const res = await window.popbot.apps.open(kind, worktreePath);
    if (!res.ok) {
      // Specific routing: Unity-not-configured opens the prefs page
      // instead of nagging with an alert.
      if (
        kind === 'unity' &&
        'reason' in res &&
        res.reason === 'unity-not-configured' &&
        onOpenPrefs
      ) {
        onOpenPrefs('unity');
        return;
      }
      // eslint-disable-next-line no-alert
      alert(`Couldn't launch ${kind}:\n\n${res.error}`);
    }
  };
  const openAll = () => {
    if (!worktreePath) return;
    APP_BUTTONS.forEach((b) => void open(b.kind));
  };
  return (
    <div
      className="slot-apps"
      onContextMenu={(e) => {
        // Right-click anywhere in the row → "Open all" for now.
        // Future: show a real context menu (close all, etc.).
        e.preventDefault();
        openAll();
      }}
    >
      {APP_BUTTONS.map((b) => {
        const isRunning = !!slotName && running[b.kind].has(slotName);
        return (
          <button
            key={b.kind}
            className={`slot-app-btn ${isRunning ? 'running' : ''}`}
            disabled={!enabled}
            onClick={() => open(b.kind)}
            title={
              isRunning
                ? `${b.label} — running for this slot (click to focus)`
                : enabled
                  ? `${b.label} — ${worktreePath}`
                  : `${b.label} (no slot)`
            }
            style={enabled ? { color: b.color } : undefined}
          >
            <i className={b.icon} />
          </button>
        );
      })}
    </div>
  );
}

interface EmptyColumnProps {
  /** When omitted, no close button renders (used for the always-on starting page). */
  onClose?: () => void;
  onCreateLite: () => void;
  onCreateClientTest: () => void;
}

export function EmptyColumn({ onClose, onCreateLite, onCreateClientTest }: EmptyColumnProps): JSX.Element {
  return (
    <div className="col" data-screen-label="Chat · Empty">
      <div className="col-head">
        {onClose && (
          <button className="col-close" title="Close" onClick={onClose}>×</button>
        )}
        <span className="col-name" style={{ color: 'var(--fg-2)' }}>New chat</span>
      </div>
      <div className="col-empty">
        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-3)', fontSize: 22 }}>＋</div>
        <h3>Start a new chat</h3>
        <p>Click a ticket or PR on the left to seed a chat, or pick a starting point below.</p>
        <div className="options">
          <button className="btn" onClick={onCreateLite}>+ Lite chat</button>
          <button className="btn primary" onClick={onCreateClientTest}>+ Client Test chat</button>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 12, lineHeight: 1.6 }}>
          <span className="kbd">⌘T</span> new chat · <span className="kbd">⌘⇧T</span> from clipboard URL ·{' '}
          <span className="kbd">⌘K</span> palette
        </div>
      </div>
    </div>
  );
}

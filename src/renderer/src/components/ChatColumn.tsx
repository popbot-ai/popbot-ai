import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
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
import type { Readiness } from '../lib/useReadiness';
import { hotkey } from '../lib/hotkeys';
import { LiveChatBody } from './LiveChatBody';
import { useAppsRunning } from '../lib/useAppsRunning';
import { useSettings } from '../lib/useSettings';
import { LinearStateIcon, isPausedState, PAUSED_COLOR } from '../lib/linearIcons';
import { colAccentStyle } from '../lib/repoColor';
import { ConfirmDialog } from './ConfirmDialog';
import { useTranslation } from '../lib/i18n';
import type { MessageKey, Translator } from '@shared/i18n';
import { engineEnabled, engineMeta, type GameEngineId, type GameEnginesSettings } from '@shared/gameEngine';
import unityEngineIcon from '../assets/engines/unity-white.png';
import unrealEngineIcon from '../assets/engines/unreal-white.png';

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
function TicketChip({ identifier, state, url, t }: {
  identifier: string;
  state: { name: string; type: string; color?: string };
  url: string;
  t: Translator;
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
      title={t('chat.ticket.chipTitle', { identifier, state: state.name })}
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
function PrChip({ pr, t }: { pr: GitPrInfo; t: Translator }): JSX.Element {
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
  const labelKey: MessageKey = pr.isDraft
    ? 'chat.pr.stateDraft'
    : pr.state === 'MERGED'
      ? 'chat.pr.stateMerged'
      : pr.state === 'CLOSED'
        ? 'chat.pr.stateClosed'
        : 'chat.pr.stateOpen';
  const label = t(labelKey);
  return (
    <button
      type="button"
      className="chat-status-chip"
      style={{ color: palette.color, background: palette.bg, borderColor: palette.border }}
      title={t('chat.pr.chipTitle', { number: pr.number, label })}
      onClick={() => window.open(pr.url, '_blank')}
    >
      <i className={`fa-solid ${palette.icon}`} aria-hidden />
      <span>{t('chat.pr.chipLabel', { number: pr.number, label })}</span>
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

const REASONING_LABEL_KEYS: Record<ClaudeReasoningEffort | CodexReasoningEffort, MessageKey> = {
  none: 'chat.reasoning.none',
  low: 'chat.reasoning.low',
  medium: 'chat.reasoning.medium',
  high: 'chat.reasoning.high',
  xhigh: 'chat.reasoning.xhigh',
  max: 'chat.reasoning.max',
};

const STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  run: 'chat.status.running',
  done: 'chat.status.done',
  wait: 'chat.status.needsYou',
  err: 'chat.status.error',
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
  const { t } = useTranslation();
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

  // Tiny data-URL previews for image attachments, keyed by attachment id —
  // shown in the composer chips before submit (attach + paste alike).
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const fetchThumbs = useCallback((atts: PickedAttachment[]) => {
    for (const a of atts) {
      if (!a.isImage) continue;
      void window.popbot.files.imageThumbnail(a.path).then((url) => {
        if (url) setPreviews((p) => ({ ...p, [a.id]: url }));
      });
    }
  }, []);

  const pickAttachment = async (kind: 'image' | 'any') => {
    try {
      const picked = await window.popbot.files.pickAttachment(kind);
      if (picked && picked.length > 0) {
        setAttachments((prev) => [...prev, ...picked]);
        fetchThumbs(picked);
      }
    } catch (err) {
      console.error('files.pickAttachment failed', err);
    }
  };

  // Paste an image straight from the clipboard (Windows especially) — save the
  // bytes to a temp file and attach it, with a thumbnail, before submit.
  const onPasteIntoInput = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (!item.type.startsWith('image/')) continue;
        e.preventDefault(); // don't also paste a junk filename / nothing
        const file = item.getAsFile();
        if (!file) continue;
        try {
          const buf = await file.arrayBuffer();
          const ext = item.type.split('/')[1] || 'png';
          const att = await window.popbot.files.saveClipboardImage(buf, ext);
          if (att) {
            setAttachments((prev) => [...prev, att]);
            fetchThumbs([att]);
          }
        } catch (err) {
          console.error('paste image failed', err);
        }
      }
    },
    [fetchThumbs],
  );

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setPreviews((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });
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
    decision: 'allow' | 'allow-chat' | 'allow-everywhere' | 'allow-mcp-server' | 'deny' | 'deny-everywhere',
  ) => {
    try {
      await window.popbot.agent.approve({ chatId: chat.id, permissionId, decision });
    } catch (err) {
      console.error('agent.approve failed', err);
    }
  }, [chat.id]);
  const repoTitle = chat.repoId === RAW_CHAT_REPO_ID
    ? t('chat.repo.none')
    : t('chat.repo.withName', { repoId: chat.repoId });

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
        <button className="col-close" title={t('chat.col.closeTitle')} onClick={onClose}>
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
          <span className={`pill ${chat.status}`} title={t('chat.col.statusTitle', { status: chat.status })}>
            <i className={`fa-solid ${statusIcon}`} style={{ fontSize: 9 }} />
            {t(STATUS_LABEL_KEYS[chat.status] ?? 'chat.status.idle')}
          </span>
          <button
            className="iconbtn"
            style={{ width: 22, height: 22, borderRadius: 4, color: 'var(--fg-2)' }}
            onClick={handleSettings}
            title={t('chat.col.settingsTitle')}
          >
            <i className="fa-solid fa-gear" />
          </button>
        </span>
      </div>
      <div className="runtime-strip">
        <SlotAppButtons worktreePath={chat.worktreePath ?? null} chatId={chat.id} onOpenPrefs={onOpenPrefs} />
        {/* Both chips render side-by-side when applicable so the user
            can jump to either Linear or GitHub from the chat header. */}
        {ticket && chat.ticket && (
          <TicketChip identifier={chat.ticket} state={ticket.state} url={ticket.url} t={t} />
        )}
        {pr && <PrChip pr={pr} t={t} />}
      </div>
      <div className="col-body">
        <div className="col-branch-strip">
          {chat.slotId != null && (
            <span
              className="slot-pip occupied slot-pip-wide"
              title={t('chat.slot.workspaceTitle', { slotId: chat.slotId, repoId: chat.repoId })}
            >
              {/* Compose `${prefix}-${slotId}` from the live repo
                  record (joined into ChatRecord). Reading from the
                  stored `worktreePath` basename was unreliable for
                  chats whose path was set under an earlier-buggy
                  resolver — they'd show `slot-N` even when the repo
                  was later configured with prefix `ops`. */}
              {chat.repoSlotPrefix
                ? `${chat.repoSlotPrefix}-${chat.slotId}`
                : (chat.worktreePath?.split(/[/\\]/).pop() ?? t('chat.slot.fallback', { slotId: chat.slotId }))}
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
              title={t('chat.slot.worktreeTitle', { worktreePath: chat.worktreePath })}
            >
              {chat.worktreePath.split(/[/\\]/).pop()}
            </span>
          )}
          {chat.branch && (
            <span
              className="col-branch"
              title={t(
                chat.repoScm === 'perforce' ? 'chat.branch.title.perforce' : 'chat.branch.title',
                { branch: chat.branch },
              )}
            >
              <i className="fa-solid fa-code-branch col-branch-icon" />
              <span className="col-branch-name mono">{chat.branch}</span>
            </span>
          )}
          <span className="col-branch-meta">
            {chat.type === 'lite' ? t('chat.type.lite') : t('chat.type.clientTest')}
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
        title={t('chat.input.resizeTitle')}
        role="separator"
        aria-orientation="horizontal"
      />
      <div className="col-foot">
        <div className={`input-wrap ${isActive ? 'active' : ''}`}>
          {attachments.length > 0 && (
            <div className="attachment-chips">
              {attachments.map((a) => (
                <span key={a.id} className="attachment-chip" title={a.path}>
                  {previews[a.id] ? (
                    <img className="attachment-chip-thumb" src={previews[a.id]} alt={a.name} />
                  ) : (
                    <i className={`fa-solid ${a.isImage ? 'fa-image' : 'fa-paperclip'}`} />
                  )}
                  <span className="attachment-chip-name">{a.name}</span>
                  <button
                    className="attachment-chip-x"
                    onClick={() => removeAttachment(a.id)}
                    title={t('chat.attachment.removeTitle')}
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
                  ? t('chat.input.placeholderRunning')
                  : t('chat.input.placeholderIdle')
                : t('chat.input.placeholderInactive')
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onTextareaKey}
            onPaste={(e) => void onPasteIntoInput(e)}
            style={textareaStyle}
          />
          <div className="input-row">
            <button
              className="iconbtn"
              title={t('chat.input.attachImage')}
              onClick={() => void pickAttachment('image')}
            >
              <i className="fa-solid fa-image" />
            </button>
            <button
              className="iconbtn"
              title={t('chat.input.attachFile')}
              onClick={() => void pickAttachment('any')}
            >
              <i className="fa-solid fa-paperclip" />
            </button>
            <select
              className={`agent-select ${agent}`}
              title={t('chat.input.model')}
              aria-label={t('chat.input.model')}
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
              title={t('chat.input.effort')}
              aria-label={t('chat.input.effort')}
              value={selectedReasoningEffort}
              disabled={configuringAgent || chat.status === 'run'}
              onChange={(e) => changeReasoning(
                e.currentTarget.value as ClaudeReasoningEffort | CodexReasoningEffort,
              )}
            >
              {reasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>{t(REASONING_LABEL_KEYS[effort])}</option>
              ))}
            </select>
            <span className="spacer" />
            <span className="token-counter">
              <b>{fmtTokens(chat.tokensUsed)}</b> / {fmtTokens(chat.tokensBudget)}
            </span>
            {chat.status === 'run' ? (
              <button className="btn danger sm" title={t('chat.input.stopTitle')} onClick={stop}>
                <i className="fa-solid fa-stop" /> {t('chat.input.stop')}
              </button>
            ) : (
              <button
                className="btn primary sm"
                onClick={() => void send()}
                disabled={sending || !draft.trim()}
              >
                {t('common.send')} <span className="kbd">↵</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
    {pendingAgentSwitch && (
      <ConfirmDialog
        title={t('chat.agentSwitch.title')}
        message={t('chat.agentSwitch.message')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('chat.agentSwitch.confirm')}
        onCancel={() => setPendingAgentSwitch(null)}
        onConfirm={() => void switchAgentAndRestart(pendingAgentSwitch)}
      />
    )}
    </>
  );
}

/** Per-slot launcher row: terminal, editor, then a "Run editor" button for
 *  each ENABLED game engine (Unity/Unreal/Custom). Buttons are gray +
 *  disabled when the chat has no worktree (e.g. ad-hoc Slack chats); colored
 *  + clickable otherwise. */
// Git client deliberately omitted for now: GitHub Desktop doesn't
// support worktrees, so launching it would point at the parent repo
// instead of the slot. Re-add once we have a worktree-friendly client.
type AppButtonKind = 'terminal' | 'editor' | GameEngineId;
interface AppButtonDef {
  kind: AppButtonKind;
  /** Exactly one of fa / img / emoji identifies the glyph. */
  fa?: string;
  img?: string;
  emoji?: string;
  /** i18n key (terminal/editor) or literal engine label (Unity/Unreal/…). */
  labelKey?: MessageKey;
  label?: string;
  color: string;
}

const STATIC_APP_BUTTONS: AppButtonDef[] = [
  { kind: 'terminal', fa: 'fa-solid fa-terminal', labelKey: 'chat.app.terminal', color: '#7fb676' },
  { kind: 'editor',   fa: 'fa-solid fa-code',     labelKey: 'chat.app.editor',   color: '#4f8bff' },
];

/** Chat-bar glyph per engine: Unity/Unreal use their logo (white on the dark
 *  bar), Custom uses the yellow-box emoji. */
const ENGINE_GLYPH: Record<GameEngineId, { img?: string; emoji?: string }> = {
  unity: { img: unityEngineIcon },
  unreal: { img: unrealEngineIcon },
  custom: { emoji: '📦' },
};

function SlotAppButtons({
  worktreePath,
  chatId,
  onOpenPrefs,
}: {
  worktreePath: string | null;
  chatId?: string;
  onOpenPrefs?: (section?: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { get } = useSettings();
  const enabled = !!worktreePath;
  const running = useAppsRunning();
  // Main reports running state by slot basename (e.g. 'slot-3') so
  // we don't have to worry about per-app path conventions in the
  // renderer (the engine's project-subpath setting, etc.).
  const slotName = worktreePath ? worktreePath.split(/[/\\]/).pop() ?? '' : '';

  // Detect the engine THIS chat's worktree belongs to (Unity vs Unreal — the
  // worktree either IS the project or HAS one in a child folder). The chat bar
  // shows that one engine's Run button + icon, so an Unreal project never shows
  // the Unity logo. Custom (no project marker) is the catch-all when nothing is
  // detected and the user has enabled it.
  // undefined = detection not yet run; null = checked, no engine found. The
  // distinction avoids briefly showing the Custom button (the !detected branch)
  // for a Unity/Unreal project before detection resolves.
  const [detected, setDetected] = useState<GameEngineId | null | undefined>(undefined);
  useEffect(() => {
    if (!worktreePath) { setDetected(null); return; }
    setDetected(undefined);
    let alive = true;
    void window.popbot.engines.detect(worktreePath).then((id) => { if (alive) setDetected(id); });
    return () => { alive = false; };
  }, [worktreePath]);

  const engines = (get<{ engines?: GameEnginesSettings }>('apps', {}) ?? {}).engines;
  let engineForChat: GameEngineId | null = null;
  if (detected && engineEnabled(engines?.[detected], detected)) engineForChat = detected;
  else if (detected === null && engineEnabled(engines?.custom, 'custom')) engineForChat = 'custom';

  const buttons: AppButtonDef[] = [
    ...STATIC_APP_BUTTONS,
    ...(engineForChat
      ? [{
          kind: engineForChat,
          ...ENGINE_GLYPH[engineForChat],
          label: engineMeta(engineForChat).label,
          color: engineMeta(engineForChat).color,
        } satisfies AppButtonDef]
      : []),
  ];

  const open = async (kind: AppButtonKind) => {
    if (!worktreePath) return;
    const res = await window.popbot.apps.open(kind, worktreePath, chatId);
    if (!res.ok) {
      // An unconfigured engine deep-links to Preferences → Integrations
      // instead of nagging with an alert.
      if ('reason' in res && res.reason === 'not-configured' && onOpenPrefs) {
        onOpenPrefs('integ');
        return;
      }
      // eslint-disable-next-line no-alert
      alert(`Couldn't launch ${kind}:\n\n${res.error}`);
    }
  };
  const openAll = () => {
    if (!worktreePath) return;
    buttons.forEach((b) => void open(b.kind));
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
      {buttons.map((b) => {
        const isRunning = !!slotName && running[b.kind].has(slotName);
        const label = b.labelKey ? t(b.labelKey) : b.label ?? '';
        return (
          <button
            key={b.kind}
            className={`slot-app-btn ${isRunning ? 'running' : ''}`}
            disabled={!enabled}
            onClick={() => open(b.kind)}
            title={
              isRunning
                ? t('chat.app.runningTitle', { label })
                : enabled
                  ? `${label} — ${worktreePath}`
                  : t('chat.app.noSlotTitle', { label })
            }
            style={enabled ? { color: b.color } : undefined}
          >
            {b.img ? (
              <img src={b.img} alt="" className="slot-app-img" />
            ) : b.emoji ? (
              <span className="slot-app-emoji">{b.emoji}</span>
            ) : (
              <i className={b.fa} />
            )}
          </button>
        );
      })}
    </div>
  );
}

interface EmptyColumnProps {
  /** When omitted, no close button renders (used for the always-on starting page). */
  onClose?: () => void;
  /** Start a new chat (the BaseBranchDialog handles repo / branch /
   *  workspace-mode choices). */
  onNewChat: () => void;
  /** Jump into Preferences (optionally at a specific section) for setup. */
  onOpenPrefs?: (section?: string) => void;
  /** Shared readiness state (agents + repo) from the parent, so the
   *  checklist here and the gating of the central + stay in sync. */
  readiness: Readiness;
}

/** One line in the readiness checklist: a status dot + label, and an
 *  optional call-to-action when the item still needs setup. */
function ReadyRow({
  state,
  label,
  detail,
  action,
  okText = 'Ready',
}: {
  state: 'ok' | 'missing' | 'optional';
  label: string;
  detail?: string;
  action?: { text: string; onClick: () => void; icon?: string };
  /** Confirmation shown in the right column when the item is active
   *  (no setup action) — keeps that column from sitting empty. */
  okText?: string;
}): JSX.Element {
  const icon =
    state === 'ok' ? 'fa-circle-check'
      : state === 'optional' ? 'fa-circle-minus'
        : 'fa-circle-exclamation';
  const color =
    state === 'ok' ? 'var(--ok, #46c878)'
      : state === 'optional' ? 'var(--fg-3)'
        : 'var(--warn, #e6b04a)';
  return (
    <div className="ready-row">
      <i className={`fa-solid ${icon}`} style={{ color, width: 16, textAlign: 'center', flex: '0 0 auto' }} />
      <span className="ready-label">{label}</span>
      {detail && <span className="ready-detail">{detail}</span>}
      <div className="ready-right">
        {action ? (
          <button className="btn primary sm ready-action" onClick={action.onClick}>
            {action.icon && <i className={`fa-solid ${action.icon}`} />} {action.text}
          </button>
        ) : (
          <span className="ready-ok"><i className="fa-solid fa-check" /> {okText}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Modal that explains the agent capability and points the user to the
 * VENDOR's official install instructions. We deliberately don't repeat
 * Anthropic's / OpenAI's install commands here — they change, and we
 * don't want to be the reason someone installs the CLI incorrectly. We
 * just describe the 1-2-3 flow and link out to the source of truth.
 */
function InstallHelpDialog({
  provider,
  onClose,
}: {
  provider: 'claude' | 'codex';
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const info = provider === 'claude'
    ? {
        title: t('chat.install.claudeTitle'),
        cli: 'Claude Code CLI',
        vendor: 'Anthropic',
        intro: t('chat.install.claudeIntro'),
        docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
        signin: t('chat.install.claudeSignin'),
      }
    : {
        title: t('chat.install.codexTitle'),
        cli: 'Codex CLI',
        vendor: 'OpenAI',
        intro: t('chat.install.codexIntro'),
        docsUrl: 'https://developers.openai.com/codex/cli/',
        signin: t('chat.install.codexSignin'),
      };
  const steps: Array<{ title: string; desc: string; cta?: { text: string; onClick: () => void } }> = [
    {
      title: t('chat.install.stepInstall', { cli: info.cli }),
      desc: t('chat.install.stepInstallDesc', { vendor: info.vendor }),
      cta: { text: t('chat.install.openGuide', { vendor: info.vendor }), onClick: () => window.open(info.docsUrl, '_blank') },
    },
    { title: t('chat.install.stepSignin'), desc: info.signin },
    { title: t('chat.install.stepRestart'), desc: t('chat.install.stepRestartDesc') },
  ];
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" data-screen-label={`Modal · install-${provider}`}>
        <div className="modal-head">
          <h2>{info.title}</h2>
        </div>
        <div className="modal-body">
          <p className="install-intro">{info.intro}</p>
          <ol className="install-steps">
            {steps.map((s, i) => (
              <li key={i} className="install-step">
                <span className="install-step-num">{i + 1}</span>
                <div className="install-step-body">
                  <div className="install-step-title">{s.title}</div>
                  <div className="install-step-desc">{s.desc}</div>
                  {s.cta && (
                    <button className="btn primary sm" onClick={s.cta.onClick}>
                      <i className="fa-solid fa-arrow-up-right-from-square" /> {s.cta.text}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>{t('common.gotIt')}</button>
        </div>
      </div>
    </>
  );
}

/**
 * The agents + repository readiness checklist. Shared by the empty-chat
 * pane and the "finish setup" gate modal so both surfaces stay in sync.
 * Owns its own install-help dialog.
 */
export function ReadinessChecklist({
  readiness: r,
  onOpenPrefs,
}: {
  readiness: Readiness;
  onOpenPrefs?: (section?: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [installHelp, setInstallHelp] = useState<'claude' | 'codex' | null>(null);
  const claudeOk = r.backends?.claude.ok ?? false;
  const codexOk = r.backends?.codex.ok ?? false;
  return (
    <>
      <div className="ready-card">
        <div className="ready-card-head">
          <span>{r.loading ? t('chat.ready.checking') : r.ready ? t('chat.ready.ready') : t('chat.ready.finish')}</span>
          <button
            className="ready-recheck"
            title={t('chat.ready.recheckTitle')}
            onClick={() => r.refresh()}
            disabled={r.loading}
          >
            <i className={`fa-solid fa-arrows-rotate${r.loading ? ' fa-spin' : ''}`} />
          </button>
        </div>
        <ReadyRow
          state={claudeOk ? 'ok' : 'missing'}
          label={t('chat.ready.claudeLabel')}
          detail={claudeOk
            ? (r.backends?.claude.version?.replace(/\s*\(.*\)$/, '') ?? '')
            : t('chat.ready.notFound')}
          okText={t('chat.ready.online')}
          action={claudeOk ? undefined : {
            text: t('chat.ready.howToInstall'),
            onClick: () => setInstallHelp('claude'),
          }}
        />
        <ReadyRow
          state={codexOk ? 'ok' : 'optional'}
          label={t('chat.ready.codexLabel')}
          detail={codexOk
            ? (r.backends?.codex.version?.replace(/\s*\(.*\)$/, '') ?? '')
            : t('chat.ready.optional')}
          okText={t('chat.ready.online')}
          action={codexOk ? undefined : {
            text: t('chat.ready.howToInstall'),
            onClick: () => setInstallHelp('codex'),
          }}
        />
        <ReadyRow
          state={r.hasRepo ? 'ok' : 'missing'}
          label={t('chat.ready.repoLabel')}
          detail={r.hasRepo
            ? (r.repoCount > 1 ? t('chat.ready.repoCount', { count: r.repoCount }) : (r.repoName ?? ''))
            : t('common.none')}
          okText={t('chat.ready.ok')}
          action={r.hasRepo ? undefined : {
            text: t('chat.ready.addRepo'),
            icon: 'fa-code-fork',
            onClick: () => onOpenPrefs?.('repos'),
          }}
        />
      </div>
      {installHelp && (
        <InstallHelpDialog provider={installHelp} onClose={() => setInstallHelp(null)} />
      )}
    </>
  );
}

/**
 * Tiny acknowledgement shown when the user tries to start a chat (via
 * the +, a shortcut, a ticket, a PR, …) before setup is complete. It
 * deliberately does NOT reproduce the checklist — that already lives in
 * the center pane; this just keeps the button from feeling broken and
 * points the user there.
 */
export function ReadinessGateModal({
  readiness,
  onClose,
}: {
  readiness: Readiness;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const missing = !readiness.hasAgent && !readiness.hasRepo
    ? t('chat.gate.missingBoth')
    : !readiness.hasAgent
      ? t('chat.gate.missingAgent')
      : t('chat.gate.missingRepo');
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" data-screen-label="Modal · finish-setup">
        <div className="modal-head">
          <h2>{t('chat.gate.title')}</h2>
        </div>
        <div className="modal-body">
          {t('chat.gate.body', { missing })}
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>{t('common.gotIt')}</button>
        </div>
      </div>
    </>
  );
}

export function EmptyColumn({
  onClose,
  onNewChat,
  onOpenPrefs,
  readiness: r,
}: EmptyColumnProps): JSX.Element {
  const { t } = useTranslation();
  // Block chat creation until a repo + at least one agent are ready.
  // While the probe is in-flight, don't disable (avoid a flash of the
  // disabled state on a machine that's actually set up).
  const blocked = !r.loading && !r.ready;
  const gateReason = !r.hasAgent
    ? t('chat.empty.gateNoAgent')
    : !r.hasRepo
      ? t('chat.empty.gateNoRepo')
      : undefined;

  return (
    <div className="col" data-screen-label="Chat · Empty">
      <div className="col-head">
        {onClose && (
          <button className="col-close" title={t('chat.empty.closeTitle')} onClick={onClose}>×</button>
        )}
        <span className="col-name" style={{ color: 'var(--fg-2)' }}>{t('chat.empty.newChat')}</span>
      </div>
      <div className="col-empty">
        <h3>{t('chat.empty.heading')}</h3>
        <p>{t('chat.empty.subtext')}</p>

        {/* Once the required pieces (an AI provider + a repo) are ready,
            the setup checklist disappears — just show the create buttons.
            Until then, show the checklist (with a re-check button) and a
            guidance line instead of dead create buttons. */}
        {!blocked ? (
          <>
            <div className="options">
              <button className="btn primary" onClick={onNewChat}>{t('chat.empty.newChatBtn')}</button>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 12, lineHeight: 1.6 }}>
              <span className="kbd">{hotkey('T')}</span> {t('chat.empty.hintNewChat')} · <span className="kbd">{hotkey('T', { shift: true })}</span> {t('chat.empty.hintFromClipboard')} ·{' '}
              <span className="kbd">{hotkey('K')}</span> {t('chat.empty.hintPalette')}
            </div>
          </>
        ) : (
          <>
            <ReadinessChecklist readiness={r} onOpenPrefs={onOpenPrefs} />
            {blocked && (
              <div style={{ fontSize: 12, color: 'var(--warn, #e6b04a)', marginTop: 4 }}>
                {t('chat.empty.useButtons', { gateReason: gateReason ?? '' })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

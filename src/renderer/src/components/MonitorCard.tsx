import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { colAccentStyle } from '../lib/repoColor';
import type {
  MessageBodyPermission,
  MessageBodyText,
  MessageBodyTool,
  MessageRecord,
} from '@shared/persistence';
import { looksLikeQuestion } from '@shared/questionDetect';
import { fmtTokens, tokenBarClass, tokenBarPct, type Chat, type ActivityItem } from '../fixtures/data';
import { useMessages } from '../lib/useMessages';

/**
 * Project a flat MessageRecord into the prototype's ActivityItem shape so
 * the existing thumbnail render code (with its cursor + styling per kind)
 * keeps working.
 */
function messageToActivity(m: MessageRecord): ActivityItem | null {
  if (m.kind === 'text') {
    let text = '';
    try {
      text = (JSON.parse(m.body) as MessageBodyText).text ?? '';
    } catch {
      // ignore
    }
    if (m.role === 'user') return { kind: 'user', text };
    return { kind: 'say', text };
  }
  if (m.kind === 'tool') {
    let name = '';
    let args: Record<string, unknown> = {};
    try {
      const body = JSON.parse(m.body) as MessageBodyTool;
      name = body.name;
      args = body.args ?? {};
    } catch {
      // ignore
    }
    const cmd = typeof args.command === 'string' ? args.command : '';
    return { kind: 'tool', name, args: cmd };
  }
  if (m.kind === 'permission') {
    let label = 'permission requested';
    try {
      const body = JSON.parse(m.body) as MessageBodyPermission;
      label = `wants ${body.tool}`;
    } catch {
      // ignore
    }
    return { kind: 'perm', text: label };
  }
  return null;
}

interface MonitorCardProps {
  chat: Chat;
  isFocused: boolean;
  isForeground: boolean;
  /** True iff this chat is in the visible center-column window. */
  isVisible?: boolean;
  /** Optional ref setter so the parent can measure this card for overlays. */
  refSetter?: (el: HTMLDivElement | null) => void;
  onClick: () => void;
  onBringForward: () => void;
}

type AttentionKind = 'PLAN' | 'PERMISSION' | 'QUESTION' | 'WAIT';

function detectAttention(messages: MessageRecord[]): AttentionKind | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === 'permission') {
      try {
        const body = JSON.parse(m.body) as MessageBodyPermission;
        // Already-decided permissions don't pause anything anymore.
        if (body.decision !== undefined) continue;
        return body.tool === 'AskUserQuestion' ? 'PLAN' : 'PERMISSION';
      } catch {
        return 'PERMISSION';
      }
    }
    if (m.kind === 'text' && m.role === 'agent') {
      try {
        const body = JSON.parse(m.body) as MessageBodyText;
        if (looksLikeQuestion(body.text)) return 'QUESTION';
      } catch {
        // ignore
      }
      return 'WAIT';
    }
    if (m.kind === 'text' && m.role === 'user') {
      // The user already replied — agent is presumably resuming.
      return null;
    }
  }
  return null;
}

export function MonitorCard({ chat, isFocused, isForeground, isVisible = true, refSetter, onClick, onBringForward }: MonitorCardProps): JSX.Element {
  // Thumbnail renders the last 6 activity lines, full stop — nothing
  // here ever scrolls. Cap the load to that.
  const { messages } = useMessages(chat.id, 6);
  const activity: ActivityItem[] = useMemo(() => {
    if (messages.length === 0) {
      return [{ kind: 'say', text: chat.snippet || '(idle)' }];
    }
    const tail = messages.slice(-6);
    const items: ActivityItem[] = [];
    for (const m of tail) {
      const a = messageToActivity(m);
      if (a) items.push(a);
    }
    return items;
  }, [messages, chat.snippet]);
  const tokenPct = tokenBarPct(chat.tokens.used);

  const attention = useMemo(
    () => (chat.status === 'wait' ? detectAttention(messages) : null),
    [messages, chat.status],
  );

  const [, setTick] = useState(0);
  useEffect(() => {
    if (chat.status !== 'run') return;
    const id = setInterval(() => setTick((t) => t + 1), 1400);
    return () => clearInterval(id);
  }, [chat.status]);

  // Thumbnail renders newest at the BOTTOM (chat-style). Activity is
  // already in chronological (oldest-first) order from the slice above.
  const lines = activity;
  const lastIdx = lines.length - 1;

  const glyph =
    chat.status === 'run'  ? <i className="fa-solid fa-circle-play" /> :
    chat.status === 'done' ? <i className="fa-solid fa-circle-check" /> :
    chat.status === 'wait' ? <i className="fa-solid fa-circle-question" /> :
    chat.status === 'err'  ? <i className="fa-solid fa-circle-xmark" /> :
                              <i className="fa-regular fa-circle" />;

  const shortBranch = chat.branch
    .replace(/^eng\//, '')
    .replace(/^review\//, 'PR/')
    .replace(/^wip\//, '');

  const handleBringForward = (e: MouseEvent) => {
    e.stopPropagation();
    onBringForward();
  };

  return (
    <div
      ref={refSetter}
      className={`monitor ${chat.status} ${isFocused ? 'focused' : ''} ${isForeground ? 'is-foreground' : ''} ${isVisible ? 'is-visible' : 'is-offscreen'}`}
      onClick={onClick}
      // Per-card accent → drives the focused border + foreground ring
      // in this chat's repo color, plus the perceptual `--col-accent-fg`
      // for chips on top of the accent. Falls back to apple-blue when
      // repoColor isn't set.
      style={colAccentStyle(chat.repoColor)}
    >
      {isForeground && <span className="fg-tag">FG</span>}
      {attention && (
        <span className="attn-tag" data-kind={attention.toLowerCase()}>{attention}</span>
      )}

      <div className="mon-head">
        <span className={`mon-glyph status-${chat.status}`}>{glyph}</span>
        <span className="mon-name" title={chat.name}>{chat.name}</span>
        <span
          className="mon-tok"
          title={`${chat.tokens.used.toLocaleString()} / ${chat.tokens.budget.toLocaleString()} tokens`}
        >
          {fmtTokens(chat.tokens.used)}
        </span>
      </div>

      <div className="mon-sub">
        <span className="mon-branch" title={chat.branch}>
          <i className="fa-solid fa-code-branch" /> {shortBranch}
        </span>
        <span className="mon-agent">{chat.agent === 'codex' ? 'codex' : 'claude'}</span>
        <span className="mon-time">{chat.timestamp}</span>
      </div>

      <div className="mon-trans">
        {lines.map((a, i) => {
          const isLast = i === lastIdx;
          if (a.kind === 'say') {
            return (
              <div key={i} className={`tline say ${isLast && chat.status === 'run' ? 'live' : ''}`}>
                <span className="tline-text-window">
                  <span className="tline-text">{a.text}</span>
                </span>
                {isLast && chat.status === 'run' && <span className="tline-cursor" />}
              </div>
            );
          }
          if (a.kind === 'user') {
            return (
              <div key={i} className="tline user">
                <span className="tline-tag">you</span>
                <span className="tline-text">{a.text}</span>
              </div>
            );
          }
          if (a.kind === 'tool') {
            return (
              <div key={i} className="tline tool">
                <i className="fa-solid fa-wrench tline-icon" />
                <span className="tline-mono">
                  <b>{a.name}</b> <span className="dim">{a.args}</span>
                </span>
              </div>
            );
          }
          if (a.kind === 'diff') {
            return (
              <div key={i} className="tline tool">
                <i className="fa-solid fa-pen-to-square tline-icon" />
                <span className="tline-mono">
                  <b>{a.path?.split(/[/\\]/).pop()}</b>{' '}
                  <span style={{ color: 'var(--st-done)' }}>+{a.add}</span>{' '}
                  <span style={{ color: 'var(--st-err)' }}>−{a.rem}</span>
                </span>
              </div>
            );
          }
          if (a.kind === 'perm') {
            return (
              <div key={i} className="tline perm">
                <i className="fa-solid fa-circle-question tline-icon" />
                <span className="tline-text">{a.text}</span>
              </div>
            );
          }
          return null;
        })}
        {/* Standalone "AI is doing something" cursor — shows whenever
            the chat is running but the most recent activity wasn't a
            stream of agent prose (which already has its own inline
            cursor on the say line). Tool / diff / perm rows otherwise
            give no visual hint that work is in flight. */}
        {chat.status === 'run' && (lines.length === 0 || lines[lastIdx]?.kind !== 'say') && (
          <div className="tline tline-thinking">
            <span className="tline-cursor" />
          </div>
        )}
      </div>

      <div className="mon-foot">
        <div className={`token-bar ${tokenBarClass(chat.tokens.used, chat.tokens.budget)}`}>
          <i style={{ width: tokenPct + '%' }} />
        </div>
        <button
          className={`mon-fg ${isForeground ? 'on' : ''}`}
          onClick={handleBringForward}
          title={isForeground ? 'Foregrounded · click to background' : 'Bring Unity & server forward'}
        >
          {isForeground ? (
            <>
              <i className="fa-solid fa-circle" /> FG
            </>
          ) : (
            <>
              <i className="fa-regular fa-circle" /> bring
            </>
          )}
        </button>
      </div>
    </div>
  );
}

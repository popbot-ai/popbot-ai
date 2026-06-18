import { useState } from 'react';
import type { Chat } from '../fixtures/data';
import type { ChatRecord } from '@shared/persistence';
import { TerminalView } from './TerminalView';
import { colAccentStyle } from '../lib/repoColor';

interface PanelDProps {
  /** Used only for the "focused: <name>" label in the header. */
  focusedChat: Chat | undefined;
  /** Drives the live terminal — null when no chat is focused or the
   *  chat has no slot worktree yet. */
  focusedRecord: ChatRecord | null;
}

// The Unity / Server log panes are intentionally absent — they were
// hardcoded fixture data with no live wiring. PanelD is now Terminal-
// only until a real log pipeline (game-side log forwarding) lands.
//
// Terminals don't auto-spawn on focus — the user must click "New
// Terminal" to attach one. Opening a PTY is not free (a shell process
// per chat) and most chats never need one. The set of chat ids that
// have been opened in this session is held here; switching away from
// a chat with an active terminal preserves the PTY (it lives in main),
// and re-focusing it remounts the existing one without a new click.
export function PanelD({ focusedChat, focusedRecord }: PanelDProps): JSX.Element {
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const chatId = focusedRecord?.id ?? null;
  const isOpened = chatId !== null && opened.has(chatId);

  const openTerminal = () => {
    if (!chatId) return;
    setOpened((prev) => {
      if (prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.add(chatId);
      return next;
    });
  };

  // Plain "Terminal · Slot N" label — the blue pill version was
  // visually competing with the chat-header pill for attention; flat
  // text reads cleaner here.
  const slotLabel = focusedRecord?.slotId == null ? '' : ` · Slot ${focusedRecord.slotId}`;
  return (
    <div className="bottom" data-screen-label="Panel D · Terminal">
      <div className="bottom-head">
        <div className="bottom-tabs">
          {/* Lint flags aria-selected on plain <button>; CSS selectors here
              key the active-tab styling off it (matches the other tab bars
              in the app), so we keep it. */}
          <button className="bottom-tab" aria-selected>Terminal{slotLabel}</button>
        </div>
        <div className="bottom-actions">
          <span className="label">focused: {focusedChat?.name?.split(' ').slice(0, 2).join(' ') || '—'}</span>
        </div>
      </div>
      <div className="bottom-body">
        {renderBody({
          focusedRecord,
          isOpened,
          openTerminal,
        })}
      </div>
    </div>
  );
}

function renderBody({ focusedRecord, isOpened, openTerminal }: {
  focusedRecord: ChatRecord | null;
  isOpened: boolean;
  openTerminal: () => void;
}): JSX.Element {
  if (focusedRecord?.worktreePath && isOpened) {
    return <TerminalView chatId={focusedRecord.id} cwd={focusedRecord.worktreePath} />;
  }
  if (focusedRecord?.worktreePath) {
    // Inline `--col-accent` (+ perceptual fg) so the primary button
    // picks up the focused chat's repo color instead of the global
    // apple-blue, with readable text on bright accents. Falls back
    // via `.btn.primary` when repoColor is unset.
    return (
      <div className="term-empty">
        <button
          className="btn primary sm"
          onClick={openTerminal}
          style={colAccentStyle(focusedRecord.repoColor)}
        >
          <i className="fa-solid fa-plus" /> New Terminal
        </button>
      </div>
    );
  }
  return (
    <div className="term-empty">
      {focusedRecord
        ? 'This chat has no slot worktree yet.'
        : 'Focus a chat to open its terminal.'}
    </div>
  );
}

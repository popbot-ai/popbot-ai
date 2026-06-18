import { useEffect, useState } from 'react';
import type { ClosePrepResult } from '@shared/ipc';

interface CloseChatPromptProps {
  chatId: string;
  branch: string | null;
  slotId: number | null;
  onCancel: () => void;
  onClose: (opts: { stash: boolean }) => void;
}

/**
 * Pre-close confirmation. Always shown when the chat has a worktree;
 * adapts its body to clean vs dirty state. Clean → "park slot" only
 * (single button). Dirty → stash / discard / cancel.
 */
export function CloseChatPrompt({
  chatId,
  branch,
  slotId,
  onCancel,
  onClose,
}: CloseChatPromptProps): JSX.Element {
  const [prep, setPrep] = useState<ClosePrepResult | null>(null);

  useEffect(() => {
    void window.popbot.chats.closePrep(chatId).then(setPrep);
  }, [chatId]);

  return (
    <>
      <div className="scrim" onClick={onCancel} />
      <div className="modal" data-screen-label="Modal · close-chat">
        <div className="modal-head">
          <h2>
            You are closing this branch <span className="mono">{branch ?? '(no branch)'}</span>.
          </h2>
          <div className="sub">
            {slotId != null && <>Slot {slotId} will be parked back to <span className="mono">popbot/slot-{slotId}</span>.</>}
          </div>
        </div>
        <div className="modal-body">
          {prep === null && <div>Checking worktree…</div>}
          {prep !== null && !prep.hasWorktree && (
            <>This chat has no worktree to clean up.</>
          )}
          {prep !== null && prep.hasWorktree && !prep.dirty && (
            <>The worktree is clean — nothing to stash.</>
          )}
          {prep !== null && prep.hasWorktree && prep.dirty && (
            <>
              <p>
                Do you want to stash all uncommitted changes? These changes
                will be unstashed if you reopen this chat.
              </p>
              <pre className="dirty-files">
                {prep.files.map((f) => f).join('\n')}
              </pre>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          {prep?.dirty ? (
            <>
              <button className="btn danger" onClick={() => onClose({ stash: false })}>
                Discard &amp; close
              </button>
              <button className="btn primary" onClick={() => onClose({ stash: true })}>
                Stash &amp; close
              </button>
            </>
          ) : (
            <button className="btn primary" disabled={prep === null} onClick={() => onClose({ stash: false })}>
              Close chat
            </button>
          )}
        </div>
      </div>
    </>
  );
}

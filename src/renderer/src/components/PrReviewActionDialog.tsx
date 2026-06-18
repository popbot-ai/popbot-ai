import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReviewItem } from '@shared/reviews';
import {
  AGENT_EFFORT_DEFAULTS_SETTING,
  AgentCreateControls,
  agentCreateConfigWithEffortDefaults,
  compactAgentCreateConfig,
  DEFAULT_AGENT_CREATE_CONFIG,
  type AgentCreateConfig,
  type AgentEffortDefaultsSettings,
} from './AgentCreateControls';

interface PrReviewActionDialogProps {
  review: ReviewItem;
  onCreateChat: (agentConfig: AgentCreateConfig) => void;
  onIgnore: () => void;
  onCancel: () => void;
}

const LAST_AGENT_SETTING = 'chatCreate.lastAgentConfig';

/**
 * Three-way prompt that fires when the user clicks a PR in the review
 * list and there's no existing chat for it yet:
 *   - Create chat: spawn a focused PR-review chat (existing flow).
 *   - Ignore: drop this PR from the review list permanently. The chat
 *     for it is never created and the row is hidden on subsequent
 *     refreshes (the ignored PR number lives in `reviews.ignored`).
 *   - Cancel: close the dialog without doing anything.
 *
 * Esc cancels; Enter is the same as "Create chat" (the most common
 * intent — clicking a PR usually means you mean to work on it).
 */
export function PrReviewActionDialog({
  review,
  onCreateChat,
  onIgnore,
  onCancel,
}: PrReviewActionDialogProps): JSX.Element {
  const [agentConfig, setAgentConfig] = useState<AgentCreateConfig>(DEFAULT_AGENT_CREATE_CONFIG);

  useEffect(() => {
    void Promise.all([
      window.popbot.settings.get<AgentCreateConfig>(LAST_AGENT_SETTING),
      window.popbot.settings.get<AgentEffortDefaultsSettings>(AGENT_EFFORT_DEFAULTS_SETTING),
    ]).then(([lastAgent, defaults]) => {
      setAgentConfig(agentCreateConfigWithEffortDefaults(lastAgent, defaults, 'codeReview'));
    });
  }, []);

  const create = (): void => {
    const chosen = compactAgentCreateConfig(agentConfig);
    void window.popbot.settings.set(LAST_AGENT_SETTING, chosen);
    onCreateChat(chosen);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') create();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // create closes over current selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, agentConfig]);

  return createPortal(
    <div className="confirm-scrim" onMouseDown={onCancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-label={`PR #${review.number}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">PR #{review.number}</div>
        <div className="confirm-body">
          <div style={{ marginBottom: 6, color: 'var(--fg-0)' }}>{review.title}</div>
          <div style={{ color: 'var(--fg-2)', fontSize: 11.5 }}>
            What do you want to do with this PR?
          </div>
          <div style={{ marginTop: 12 }}>
            <AgentCreateControls
              value={agentConfig}
              onChange={(next) => setAgentConfig(compactAgentCreateConfig(next))}
            />
          </div>
        </div>
        <div className="confirm-foot">
          <button className="btn ghost" onClick={onIgnore} title="Hide this PR from the review list">
            Ignore
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={create} autoFocus>
            Create chat
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { useState } from 'react';

interface P4SpamDialogProps {
  chatId: string;
  /** Pre-filled path — the common subpath the watcher auto-muted (may be ''). */
  suggestion: string;
  /** Re-fetch status after an action (which clears the pending suggestion). */
  onDone: () => void;
}

type Action = 'p4ignore' | 'prefs' | 'session' | 'reconcile';

/**
 * Surfaced when the watcher auto-mutes a folder for runaway churn. The user
 * edits the path (commonly UP to a parent) and picks a disposition: persist an
 * ignore (.p4ignore or PopBot prefs), mute it just for this session, or — if
 * those are real changes — reconcile that folder into the changelist.
 */
export function P4SpamDialog({ chatId, suggestion, onDone }: P4SpamDialogProps): JSX.Element {
  const [path, setPath] = useState(suggestion);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: Action): Promise<void> => {
    const p = path.trim();
    if (!p || busy) return;
    setBusy(action);
    setError(null);
    try {
      const res = await window.popbot.git.p4SpamAction({ chatId, path: p, action });
      // Only close on success; on failure keep the dialog open so the user can
      // retry (and re-enable the buttons via the finally below).
      if (res?.ok === true) {
        onDone();
      } else {
        setError('Perforce action failed. Please try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Perforce action failed. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="scrim" />
      <div className="modal" data-screen-label="Modal · p4-spam">
        <div className="modal-head">
          <h2>Many changes detected</h2>
        </div>
        <div className="modal-body">
          <p>
            A folder is producing a flood of changes — usually generated/build output. It’s been muted
            for now. Edit the path (type a parent for a broader scope), then choose what to do:
          </p>
          <input
            className="pref-input mono"
            style={{ width: '100%' }}
            value={path}
            spellCheck={false}
            autoFocus
            onChange={(e) => setPath(e.target.value)}
          />
          <p style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 6, lineHeight: 1.5 }}>
            <b>Ignore · .p4ignore</b> — persist (team-shared). <b>Ignore · PopBot</b> — persist app-locally
            (no repo edit). <b>this session</b> — mute until restart. <b>Reconcile</b> — these are real:
            recover them into the changelist.
          </p>
          {error && (
            <div className="p4-error" role="alert" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <button className="btn primary" disabled={!!busy} onClick={() => void act('p4ignore')}>
            Ignore — add to .p4ignore (team-shared)
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void act('prefs')}>
            Ignore — PopBot only (no repo edit)
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void act('session')}>
            Ignore — just this session
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void act('reconcile')}>
            {busy === 'reconcile' ? 'Reconciling…' : 'Reconcile — these are real changes'}
          </button>
        </div>
      </div>
    </>
  );
}

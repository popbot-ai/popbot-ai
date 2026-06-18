import type { ReactNode } from 'react';

interface ModalProps {
  kind: string | null;
  onClose: () => void;
}

export function Modal({ kind, onClose }: ModalProps): JSX.Element | null {
  if (!kind) return null;

  let head: ReactNode = null;
  let body: ReactNode = null;
  let foot: ReactNode = null;

  if (kind === 'drift') {
    head = (
      <>
        <h2>Server out of sync with this branch</h2>
        <div className="sub">Drift detected on chat <code>ENG-20512</code></div>
      </>
    );
    body = (
      <>
        The dev server you're connecting to is on a different commit than your worktree.
        <br /><br />
        <ul>
          <li>Server commit: <code>abc123f · "merge develop into feature/cooldown"</code></li>
          <li>Worktree expects: <code>def456a · "patch CooldownView for flicker"</code></li>
        </ul>
        Tests will likely produce false positives until this is resolved.
      </>
    );
    foot = (
      <>
        <button className="btn ghost" onClick={onClose}>Dismiss</button>
        <button className="btn" onClick={onClose}>Sync develop</button>
        <button className="btn primary" onClick={onClose}>Switch to local</button>
      </>
    );
  } else if (kind === 'dialup') {
    head = (
      <>
        <h2>Dial up Unity capacity?</h2>
        <div className="sub">Agent is blocked: needs a Unity instance</div>
      </>
    );
    body = (
      <>
        You're at the maximum of <b>2 / 2</b> active Unity instances. Allow PopBot to launch a third?
        <br /><br />
        <ul>
          <li>Will use ≈ <b>3.5 GB</b> additional RAM</li>
          <li>Hard ceiling (auto-approve cap): <b>4 instances</b></li>
          <li>Affected chat: <code>ENG-20447 · library cache crash</code></li>
        </ul>
      </>
    );
    foot = (
      <>
        <button className="btn ghost" onClick={onClose}>Deny</button>
        <button className="btn primary" onClick={onClose}>Approve · launch Unity 3</button>
      </>
    );
  } else if (kind === 'reset') {
    head = (
      <>
        <h2>Reset slot 'eng-20033'?</h2>
        <div className="sub">This is a destructive action.</div>
      </>
    );
    body = (
      <>
        <ul>
          <li>Quit Unity if running</li>
          <li>Delete the worktree and Library (~14 GB freed)</li>
          <li>Recreate from master Library</li>
        </ul>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <input type="checkbox" /> Stash uncommitted changes first
        </label>
      </>
    );
    foot = (
      <>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={onClose}>Reset slot</button>
      </>
    );
  } else if (kind === 'branch') {
    head = (
      <>
        <h2>Branch <code>develop</code> already in use</h2>
        <div className="sub">It's checked out in slot <code>main</code>.</div>
      </>
    );
    body = (
      <ul>
        <li><b>Use slot 'main'</b> for this chat (recommended)</li>
        <li>Create a temp branch <code>develop-slot-2</code> in this slot</li>
        <li>Cancel</li>
      </ul>
    );
    foot = (
      <>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={onClose}>Temp branch</button>
        <button className="btn primary" onClick={onClose}>Use slot 'main'</button>
      </>
    );
  } else if (kind === 'no-slots') {
    head = (
      <>
        <h2>No free workspace slots</h2>
        <div className="sub">Every slot is held by an open chat.</div>
      </>
    );
    body = (
      <>
        Each open chat that needs a workspace holds a slot until you close it.
        <br /><br />
        Close one of your active chats (or raise the slot limit in Preferences →
        Runtime &amp; Slots) and try again.
      </>
    );
    foot = <button className="btn primary" onClick={onClose}>OK</button>;
  } else if (kind === 'evict') {
    head = (
      <>
        <h2>Evict idle slot?</h2>
        <div className="sub">All slots busy on other branches.</div>
      </>
    );
    body = (
      <>
        To start your task on <code>ENG-20512</code>, evict the LRU slot{' '}
        <b>'review-global-chat'</b> (idle for 4h)?
      </>
    );
    foot = (
      <>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={onClose}>Queue instead</button>
        <button className="btn primary" onClick={onClose}>Evict</button>
      </>
    );
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" data-screen-label={`Modal · ${kind}`}>
        <div className="modal-head">{head}</div>
        <div className="modal-body">{body}</div>
        <div className="modal-foot">{foot}</div>
      </div>
    </>
  );
}

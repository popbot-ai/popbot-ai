interface BusyOverlayProps {
  message: string;
  detail?: string;
}

/**
 * Modal-style "working on it" indicator. Shown over the whole window
 * during slow main-side operations (git worktree add + checkout, etc).
 *
 * Has no buttons — this isn't a confirmation, just a "please wait."
 * The caller un-renders it when their async work finishes.
 */
export function BusyOverlay({ message, detail }: BusyOverlayProps): JSX.Element {
  return (
    <>
      <div className="scrim" />
      <div className="busy-overlay" data-screen-label="Busy">
        <i className="fa-solid fa-circle-notch fa-spin busy-spinner" />
        <div className="busy-msg">{message}</div>
        {detail && <div className="busy-detail mono">{detail}</div>}
      </div>
    </>
  );
}

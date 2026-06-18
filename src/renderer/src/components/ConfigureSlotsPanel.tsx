/**
 * Shared progress UI for resizing a repo's slot pool.
 *
 * Used in two places:
 *  1. The New Repo wizard's final step — current=0, target=user pick.
 *     The repo row is already created by the time we reach here, so
 *     this drives the per-slot worktree initialization.
 *  2. Edit Repo's "Resize slots" button — current=repo.slotCount,
 *     target=new pick. Adds or removes slots one at a time, then
 *     commits the new count.
 *
 * Pre-flight: refuses to start if any slot in this repo is currently
 * held by an open chat (for grow operations we still gate on this so
 * the user knows to close chats first; for shrink it's required).
 *
 * The loop is sequential per slot so the user sees real progress; the
 * per-slot IPC is fast for a no-op (alreadyReady) but multi-second on
 * actual `git worktree add` calls.
 */
import { useEffect, useState } from 'react';
import type { RepoRecord, RepoWorktreeMode } from '@shared/persistence';
import type { RepoSlotStepResult } from '@shared/ipc';

interface ConfigureSlotsPanelProps {
  repo: Pick<RepoRecord, 'id' | 'slotPrefix' | 'mode' | 'slotCount'>;
  /** Slot count BEFORE this resize. Wizard passes 0 (fresh repo).
   *  Edit-modal passes repo.slotCount. */
  currentCount: number;
  /** Slot count AFTER this resize. */
  targetCount: number;
  /** Closes the panel. Called both on cancel + on done. */
  onDone: () => void;
}

interface StepRecord {
  slotId: number;
  kind: 'init' | 'delete';
  ok: boolean;
  message?: string;
}

type Phase =
  | { kind: 'preflight' }
  | { kind: 'blocked'; reason: 'wrong-mode' | 'occupied'; occupants: Array<{ slotId: number; chatName: string }> }
  | { kind: 'ready' }
  | { kind: 'running'; step: number; total: number; current: { slotId: number; kind: 'init' | 'delete' } | null }
  | { kind: 'done'; ok: boolean };

export function ConfigureSlotsPanel({
  repo,
  currentCount,
  targetCount,
  onDone,
}: ConfigureSlotsPanelProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'preflight' });
  const [steps, setSteps] = useState<StepRecord[]>([]);

  // Plan the work as a stable list of (kind, slotId) tuples. Wizard:
  // initialize 1..targetCount. Resize-up: initialize current+1..target.
  // Resize-down: delete current..target+1 (in descending order so the
  // highest-numbered slot goes first).
  const plan: Array<{ slotId: number; kind: 'init' | 'delete' }> = (() => {
    const out: Array<{ slotId: number; kind: 'init' | 'delete' }> = [];
    if (targetCount > currentCount) {
      for (let i = currentCount + 1; i <= targetCount; i++) out.push({ slotId: i, kind: 'init' });
    } else if (targetCount < currentCount) {
      for (let i = currentCount; i > targetCount; i--) out.push({ slotId: i, kind: 'delete' });
    }
    // No-op resize: list is empty; we'll just commit the (unchanged)
    // count and exit.
    return out;
  })();

  /* Pre-flight check on mount. */
  useEffect(() => {
    void (async () => {
      if (repo.mode !== ('slots' as RepoWorktreeMode)) {
        setPhase({ kind: 'blocked', reason: 'wrong-mode', occupants: [] });
        return;
      }
      const occupants = await window.popbot.repos.listSlotOccupants(repo.id);
      // Any occupant blocks the resize — slot membership is what we're
      // mutating, so racing a live chat could yank its workspace.
      if (occupants.length > 0) {
        setPhase({ kind: 'blocked', reason: 'occupied', occupants });
        return;
      }
      setPhase({ kind: 'ready' });
    })();
    // Repo id is stable for the panel's lifetime — re-check makes
    // no sense.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async (): Promise<void> => {
    const total = plan.length;
    setSteps([]);

    if (total === 0) {
      // Pure count update — nothing to do per-slot.
      await window.popbot.repos.setSlotCount(repo.id, targetCount);
      setPhase({ kind: 'done', ok: true });
      return;
    }

    let allOk = true;
    for (let i = 0; i < total; i++) {
      const step = plan[i];
      setPhase({ kind: 'running', step: i + 1, total, current: step });
      const res: RepoSlotStepResult = step.kind === 'init'
        ? await window.popbot.repos.initializeOneSlot(repo.id, step.slotId)
        : await window.popbot.repos.deleteOneSlot(repo.id, step.slotId);
      const ok = res.ok;
      const message = res.ok
        ? (res.alreadyReady ? 'already ready' : '')
        : ('reason' in res ? res.reason : res.error);
      setSteps((prev) => [...prev, { slotId: step.slotId, kind: step.kind, ok, message }]);
      if (!ok) { allOk = false; break; }
    }
    // Commit the count even on partial failure so the row reflects
    // what's actually on disk. For init failures, the count reflects
    // how many slots actually got created. For delete failures, leave
    // the count unchanged — the slot still exists.
    if (allOk) {
      await window.popbot.repos.setSlotCount(repo.id, targetCount);
    } else if (plan[0]?.kind === 'init') {
      const lastOkSlot = steps.filter((s) => s.kind === 'init' && s.ok).at(-1)?.slotId;
      if (typeof lastOkSlot === 'number') {
        await window.popbot.repos.setSlotCount(repo.id, lastOkSlot);
      }
    }
    setPhase({ kind: 'done', ok: allOk });
  };

  const phaseLabel = phase.kind === 'running'
    ? `${phase.current?.kind === 'delete' ? 'Deleting' : 'Initializing'} slot ${phase.current?.slotId} (${phase.step} of ${phase.total})…`
    : phase.kind === 'done'
      ? (phase.ok ? 'Done.' : 'Stopped — see below.')
      : '';

  return (
    <div className="configure-slots">
      <div className="configure-slots-summary">
        <span className="mono">{repo.id}</span>
        <span className="configure-slots-arrow">{currentCount} → {targetCount}</span>
        <span className="configure-slots-detail">
          {plan.length === 0
            ? 'No slot changes — only the count needs to update.'
            : plan[0]?.kind === 'init'
              ? `Will create ${plan.length} new slot${plan.length === 1 ? '' : 's'}.`
              : `Will delete ${plan.length} slot${plan.length === 1 ? '' : 's'}.`}
        </span>
      </div>

      {phase.kind === 'preflight' && (
        <p className="pref-section-desc">Checking slot occupancy…</p>
      )}

      {phase.kind === 'blocked' && phase.reason === 'wrong-mode' && (
        <div className="pref-error">This repo is in ephemeral mode — there are no slots to configure.</div>
      )}

      {phase.kind === 'blocked' && phase.reason === 'occupied' && (
        <div className="pref-warn">
          <strong>Slots in use.</strong> Close these chats before resizing the pool:
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {phase.occupants.map((o) => (
              <li key={o.slotId}>Slot {o.slotId} · {o.chatName}</li>
            ))}
          </ul>
        </div>
      )}

      {phase.kind === 'ready' && (
        <p className="pref-section-desc">
          {plan.length === 0
            ? 'Nothing to do — click Apply to update the count.'
            : plan[0]?.kind === 'init'
              ? 'Click Initialize to create the new slot worktrees.'
              : 'Click Delete to tear down the extra slot worktrees and their parking branches.'}
        </p>
      )}

      {phase.kind === 'running' && (
        <div className="configure-slots-progress">
          <div className="configure-slots-bar">
            <div
              className="configure-slots-bar-fill"
              style={{ width: `${Math.round((phase.step / phase.total) * 100)}%` }}
            />
          </div>
          <div className="configure-slots-label">{phaseLabel}</div>
        </div>
      )}

      {(phase.kind === 'done' || steps.length > 0) && (
        <ul className="configure-slots-log">
          {steps.map((s) => (
            <li key={`${s.kind}-${s.slotId}`} className={s.ok ? 'ok' : 'err'}>
              <i className={`fa-solid ${s.ok ? 'fa-check' : 'fa-xmark'}`} />
              &nbsp;{s.kind === 'init' ? 'Init' : 'Delete'} slot {s.slotId}
              {s.message ? <span className="mono">&nbsp;— {s.message}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <div className="configure-slots-foot">
        {phase.kind === 'ready' && (
          <>
            <button className="btn" onClick={onDone}>Cancel</button>
            <span style={{ flex: 1 }} />
            <button className="btn primary" onClick={() => void start()}>
              {plan.length === 0
                ? 'Apply'
                : plan[0]?.kind === 'init' ? 'Initialize' : 'Delete'}
            </button>
          </>
        )}
        {phase.kind === 'blocked' && (
          <>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={onDone}>Close</button>
          </>
        )}
        {phase.kind === 'done' && (
          <>
            <span style={{ flex: 1 }} />
            <button className="btn primary" onClick={onDone}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}

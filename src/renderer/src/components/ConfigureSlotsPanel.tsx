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
import { useTranslation } from '../lib/i18n';

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
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: 'preflight' });
  const [steps, setSteps] = useState<StepRecord[]>([]);

  const adds = Math.max(0, targetCount - currentCount);
  const removes = Math.max(0, currentCount - targetCount);

  // Plan: remove any slots beyond the new target (shrink, highest-first), then
  // INIT every target slot. Init-all (not just newly-added) makes re-running a
  // repair pass — a slot that has a clone but no workspace gets picked up,
  // while already-set-up slots are skipped fast by the init handler. So
  // "expand to 8 again" fills in whatever's missing.
  const plan: Array<{ slotId: number; kind: 'init' | 'delete' }> = (() => {
    const out: Array<{ slotId: number; kind: 'init' | 'delete' }> = [];
    for (let i = currentCount; i > targetCount; i--) out.push({ slotId: i, kind: 'delete' });
    for (let i = 1; i <= targetCount; i++) out.push({ slotId: i, kind: 'init' });
    return out;
  })();

  /* Pre-flight check on mount. */
  useEffect(() => {
    void (async () => {
      if (repo.mode !== ('slots' as RepoWorktreeMode)) {
        setPhase({ kind: 'blocked', reason: 'wrong-mode', occupants: [] });
        return;
      }
      let occupants: Array<{ slotId: number; chatName: string }> = [];
      try {
        occupants = await window.popbot.repos.listSlotOccupants(repo.id);
      } catch {
        // Don't leave the panel stuck on "checking…" with no button if the
        // occupancy probe fails — proceed (the per-slot ops re-check anyway).
        setPhase({ kind: 'ready' });
        return;
      }
      // Only slots we're about to DELETE matter — a grow adds new slots above
      // the current range and never touches a live chat's workspace, so it
      // must not be blocked by open chats. A shrink is blocked only if one of
      // the slots being removed is currently held.
      const deleting = new Set(plan.filter((p) => p.kind === 'delete').map((p) => p.slotId));
      const blocking = occupants.filter((o) => deleting.has(o.slotId));
      if (blocking.length > 0) {
        setPhase({ kind: 'blocked', reason: 'occupied', occupants: blocking });
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

    // GROW: the new slots' shado clones don't exist yet, and `shado clone
    // create` is privileged — create + mount them in ONE elevated batch (one
    // UAC) BEFORE the per-slot init loop, which then just attaches p4/git.
    if (targetCount > currentCount) {
      setPhase({ kind: 'running', step: 0, total, current: null });
      const prep = await window.popbot.repos.prepareGrow(repo.id, targetCount);
      if (!prep.ok) {
        setSteps([{ slotId: currentCount + 1, kind: 'init', ok: false, message: prep.message }]);
        setPhase({ kind: 'done', ok: false });
        return;
      }
    }

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
        ? (res.alreadyReady ? t('slots.alreadyReady') : '')
        : ('reason' in res ? res.reason : res.error);
      setSteps((prev) => [...prev, { slotId: step.slotId, kind: step.kind, ok, message }]);
      if (!ok) { allOk = false; break; }
    }
    // Commit the new count only on full success. On a partial failure leave
    // the count as-is — re-running is now an idempotent repair pass that picks
    // up whatever's missing, so there's no need to half-commit.
    if (allOk) {
      await window.popbot.repos.setSlotCount(repo.id, targetCount);
    }
    setPhase({ kind: 'done', ok: allOk });
  };

  const phaseLabel = phase.kind === 'running'
    ? (phase.current?.kind === 'delete'
      ? t('slots.running.deleting', { slotId: phase.current?.slotId ?? '', step: phase.step, total: phase.total })
      : t('slots.running.initializing', { slotId: phase.current?.slotId ?? '', step: phase.step, total: phase.total }))
    : phase.kind === 'done'
      ? (phase.ok ? t('slots.done') : t('slots.stopped'))
      : '';

  return (
    <div className="configure-slots">
      <div className="configure-slots-summary">
        <span className="mono">{repo.id}</span>
        <span className="configure-slots-arrow">{currentCount} → {targetCount}</span>
        <span className="configure-slots-detail">
          {removes > 0
            ? (removes === 1
              ? t('slots.detail.willDelete', { count: removes })
              : t('slots.detail.willDeletePlural', { count: removes }))
            : adds > 0
              ? (adds === 1
                ? t('slots.detail.willCreate', { count: adds })
                : t('slots.detail.willCreatePlural', { count: adds }))
              : t('slots.detail.recheck', { count: targetCount })}
        </span>
      </div>

      {phase.kind === 'preflight' && (
        <p className="pref-section-desc">{t('slots.checkingOccupancy')}</p>
      )}

      {phase.kind === 'blocked' && phase.reason === 'wrong-mode' && (
        <div className="pref-error">{t('slots.blocked.wrongMode')}</div>
      )}

      {phase.kind === 'blocked' && phase.reason === 'occupied' && (
        <div className="pref-warn">
          <strong>{t('slots.blocked.inUseTitle')}</strong> {t('slots.blocked.inUseBody')}
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {phase.occupants.map((o) => (
              <li key={o.slotId}>{t('slots.occupant', { slotId: o.slotId, chatName: o.chatName })}</li>
            ))}
          </ul>
        </div>
      )}

      {phase.kind === 'ready' && (
        <p className="pref-section-desc">
          {plan.length === 0
            ? t('slots.ready.nothing')
            : plan[0]?.kind === 'init'
              ? t('slots.ready.init')
              : t('slots.ready.delete')}
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
              &nbsp;{s.kind === 'init' ? t('slots.log.init') : t('slots.log.delete')} {t('slots.log.slot', { slotId: s.slotId })}
              {s.message ? <span className="mono">&nbsp;— {s.message}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <div className="configure-slots-foot">
        {phase.kind === 'ready' && (
          <>
            <button className="btn" onClick={onDone}>{t('common.cancel')}</button>
            <span style={{ flex: 1 }} />
            <button className="btn primary" onClick={() => void start()}>
              {plan.length === 0
                ? t('slots.btn.apply')
                : plan[0]?.kind === 'init' ? t('slots.btn.initialize') : t('slots.btn.delete')}
            </button>
          </>
        )}
        {phase.kind === 'blocked' && (
          <>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={onDone}>{t('common.close')}</button>
          </>
        )}
        {phase.kind === 'done' && (
          <>
            <span style={{ flex: 1 }} />
            <button className="btn primary" onClick={onDone}>{t('common.done')}</button>
          </>
        )}
      </div>
    </div>
  );
}

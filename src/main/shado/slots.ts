/**
 * Shared shado slot substrate — the copy-on-write storage layer behind
 * BOTH git and Perforce SLOT-mode workspaces. A slot is a shado
 * differencing clone of a frozen per-repo base, mounted at the slot's
 * worktree path; the owning provider layers its VCS semantics on top
 * (git checkout / p4 flush). Ephemeral mode does NOT use this — only the
 * pre-allocated slot pool.
 *
 * Invariants enforced here (the user's workflow rules):
 *   - slot + repo on the SAME drive (VHDX differencing requirement);
 *   - `<base>-N` naming (shado `--slot` = the worktree folder name);
 *   - SHADO_HOME on the repo's drive (base + per-slot diffs live together).
 *
 * shado mutations need an elevated context; a non-elevated call surfaces
 * shado's error (the standing elevated service, pbworkspaced, is future
 * work).
 */
import { existsSync } from 'node:fs';
import { basename, parse } from 'node:path';
import { runShado, shadoHomeForRepo } from './client';

export interface ShadoSlotRef {
  /** shado project (base) name for this repo. */
  baseName: string;
  /** Absolute source-repo path — the slot's drive and SHADO_HOME derive
   *  from it (same-drive invariant). */
  repoPath: string;
  /** Absolute slot mount path. Its basename is the shado slot id. */
  worktreePath: string;
}

function drive(p: string): string {
  return parse(p).root.toLowerCase();
}

/** shado slot id for a worktree: the folder name — `<base>-<n>` when
 *  `slotPrefix` is the base name. */
export function shadoSlotName(worktreePath: string): string {
  return basename(worktreePath);
}

/** Env that pins shado's base + per-slot diffs to the repo's drive. */
function shadoEnv(repoPath: string): { SHADO_HOME: string } {
  return { SHADO_HOME: shadoHomeForRepo(repoPath) };
}

/** Assert the slot sits on the repo's drive (throws otherwise). */
export function assertSameDrive(repoPath: string, worktreePath: string): void {
  if (drive(worktreePath) !== drive(repoPath)) {
    throw new Error(
      `Slot must be on the same drive as its repo (slot ${worktreePath}, repo ${repoPath})`,
    );
  }
}

/** Create + mount a COW slot clone off the repo's frozen base. Idempotent:
 *  if the mount already exists the existing slot is kept. */
export async function ensureSlot(ref: ShadoSlotRef): Promise<void> {
  assertSameDrive(ref.repoPath, ref.worktreePath);
  const slot = shadoSlotName(ref.worktreePath);
  const r = await runShado(
    ['clone', 'create', '--name', ref.baseName, '--slot', slot, '--mount', ref.worktreePath],
    { env: shadoEnv(ref.repoPath) },
  );
  if (!r.ok && !existsSync(ref.worktreePath)) {
    throw new Error(`shado clone create failed for slot ${slot}: ${r.stderr || r.stdout}`);
  }
}

/** Reset a slot to a clean base — destroy + recreate its differencing
 *  child (instant clean slate). */
export async function resetSlot(ref: ShadoSlotRef): Promise<void> {
  const slot = shadoSlotName(ref.worktreePath);
  const r = await runShado(['clone', 'reset', '--name', ref.baseName, '--slot', slot], {
    env: shadoEnv(ref.repoPath),
  });
  if (!r.ok) throw new Error(`shado clone reset failed for slot ${slot}: ${r.stderr || r.stdout}`);
}

/** Destroy a slot's COW clone (teardown). Leaves the frozen base intact. */
export async function removeSlot(ref: ShadoSlotRef): Promise<void> {
  const slot = shadoSlotName(ref.worktreePath);
  const r = await runShado(['clone', 'rm', '--name', ref.baseName, '--slot', slot, '--force'], {
    env: shadoEnv(ref.repoPath),
  });
  if (!r.ok) throw new Error(`shado clone rm failed for slot ${slot}: ${r.stderr || r.stdout}`);
}

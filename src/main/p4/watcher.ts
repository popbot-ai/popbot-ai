/**
 * Per-slot filesystem watcher — the bridge that makes Perforce behave like
 * git.
 *
 * Perforce only tracks files you explicitly `p4 edit`/`add`/`delete`, but a
 * PopBot agent edits files freely (like git) and `p4 reconcile` is a
 * 20-minute tree walk on a game depot — unusable. Instead we watch the slot
 * mount with a single recursive `fs.watch` (ReadDirectoryChangesW on
 * Windows, FSEvents on macOS) and record the exact changed path + kind.
 * The PerforceProvider then opens just those files with targeted
 * `p4 edit/add/delete` — never a reconcile — so `p4 opened` reflects the
 * working tree the way `git status` does.
 *
 * Paths are stored worktree-relative, which under the `p4-init` client view
 * equals the provider's path key (`depot/...`), so the provider can map a
 * change straight to `//<path>`.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

export type ChangeKind = 'modify' | 'add' | 'delete';
export interface SlotChange {
  /** Worktree-relative path (forward slashes), = the provider path key. */
  path: string;
  kind: ChangeKind;
}

interface SlotState {
  watcher: FSWatcher;
  /** path → kind (latest wins, with add+delete cancelling out). */
  changes: Map<string, ChangeKind>;
}

const slots = new Map<string, SlotState>();

/** Paths never worth opening in Perforce — VCS/tooling metadata and the
 *  derived/cache dirs a `.p4ignore` would exclude. */
const IGNORE = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.p4(config|ignore|root|tickets|trust)/i,
  /(^|\/)\.popbot-p4\.json$/,
  /(^|\/)(Intermediate|Saved|DerivedDataCache|Library|Binaries|\.vs|node_modules|\.shado)(\/|$)/i,
];

function ignored(rel: string): boolean {
  return IGNORE.some((re) => re.test(rel));
}

function record(state: SlotState, wt: string, rel: string): void {
  if (!rel || ignored(rel)) return;
  const exists = existsSync(join(wt, rel));
  const prev = state.changes.get(rel);
  if (!exists) {
    // Disappeared. A file created then deleted within the session nets to
    // nothing; an existing file deleted is a real delete.
    if (prev === 'add') state.changes.delete(rel);
    else state.changes.set(rel, 'delete');
    return;
  }
  // Present. Keep an 'add' as add; otherwise it's a modify (a delete that
  // came back is a modify of the original).
  state.changes.set(rel, prev === 'add' ? 'add' : prev ? 'modify' : detectAddOrModify(rel, prev));
}

// First time we see a path and it exists, we can't be 100% sure it's new vs
// modified from the watch alone; treat first-sight as 'modify' (the provider
// upgrades to add via `p4 add` failing→already-tracked is cheap). A future
// refinement can seed the have-list to distinguish.
function detectAddOrModify(_rel: string, _prev: ChangeKind | undefined): ChangeKind {
  return 'modify';
}

/** Start watching a slot mount (idempotent). */
export function startSlotWatch(worktreePath: string): void {
  if (slots.has(worktreePath) || !existsSync(worktreePath)) return;
  const state: SlotState = { watcher: undefined as unknown as FSWatcher, changes: new Map() };
  const w = watch(worktreePath, { recursive: true }, (_event, filename) => {
    if (filename == null) return;
    const rel = filename.toString().split('\\').join('/');
    record(state, worktreePath, rel);
  });
  w.on('error', () => {
    // The handle died (e.g. the VHDX volume unmounted). Drop the entry so a
    // later startSlotWatch() re-establishes it instead of silently no-op'ing
    // because the map still holds a dead watcher.
    try {
      w.close();
    } catch {
      /* already closed */
    }
    if (slots.get(worktreePath)?.watcher === w) slots.delete(worktreePath);
  });
  state.watcher = w;
  slots.set(worktreePath, state);
}

/** Stop watching a slot and drop its accumulated changes. */
export function stopSlotWatch(worktreePath: string): void {
  const s = slots.get(worktreePath);
  if (!s) return;
  try {
    s.watcher.close();
  } catch {
    /* already closed */
  }
  slots.delete(worktreePath);
}

/** Changes seen since the watch started (or last clear). */
export function getSlotChanges(worktreePath: string): SlotChange[] {
  const s = slots.get(worktreePath);
  if (!s) return [];
  return [...s.changes.entries()].map(([path, kind]) => ({ path, kind }));
}

/** Cheap dirty flag — true if the agent has touched anything. */
export function isSlotDirty(worktreePath: string): boolean {
  const s = slots.get(worktreePath);
  return !!s && s.changes.size > 0;
}

/** Forget accumulated changes (after submit/revert opens them in p4). */
export function clearSlotChanges(worktreePath: string): void {
  slots.get(worktreePath)?.changes.clear();
}

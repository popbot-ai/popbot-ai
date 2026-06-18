/**
 * Domain types shared between main and renderer.
 * Pure data; no behavior.
 */

/**
 * Status values are kept terse to match the prototype CSS class names
 * (`.status-run`, `.status-done`, etc.) and the existing fixtures.
 *
 * - `idle` — no agent attached / no work in flight
 * - `run`  — agent is actively producing output
 * - `wait` — agent paused for user (permission request, clarifying question)
 * - `err`  — last session ended in error
 * - `done` — task complete
 */
export type ChatStatus = 'idle' | 'run' | 'wait' | 'err' | 'done';

export type SlotState = 'free' | 'leased' | 'degraded' | 'creating';

export interface Slot {
  id: number;
  worktreePath: string;
  branch: string | null;
  ports: { mcp: number; server: number };
  unityPid: number | null;
  serverPid: number | null;
  state: SlotState;
  pinnedBranch?: string;
  cleanOnRelease?: boolean;
}

/**
 * Linear types shared between main and renderer. Keep these distinct
 * from the on-the-wire `LinearIssue` shape in `main/linear/client.ts`
 * — main does any normalization before crossing the IPC boundary.
 */

export interface LinearIssueDto {
  id: string;
  identifier: string;
  title: string;
  /** Markdown description from Linear. May be empty. */
  description: string | null;
  url: string;
  /** Linear native priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low. */
  priority: number;
  state: {
    name: string;
    /** Linear workflow type bucket — triage/backlog/unstarted/started/completed/canceled. */
    type: string;
    /** Hex color set on the workflow state in Linear (e.g. "#f2c94c"). */
    color: string;
    /** Sort position within the team's workflow — lower = earlier. */
    position: number;
  };
  /** Team the issue lives in — needed to fetch the workflow states
   *  available for this issue's status picker. */
  team: { id: string; key: string };
  project: { name: string } | null;
  updatedAt: string;
}

export interface LinearWorkflowStateDto {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
}

export type LinearTestResult =
  | { ok: true; email: string; name: string }
  | { ok: false; error: 'auth' | string };

export interface LinearProjectDto {
  id: string;
  name: string;
  /** Linear project state: 'planned' | 'started' | 'paused' | … */
  state: string;
  teamKeys: string[];
}

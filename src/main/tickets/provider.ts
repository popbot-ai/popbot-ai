/**
 * The ticket-source abstraction at the main-process boundary.
 *
 * The Tickets queue is provider-agnostic: the renderer always calls the
 * same `window.popbot.linear.*` channels (the name is historical — Linear
 * was the first tracker) and never branches on the provider id, only on
 * the capabilities advertised in `shared/ticketProvider.ts`. Main routes
 * each call to the active `TicketSource` (see `registry.ts`), and every
 * implementation normalizes its data into the shared Linear DTOs so the
 * renderer renders all trackers through one path.
 *
 * Each tracker lives in its own module (`linearSource.ts`, `jiraSource.ts`,
 * `githubSource.ts`) and implements this interface; `ipc/tickets.ts` is a
 * thin layer that registers the IPC channels and delegates here.
 */

import type { LinearIssueDto, LinearWorkflowStateDto } from '@shared/linear';
import type { TicketProviderId } from '@shared/ticketProvider';

/** List endpoints (`listMyIssues` / `listRecentIssues`) share this shape.
 *  `notConfigured` → the tracker has no credentials yet; `authFailed` →
 *  credentials present but rejected; `error` → anything else. */
export interface TicketListResult {
  issues: LinearIssueDto[];
  notConfigured?: boolean;
  authFailed?: boolean;
  error?: string;
}

/** Single-issue fetch result (the manual-pin flow on PanelA). */
export type TicketGetResult =
  | { ok: true; issue: LinearIssueDto }
  | { ok: false; reason: 'not-found' | 'not-configured' | 'auth-failed' | 'error'; error?: string };

/** Available workflow states for the per-issue status picker. */
export interface TicketStatesResult {
  states: LinearWorkflowStateDto[];
  notConfigured?: boolean;
  authFailed?: boolean;
  error?: string;
}

/** Result of moving an issue to a new workflow state. */
export type TicketSetStateResult =
  | { ok: true; stateName: string | null }
  | { ok: false; reason: string };

/** Result of the idempotent promote-to-In-Progress on chat spawn.
 *  `promoted: false` is a deliberate no-op (already started, or the
 *  provider has no such state), distinct from `ok: false` (a failure). */
export type TicketPromoteResult =
  | { ok: true; promoted: boolean; stateName?: string }
  | { ok: false; reason: string };

/**
 * A source of tickets for the queue. Implementations:
 *   - normalize to the shared Linear DTOs (so the renderer is uniform), and
 *   - honor their declared capabilities (`shared/ticketProvider.ts`): a
 *     provider with `changeStatus: false` returns empty states and a
 *     `reason: 'unsupported'` from `setIssueState`; one with
 *     `promoteOnSpawn: false` returns `{ promoted: false }`.
 */
export interface TicketSource {
  readonly id: TicketProviderId;
  /** The current user's active/assigned issues — the queue's main list. */
  listMyIssues(): Promise<TicketListResult>;
  /** Recent issues (any assignee) for the WorkItemSearch cache. */
  listRecentIssues(sinceIso: string): Promise<TicketListResult>;
  /** One issue by its identifier, for the manual-pin flow. */
  getIssue(identifier: string): Promise<TicketGetResult>;
  /** Workflow states available for an issue's status picker. */
  listStates(teamId: string): Promise<TicketStatesResult>;
  /** Move an issue to a new workflow state. */
  setIssueState(issueId: string, stateId: string): Promise<TicketSetStateResult>;
  /** Idempotently promote a freshly-spawned ticket to "In Progress". */
  promoteIssue(identifier: string): Promise<TicketPromoteResult>;
}

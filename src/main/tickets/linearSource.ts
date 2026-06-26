/**
 * Linear ticket source. Wraps `main/linear/client.ts` and normalizes its
 * responses into the shared `TicketSource` result shapes. Linear supports
 * every optional capability (status changes, projects, priority,
 * promote-on-spawn), so all methods are fully implemented here.
 *
 * The two config/verification helpers (`testLinear`, `listLinearProjects`)
 * are Linear-specific and take draft credentials from the Preferences form
 * — they're not part of the `TicketSource` queue-data interface.
 */

import type { LinearProjectDto, LinearTestResult } from '@shared/linear';
import {
  LinearAuthError,
  fetchIssueByIdentifier,
  fetchIssueDtoByIdentifier,
  fetchMyIssues,
  fetchProjects,
  fetchRecentIssues,
  fetchViewer,
  fetchWorkflowStates,
  updateIssueState,
} from '../linear/client';
import { dlog } from '../diagLog';
import { getSetting } from '../persistence/settings';
import type {
  TicketGetResult,
  TicketListResult,
  TicketPromoteResult,
  TicketSetStateResult,
  TicketSource,
  TicketStatesResult,
} from './provider';

interface LinearSettings {
  apiKey?: string;
  teamKey?: string;
  projectId?: string;
}

function settings(): LinearSettings {
  return getSetting<LinearSettings>('linear') ?? {};
}

export const linearSource: TicketSource = {
  id: 'linear',

  async listMyIssues(): Promise<TicketListResult> {
    const s = settings();
    if (!s.apiKey) return { issues: [], notConfigured: true };
    try {
      const issues = await fetchMyIssues({
        apiKey: s.apiKey,
        teamKey: s.teamKey,
        projectId: s.projectId,
      });
      return { issues };
    } catch (err) {
      if (err instanceof LinearAuthError) return { issues: [], authFailed: true };
      return { issues: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  async listRecentIssues(sinceIso: string): Promise<TicketListResult> {
    const s = settings();
    if (!s.apiKey) return { issues: [], notConfigured: true };
    try {
      const issues = await fetchRecentIssues({ apiKey: s.apiKey, teamKey: s.teamKey, sinceIso });
      return { issues };
    } catch (err) {
      if (err instanceof LinearAuthError) return { issues: [], authFailed: true };
      return { issues: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  async getIssue(identifier: string): Promise<TicketGetResult> {
    const s = settings();
    if (!s.apiKey) return { ok: false, reason: 'not-configured' };
    try {
      const issue = await fetchIssueDtoByIdentifier({ apiKey: s.apiKey, identifier });
      if (!issue) return { ok: false, reason: 'not-found' };
      return { ok: true, issue };
    } catch (err) {
      if (err instanceof LinearAuthError) return { ok: false, reason: 'auth-failed' };
      return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },

  async listStates(teamId: string): Promise<TicketStatesResult> {
    const s = settings();
    if (!s.apiKey) return { states: [], notConfigured: true };
    try {
      const states = await fetchWorkflowStates({ apiKey: s.apiKey, teamId });
      return { states };
    } catch (err) {
      if (err instanceof LinearAuthError) return { states: [], authFailed: true };
      return { states: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  async setIssueState(issueId: string, stateId: string): Promise<TicketSetStateResult> {
    const s = settings();
    if (!s.apiKey) return { ok: false, reason: 'not-configured' };
    try {
      const r = await updateIssueState({ apiKey: s.apiKey, issueId, stateId });
      if (!r.success) return { ok: false, reason: 'rejected' };
      return { ok: true, stateName: r.stateName };
    } catch (err) {
      if (err instanceof LinearAuthError) return { ok: false, reason: 'auth' };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },

  /** Idempotently promote a ticket to "In Progress" when a chat is spawned
   *  for it. Only acts on upstream (backlog/triage/unstarted) states; the
   *  "In Progress" target is found heuristically (a `started`-type state
   *  matching /in.?progress/i, else the first `started` state by position).
   *  Returns `{ promoted: false }` for deliberate no-ops. */
  async promoteIssue(identifier: string): Promise<TicketPromoteResult> {
    const s = settings();
    if (!s.apiKey) return { ok: false, reason: 'not-configured' };
    try {
      const issue = await fetchIssueByIdentifier({ apiKey: s.apiKey, identifier });
      if (!issue) {
        dlog('linear.promote.not-found', { identifier });
        return { ok: false, reason: 'not-found' };
      }
      const upstream = new Set(['backlog', 'triage', 'unstarted']);
      if (!upstream.has(issue.state.type)) {
        dlog('linear.promote.skipped', {
          identifier,
          stateType: issue.state.type,
          stateName: issue.state.name,
          reason: 'not-upstream',
        });
        return { ok: true, promoted: false, stateName: issue.state.name };
      }
      const states = await fetchWorkflowStates({ apiKey: s.apiKey, teamId: issue.team.id });
      const started = states.filter((st) => st.type === 'started');
      const target = started.find((st) => /in.?progress/i.test(st.name)) ?? started[0];
      if (!target) {
        dlog('linear.promote.no-target', { identifier, teamKey: issue.team.key });
        return { ok: false, reason: 'no-in-progress-state' };
      }
      const r = await updateIssueState({ apiKey: s.apiKey, issueId: issue.id, stateId: target.id });
      if (!r.success) {
        dlog('linear.promote.rejected', { identifier, targetStateId: target.id });
        return { ok: false, reason: 'rejected' };
      }
      dlog('linear.promote.ok', { identifier, from: issue.state.name, to: r.stateName ?? target.name });
      return { ok: true, promoted: true, stateName: r.stateName ?? target.name };
    } catch (err) {
      if (err instanceof LinearAuthError) return { ok: false, reason: 'auth' };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ---- Linear-specific Preferences-form helpers ----------------------------
// These take draft credentials (the form hasn't persisted them yet), unlike
// the queue-data methods above which read the saved `linear` settings.

/** Verify an API key by hitting `viewer`. Used by the Save button so we
 *  don't persist a bad key. */
export async function testLinear(apiKey: string): Promise<LinearTestResult> {
  try {
    const viewer = await fetchViewer(apiKey);
    return { ok: true, email: viewer.email, name: viewer.name };
  } catch (err) {
    if (err instanceof LinearAuthError) return { ok: false, error: 'auth' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** List active projects, optionally filtered by team. The renderer passes
 *  its in-flight `apiKey` when configuring a draft key; falls back to the
 *  saved one. Feeds the project picker in Preferences. */
export async function listLinearProjects(opts: { apiKey?: string; teamKey?: string }): Promise<{
  projects: LinearProjectDto[];
  notConfigured?: boolean;
  authFailed?: boolean;
  error?: string;
}> {
  const s = settings();
  const apiKey = (opts.apiKey?.trim() || s.apiKey || '').trim();
  if (!apiKey) return { projects: [], notConfigured: true };
  const teamKey = opts.teamKey?.trim() || s.teamKey || '';
  try {
    const raw = await fetchProjects({ apiKey, teamKey });
    const projects: LinearProjectDto[] = raw.map((p) => ({
      id: p.id,
      name: p.name,
      state: p.state,
      teamKeys: p.teams.nodes.map((t) => t.key),
    }));
    return { projects };
  } catch (err) {
    if (err instanceof LinearAuthError) return { projects: [], authFailed: true };
    return { projects: [], error: err instanceof Error ? err.message : String(err) };
  }
}

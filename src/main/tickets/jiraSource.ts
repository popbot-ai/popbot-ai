/**
 * Jira ticket source. Wraps `main/jira/client.ts`, which already normalizes
 * Jira Cloud REST responses into the shared Linear DTOs. Jira issue *keys*
 * play the role of Linear's `identifier`, and per-issue transitions stand
 * in for workflow states (the issue key is stashed in `team.id`; see the
 * client for the full mapping rationale).
 *
 * The queue-data methods read the saved `jira` settings. The two config
 * helpers (`testJira`, `listJiraProjects`) take draft credentials from the
 * Preferences form.
 */

import type { LinearProjectDto, LinearTestResult } from '@shared/linear';
import type { JiraSettings } from '@shared/ticketProvider';
import {
  JiraAuthError,
  resolveConn,
  fetchViewer,
  fetchMyIssues,
  fetchRecentIssues,
  fetchIssueByKey,
  fetchTransitions,
  transitionIssue,
  fetchProjects,
  promoteIssue as jiraPromoteIssue,
} from '../jira/client';
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

function settings(): JiraSettings {
  return getSetting<JiraSettings>('jira') ?? {};
}

export const jiraSource: TicketSource = {
  id: 'jira',

  async listMyIssues(): Promise<TicketListResult> {
    const s = settings();
    if (!resolveConn(s)) return { issues: [], notConfigured: true };
    try {
      return { issues: await fetchMyIssues(s) };
    } catch (err) {
      if (err instanceof JiraAuthError) return { issues: [], authFailed: true };
      return { issues: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  async listRecentIssues(sinceIso: string): Promise<TicketListResult> {
    const s = settings();
    if (!resolveConn(s)) return { issues: [], notConfigured: true };
    try {
      return { issues: await fetchRecentIssues(s, sinceIso) };
    } catch (err) {
      if (err instanceof JiraAuthError) return { issues: [], authFailed: true };
      return { issues: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  async getIssue(identifier: string): Promise<TicketGetResult> {
    const s = settings();
    if (!resolveConn(s)) return { ok: false, reason: 'not-configured' };
    try {
      const issue = await fetchIssueByKey(s, identifier);
      if (!issue) return { ok: false, reason: 'not-found' };
      return { ok: true, issue };
    } catch (err) {
      if (err instanceof JiraAuthError) return { ok: false, reason: 'auth-failed' };
      return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },

  async listStates(teamId: string): Promise<TicketStatesResult> {
    // `teamId` carries the issue key (see jira/client.ts); "states" are the
    // issue's available transitions.
    const s = settings();
    if (!resolveConn(s)) return { states: [], notConfigured: true };
    try {
      return { states: await fetchTransitions(s, teamId) };
    } catch (err) {
      if (err instanceof JiraAuthError) return { states: [], authFailed: true };
      return { states: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  async setIssueState(issueId: string, stateId: string): Promise<TicketSetStateResult> {
    // `issueId` is the Jira issue key; `stateId` is a transition id.
    const s = settings();
    if (!resolveConn(s)) return { ok: false, reason: 'not-configured' };
    try {
      const r = await transitionIssue(s, issueId, stateId);
      if (!r.success) return { ok: false, reason: 'rejected' };
      return { ok: true, stateName: r.stateName };
    } catch (err) {
      if (err instanceof JiraAuthError) return { ok: false, reason: 'auth' };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },

  async promoteIssue(identifier: string): Promise<TicketPromoteResult> {
    const s = settings();
    if (!resolveConn(s)) return { ok: false, reason: 'not-configured' };
    try {
      const r = await jiraPromoteIssue(s, identifier);
      if (!r.promoted && r.reason) {
        dlog('jira.promote.skipped', { identifier, reason: r.reason });
        if (r.reason === 'not-found') return { ok: false, reason: 'not-found' };
        if (r.reason === 'no-in-progress-state') return { ok: false, reason: 'no-in-progress-state' };
      }
      const result: { ok: true; promoted: boolean; stateName?: string } = {
        ok: true,
        promoted: r.promoted,
      };
      if (r.stateName !== undefined) result.stateName = r.stateName;
      return result;
    } catch (err) {
      if (err instanceof JiraAuthError) return { ok: false, reason: 'auth' };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ---- Jira-specific Preferences-form helpers ------------------------------

/** Verify draft Jira credentials by hitting `myself`. Same result shape as
 *  `testLinear` so the Preferences forms share status rendering. */
export async function testJira(draft: JiraSettings): Promise<LinearTestResult> {
  if (!resolveConn(draft)) {
    // Distinguish "incomplete" from "present but rejected by the URL
    // constraints" (non-HTTPS or non-*.atlassian.net), since resolveConn
    // returns null for both.
    const hasAllFields =
      !!draft.baseUrl?.trim() && !!draft.email?.trim() && !!draft.apiToken?.trim();
    return {
      ok: false,
      error: hasAllFields
        ? 'Site URL must be an https://<your-site>.atlassian.net address'
        : 'Missing base URL, email, or API token',
    };
  }
  try {
    const viewer = await fetchViewer(draft);
    return { ok: true, email: viewer.email, name: viewer.name };
  } catch (err) {
    if (err instanceof JiraAuthError) return { ok: false, error: 'auth' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** List Jira projects for the supplied draft credentials. */
export async function listJiraProjects(draft: JiraSettings): Promise<{
  projects: LinearProjectDto[];
  notConfigured?: boolean;
  authFailed?: boolean;
  error?: string;
}> {
  if (!resolveConn(draft)) return { projects: [], notConfigured: true };
  try {
    return { projects: await fetchProjects(draft) };
  } catch (err) {
    if (err instanceof JiraAuthError) return { projects: [], authFailed: true };
    return { projects: [], error: err instanceof Error ? err.message : String(err) };
  }
}

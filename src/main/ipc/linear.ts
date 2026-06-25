import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type {
  LinearIssueDto,
  LinearProjectDto,
  LinearTestResult,
  LinearWorkflowStateDto,
} from '@shared/linear';
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
import {
  JiraAuthError,
  resolveConn as resolveJiraConn,
  fetchViewer as jiraFetchViewer,
  fetchMyIssues as jiraFetchMyIssues,
  fetchRecentIssues as jiraFetchRecentIssues,
  fetchIssueByKey as jiraFetchIssueByKey,
  fetchTransitions as jiraFetchTransitions,
  transitionIssue as jiraTransitionIssue,
  fetchProjects as jiraFetchProjects,
  promoteIssue as jiraPromoteIssue,
} from '../jira/client';
import type { JiraSettings, TicketProviderId } from '@shared/ticketProvider';
import { dlog } from '../diagLog';
import { getSetting } from '../persistence/settings';

interface LinearSettings {
  apiKey?: string;
  teamKey?: string;
  projectId?: string;
}

/** Which tracker feeds the Tickets queue. Defaults to Linear. The six
 *  ticket data channels below are provider-agnostic and dispatch on this;
 *  the Jira client normalizes to the same DTOs the renderer renders for
 *  Linear, so no renderer branching is needed. */
function activeTicketSource(): TicketProviderId {
  return getSetting<string>('ticketSource') === 'jira' ? 'jira' : 'linear';
}

function jiraSettings(): JiraSettings {
  return getSetting<JiraSettings>('jira') ?? {};
}

interface PanelASearchSettings {
  /** Days back covered by the WorkItemSearch cache pull. Defaults to 30. */
  recentDays?: number;
}

const DEFAULT_SEARCH_DAYS = 30;
const MAX_SEARCH_DAYS = 365;

function searchSinceIso(): string {
  const cfg = getSetting<PanelASearchSettings>('panela.search') ?? {};
  const days = Math.max(1, Math.min(MAX_SEARCH_DAYS, Math.floor(cfg.recentDays ?? DEFAULT_SEARCH_DAYS)));
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

export function registerLinearHandlers(): void {
  /** Verify an API key by hitting `viewer`. Used by the Save button so
   *  we don't persist a bad key. Settings is *not* updated here. */
  ipcMain.handle(IpcChannel.LinearTest, async (_e, apiKey: string): Promise<LinearTestResult> => {
    try {
      const viewer = await fetchViewer(apiKey);
      return { ok: true, email: viewer.email, name: viewer.name };
    } catch (err) {
      if (err instanceof LinearAuthError) return { ok: false, error: 'auth' };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** List the current user's active issues using the saved API key.
   *  Returns [] (with `notConfigured: true`) when no key is saved. */
  ipcMain.handle(IpcChannel.LinearListIssues, async (): Promise<{
    issues: LinearIssueDto[];
    notConfigured?: boolean;
    authFailed?: boolean;
    error?: string;
  }> => {
    if (activeTicketSource() === 'jira') {
      const s = jiraSettings();
      if (!resolveJiraConn(s)) return { issues: [], notConfigured: true };
      try {
        return { issues: await jiraFetchMyIssues(s) };
      } catch (err) {
        if (err instanceof JiraAuthError) return { issues: [], authFailed: true };
        return { issues: [], error: err instanceof Error ? err.message : String(err) };
      }
    }
    const settings = getSetting<LinearSettings>('linear') ?? {};
    if (!settings.apiKey) return { issues: [], notConfigured: true };
    try {
      const issues = await fetchMyIssues({
        apiKey: settings.apiKey,
        teamKey: settings.teamKey,
        projectId: settings.projectId,
      });
      return { issues };
    } catch (err) {
      if (err instanceof LinearAuthError) return { issues: [], authFailed: true };
      return { issues: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** List active projects, optionally filtered by team. The renderer
   *  passes its in-flight `apiKey` (when the user is configuring a
   *  draft key in Preferences); falls back to the saved one. */
  /** Recent-issues pull for the WorkItemSearch cache. Honors the
   *  configured team filter; ignores assignee. Returns the same DTO
   *  shape as the assigned-issues list so the picker can dedup +
   *  render rows uniformly. */
  ipcMain.handle(IpcChannel.LinearListRecent, async (): Promise<{
    issues: LinearIssueDto[];
    notConfigured?: boolean;
    authFailed?: boolean;
    error?: string;
  }> => {
    if (activeTicketSource() === 'jira') {
      const s = jiraSettings();
      if (!resolveJiraConn(s)) return { issues: [], notConfigured: true };
      try {
        return { issues: await jiraFetchRecentIssues(s, searchSinceIso()) };
      } catch (err) {
        if (err instanceof JiraAuthError) return { issues: [], authFailed: true };
        return { issues: [], error: err instanceof Error ? err.message : String(err) };
      }
    }
    const settings = getSetting<LinearSettings>('linear') ?? {};
    if (!settings.apiKey) return { issues: [], notConfigured: true };
    try {
      const issues = await fetchRecentIssues({
        apiKey: settings.apiKey,
        teamKey: settings.teamKey,
        sinceIso: searchSinceIso(),
      });
      return { issues };
    } catch (err) {
      if (err instanceof LinearAuthError) return { issues: [], authFailed: true };
      return { issues: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Single-issue fetch by identifier, used by the manual-pin flow on
   *  PanelA. Wraps `fetchIssueDtoByIdentifier` + maps to the same
   *  result shape as the list endpoint so the renderer can treat
   *  pinned rows just like auto-fetched rows. */
  ipcMain.handle(IpcChannel.LinearGetIssue, async (_e, identifier: string): Promise<
    | { ok: true; issue: LinearIssueDto }
    | { ok: false; reason: 'not-found' | 'not-configured' | 'auth-failed' | 'error'; error?: string }
  > => {
    if (activeTicketSource() === 'jira') {
      const s = jiraSettings();
      if (!resolveJiraConn(s)) return { ok: false, reason: 'not-configured' };
      try {
        const issue = await jiraFetchIssueByKey(s, identifier);
        if (!issue) return { ok: false, reason: 'not-found' };
        return { ok: true, issue };
      } catch (err) {
        if (err instanceof JiraAuthError) return { ok: false, reason: 'auth-failed' };
        return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    }
    const settings = getSetting<LinearSettings>('linear') ?? {};
    if (!settings.apiKey) return { ok: false, reason: 'not-configured' };
    try {
      const issue = await fetchIssueDtoByIdentifier({
        apiKey: settings.apiKey,
        identifier,
      });
      if (!issue) return { ok: false, reason: 'not-found' };
      return { ok: true, issue };
    } catch (err) {
      if (err instanceof LinearAuthError) return { ok: false, reason: 'auth-failed' };
      return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IpcChannel.LinearListProjects, async (
    _e,
    opts: { apiKey?: string; teamKey?: string },
  ): Promise<{
    projects: LinearProjectDto[];
    notConfigured?: boolean;
    authFailed?: boolean;
    error?: string;
  }> => {
    const settings = getSetting<LinearSettings>('linear') ?? {};
    const apiKey = (opts.apiKey?.trim() || settings.apiKey || '').trim();
    if (!apiKey) return { projects: [], notConfigured: true };
    const teamKey = opts.teamKey?.trim() || settings.teamKey || '';
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
  });

  /** Workflow states for a team — feeds the per-issue status picker. */
  ipcMain.handle(IpcChannel.LinearListStates, async (_e, teamId: string): Promise<{
    states: LinearWorkflowStateDto[];
    notConfigured?: boolean;
    authFailed?: boolean;
    error?: string;
  }> => {
    if (activeTicketSource() === 'jira') {
      // For Jira, `teamId` carries the issue key (see jira/client.ts) and
      // "states" are the issue's available transitions.
      const s = jiraSettings();
      if (!resolveJiraConn(s)) return { states: [], notConfigured: true };
      try {
        return { states: await jiraFetchTransitions(s, teamId) };
      } catch (err) {
        if (err instanceof JiraAuthError) return { states: [], authFailed: true };
        return { states: [], error: err instanceof Error ? err.message : String(err) };
      }
    }
    const settings = getSetting<LinearSettings>('linear') ?? {};
    if (!settings.apiKey) return { states: [], notConfigured: true };
    try {
      const states = await fetchWorkflowStates({ apiKey: settings.apiKey, teamId });
      return { states };
    } catch (err) {
      if (err instanceof LinearAuthError) return { states: [], authFailed: true };
      return { states: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Move an issue to a new workflow state. */
  ipcMain.handle(IpcChannel.LinearSetIssueState, async (
    _e,
    issueId: string,
    stateId: string,
  ): Promise<{ ok: true; stateName: string | null } | { ok: false; reason: string }> => {
    if (activeTicketSource() === 'jira') {
      // `issueId` is the Jira issue key; `stateId` is a transition id.
      const s = jiraSettings();
      if (!resolveJiraConn(s)) return { ok: false, reason: 'not-configured' };
      try {
        const r = await jiraTransitionIssue(s, issueId, stateId);
        if (!r.success) return { ok: false, reason: 'rejected' };
        return { ok: true, stateName: r.stateName };
      } catch (err) {
        if (err instanceof JiraAuthError) return { ok: false, reason: 'auth' };
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    const settings = getSetting<LinearSettings>('linear') ?? {};
    if (!settings.apiKey) return { ok: false, reason: 'not-configured' };
    try {
      const r = await updateIssueState({ apiKey: settings.apiKey, issueId, stateId });
      if (!r.success) return { ok: false, reason: 'rejected' };
      return { ok: true, stateName: r.stateName };
    } catch (err) {
      if (err instanceof LinearAuthError) return { ok: false, reason: 'auth' };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Idempotently promote a ticket to "In Progress" when a chat is
   *  spawned for it. The premise: opening a chat for a ticket means
   *  active dev work has begun, so the workflow status should reflect
   *  that automatically. We only act when the ticket is in an
   *  upstream state (backlog / triage / unstarted); started states
   *  (In Progress, Code Review, Paused, Ready to Test, Ready to
   *  Deploy, …) are left alone, as are completed/canceled states.
   *
   *  The "In Progress" state is found heuristically — a `started`-
   *  type state whose name matches /in.?progress/i. If the team's
   *  workflow doesn't have one, falls back to the first `started`
   *  state by position (Linear's own workflow ordering). If even
   *  that doesn't exist (no started states defined), no-op.
   *
   *  Returns `{ promoted: false }` for a deliberate no-op so the
   *  caller can distinguish "we tried and decided not to" from
   *  "API call failed." */
  ipcMain.handle(IpcChannel.LinearPromoteIssue, async (
    _e,
    identifier: string,
  ): Promise<
    | { ok: true; promoted: boolean; stateName?: string }
    | { ok: false; reason: string }
  > => {
    if (activeTicketSource() === 'jira') {
      const s = jiraSettings();
      if (!resolveJiraConn(s)) return { ok: false, reason: 'not-configured' };
      try {
        const r = await jiraPromoteIssue(s, identifier);
        if (!r.promoted && r.reason) {
          dlog('jira.promote.skipped', { identifier, reason: r.reason });
          if (r.reason === 'not-found') return { ok: false, reason: 'not-found' };
          if (r.reason === 'no-in-progress-state') {
            return { ok: false, reason: 'no-in-progress-state' };
          }
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
    }
    const settings = getSetting<LinearSettings>('linear') ?? {};
    if (!settings.apiKey) return { ok: false, reason: 'not-configured' };
    try {
      const issue = await fetchIssueByIdentifier({ apiKey: settings.apiKey, identifier });
      if (!issue) {
        dlog('linear.promote.not-found', { identifier });
        return { ok: false, reason: 'not-found' };
      }
      // Only promote when it hasn't started yet. Anything else
      // (started, completed, canceled) means the workflow has
      // already moved past or beyond "begin dev work."
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
      const states = await fetchWorkflowStates({ apiKey: settings.apiKey, teamId: issue.team.id });
      const started = states.filter((s) => s.type === 'started');
      const target =
        started.find((s) => /in.?progress/i.test(s.name))
        ?? started[0];
      if (!target) {
        dlog('linear.promote.no-target', { identifier, teamKey: issue.team.key });
        return { ok: false, reason: 'no-in-progress-state' };
      }
      const r = await updateIssueState({ apiKey: settings.apiKey, issueId: issue.id, stateId: target.id });
      if (!r.success) {
        dlog('linear.promote.rejected', { identifier, targetStateId: target.id });
        return { ok: false, reason: 'rejected' };
      }
      dlog('linear.promote.ok', {
        identifier,
        from: issue.state.name,
        to: r.stateName ?? target.name,
      });
      return { ok: true, promoted: true, stateName: r.stateName ?? target.name };
    } catch (err) {
      if (err instanceof LinearAuthError) return { ok: false, reason: 'auth' };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  // ----- Jira-only channels ------------------------------------------------
  // These take draft credentials directly (the Preferences form hasn't
  // persisted them yet), unlike the shared data channels above which read
  // the saved `jira` settings.

  /** Verify draft Jira credentials by hitting `myself`. Same result shape
   *  as LinearTest so the Preferences forms share status rendering. */
  ipcMain.handle(IpcChannel.JiraTest, async (_e, settings: JiraSettings): Promise<LinearTestResult> => {
    if (!resolveJiraConn(settings)) {
      // Distinguish "incomplete" from "present but rejected by the URL
      // constraints" (non-HTTPS or non-*.atlassian.net), since resolveConn
      // returns null for both.
      const hasAllFields =
        !!settings.baseUrl?.trim() && !!settings.email?.trim() && !!settings.apiToken?.trim();
      return {
        ok: false,
        error: hasAllFields
          ? 'Site URL must be an https://<your-site>.atlassian.net address'
          : 'Missing base URL, email, or API token',
      };
    }
    try {
      const viewer = await jiraFetchViewer(settings);
      return { ok: true, email: viewer.email, name: viewer.name };
    } catch (err) {
      if (err instanceof JiraAuthError) return { ok: false, error: 'auth' };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** List Jira projects for the supplied draft credentials. */
  ipcMain.handle(IpcChannel.JiraListProjects, async (_e, settings: JiraSettings): Promise<{
    projects: LinearProjectDto[];
    notConfigured?: boolean;
    authFailed?: boolean;
    error?: string;
  }> => {
    if (!resolveJiraConn(settings)) return { projects: [], notConfigured: true };
    try {
      return { projects: await jiraFetchProjects(settings) };
    } catch (err) {
      if (err instanceof JiraAuthError) return { projects: [], authFailed: true };
      return { projects: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
}

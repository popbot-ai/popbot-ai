/**
 * IPC layer for the Tickets queue. Thin by design: the queue-data channels
 * delegate to the active `TicketSource` (resolved from the `ticketSource`
 * setting), and the provider-specific config/verification channels delegate
 * to each tracker's module.
 *
 * The channels keep their historical `pb:linear:*` names (and the renderer
 * keeps calling `window.popbot.linear.*`) — the names predate multi-tracker
 * support; the role is "the Tickets queue's data path," not "Linear." The
 * per-provider logic lives in `main/tickets/*Source.ts`.
 */

import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { JiraSettings } from '@shared/ticketProvider';
import { getSetting } from '../persistence/settings';
import { activeTicketSource } from '../tickets/registry';
import { listLinearProjects, testLinear } from '../tickets/linearSource';
import { listJiraProjects, testJira } from '../tickets/jiraSource';
import { testGithub } from '../tickets/githubSource';

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

export function registerTicketHandlers(): void {
  // ----- Provider-agnostic queue-data channels ----------------------------
  // Each delegates to the active TicketSource; the source normalizes to the
  // shared Linear DTOs and honors its declared capabilities.

  ipcMain.handle(IpcChannel.LinearListIssues, () => activeTicketSource().listMyIssues());

  ipcMain.handle(IpcChannel.LinearListRecent, () =>
    activeTicketSource().listRecentIssues(searchSinceIso()));

  ipcMain.handle(IpcChannel.LinearGetIssue, (_e, identifier: string) =>
    activeTicketSource().getIssue(identifier));

  ipcMain.handle(IpcChannel.LinearListStates, (_e, teamId: string) =>
    activeTicketSource().listStates(teamId));

  ipcMain.handle(IpcChannel.LinearSetIssueState, (_e, issueId: string, stateId: string) =>
    activeTicketSource().setIssueState(issueId, stateId));

  ipcMain.handle(IpcChannel.LinearPromoteIssue, (_e, identifier: string) =>
    activeTicketSource().promoteIssue(identifier));

  // ----- Provider-specific config / verification channels -----------------
  // These take draft credentials from the Preferences forms (not yet saved),
  // so they target one tracker explicitly rather than the active source.

  /** Verify a draft Linear API key. */
  ipcMain.handle(IpcChannel.LinearTest, (_e, apiKey: string) => testLinear(apiKey));

  /** List Linear projects (draft or saved key) for the project picker. */
  ipcMain.handle(IpcChannel.LinearListProjects, (_e, opts: { apiKey?: string; teamKey?: string }) =>
    listLinearProjects(opts ?? {}));

  /** Verify draft Jira Cloud credentials. */
  ipcMain.handle(IpcChannel.JiraTest, (_e, settings: JiraSettings) => testJira(settings));

  /** List Jira projects for the supplied draft credentials. */
  ipcMain.handle(IpcChannel.JiraListProjects, (_e, settings: JiraSettings) => listJiraProjects(settings));

  /** Verify the `gh` CLI is installed + authenticated and report the repo
   *  span. GitHub has no credentials to enter, so this takes no args. */
  ipcMain.handle(IpcChannel.GithubTest, () => testGithub());
}

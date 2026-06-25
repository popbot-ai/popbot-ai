/**
 * GitHub Issues ticket source. Wraps `main/github/client.ts`, which shells
 * out to the `gh` CLI across the user's configured repos and normalizes
 * issues into the shared Linear DTOs.
 *
 * GitHub Issues advertise every optional capability as OFF
 * (`shared/ticketProvider.ts`): no workflow states (only open/closed), no
 * native priority, no project scoping, no promote-on-spawn. So the
 * status/promote methods here are deliberate no-ops — the renderer hides
 * the picker and skips promotion via capability feature-detection, and
 * these guards keep the contract safe even if something calls them anyway.
 *
 * There are no credentials to enter: auth is the same `gh` login used by
 * the Reviews tab. `testGithub` reports whether `gh` is installed +
 * authenticated and how many configured repos the queue will span.
 */

import type { GithubSettings, GithubTestResult } from '@shared/ticketProvider';
import {
  GithubAuthError,
  GithubCliMissingError,
  GithubNoRepoError,
  checkAuth,
  fetchIssueByIdentifier,
  fetchMyIssues,
  fetchRecentIssues,
} from '../github/client';
import { getSetting } from '../persistence/settings';
import type {
  TicketGetResult,
  TicketListResult,
  TicketPromoteResult,
  TicketSetStateResult,
  TicketSource,
  TicketStatesResult,
} from './provider';

function settings(): GithubSettings {
  return getSetting<GithubSettings>('github') ?? {};
}

/** The `gh` CLI replaces an API key, so "not authenticated" and "gh not
 *  installed" both surface as `authFailed` — the renderer's reconnect
 *  affordance points at the GitHub Preferences form, which explains setup. */
function listError(err: unknown): TicketListResult {
  // No resolvable repo means GitHub is selected but not set up — surface it
  // as `notConfigured` so the renderer prompts to add/fix a repo instead of
  // showing an empty queue or a scary error.
  if (err instanceof GithubNoRepoError) {
    return { issues: [], notConfigured: true };
  }
  if (err instanceof GithubAuthError || err instanceof GithubCliMissingError) {
    return { issues: [], authFailed: true };
  }
  return { issues: [], error: err instanceof Error ? err.message : String(err) };
}

export const githubSource: TicketSource = {
  id: 'github',

  async listMyIssues(): Promise<TicketListResult> {
    try {
      return { issues: await fetchMyIssues(settings()) };
    } catch (err) {
      return listError(err);
    }
  },

  async listRecentIssues(sinceIso: string): Promise<TicketListResult> {
    try {
      return { issues: await fetchRecentIssues(settings(), sinceIso) };
    } catch (err) {
      return listError(err);
    }
  },

  async getIssue(identifier: string): Promise<TicketGetResult> {
    try {
      const issue = await fetchIssueByIdentifier(identifier);
      if (!issue) return { ok: false, reason: 'not-found' };
      return { ok: true, issue };
    } catch (err) {
      if (err instanceof GithubNoRepoError) {
        return { ok: false, reason: 'not-configured' };
      }
      if (err instanceof GithubAuthError || err instanceof GithubCliMissingError) {
        return { ok: false, reason: 'auth-failed' };
      }
      return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },

  // GitHub Issues have no workflow states (changeStatus capability is off);
  // the renderer hides the picker. Return empty defensively.
  async listStates(): Promise<TicketStatesResult> {
    return { states: [] };
  },

  async setIssueState(): Promise<TicketSetStateResult> {
    return { ok: false, reason: 'unsupported' };
  },

  // No "In Progress" state to move to (promoteOnSpawn capability is off).
  // The spawn flow fires this unconditionally, so return a benign no-op.
  async promoteIssue(): Promise<TicketPromoteResult> {
    return { ok: true, promoted: false };
  },
};

// ---- GitHub-specific Preferences-form helper -----------------------------

/** Verify the `gh` CLI is installed + authenticated and report the repo
 *  span. Feeds the GitHub Preferences form's status line. */
export async function testGithub(): Promise<GithubTestResult> {
  return checkAuth();
}

/**
 * Ticket-source provider abstraction — DESIGN SCAFFOLD.
 *
 * Jira is "roughed in" here but not yet implemented or exposed (gated by
 * `JIRA_ENABLED` in PreferencesSheet). The intent, for when we build it:
 *
 *   - Every provider (Linear, Jira, …) implements one GENERAL API that the
 *     Tickets queue depends on (list issues, get issue, spawn-from-ticket).
 *   - Each provider advertises OPTIONAL capabilities. The UI feature-detects
 *     these and only renders a provider-specific affordance when supported —
 *     code should branch on CAPABILITIES, never on the provider id.
 *
 * This keeps "the most popular tracker" (Jira) addable without special-casing
 * it throughout the renderer.
 */

export type TicketProviderId = 'linear' | 'jira';

/** Optional capabilities a provider may support. The UI queries these
 *  before showing the matching affordance (e.g. the inline status picker). */
export interface TicketProviderCapabilities {
  /** Change an issue's status from PopBot — Linear workflow states /
   *  Jira transitions. Gates the inline status picker. */
  changeStatus: boolean;
  /** Scope the ticket list to a project. Gates the project filter. */
  projectFilter: boolean;
  /** Orderable priority on issues. Gates priority grouping in the queue. */
  priority: boolean;
  /** Promote an issue to "in progress" automatically on chat spawn. */
  promoteOnSpawn: boolean;
}

/** Static descriptor — drives the Tracker selector + capability gating
 *  without instantiating a client. */
export interface TicketProviderMeta {
  id: TicketProviderId;
  label: string;
  capabilities: TicketProviderCapabilities;
}

export const TICKET_PROVIDERS: Record<TicketProviderId, TicketProviderMeta> = {
  linear: {
    id: 'linear',
    label: 'Linear',
    capabilities: { changeStatus: true, projectFilter: true, priority: true, promoteOnSpawn: true },
  },
  jira: {
    id: 'jira',
    label: 'Jira',
    // Conservative placeholder — confirm/adjust when the Jira client lands.
    capabilities: { changeStatus: true, projectFilter: true, priority: true, promoteOnSpawn: false },
  },
};

/**
 * Jira Cloud connection settings (rough-in). Auth is HTTP Basic with an
 * Atlassian account email + API token (created at id.atlassian.com →
 * Security → API tokens). `jql` / `projectKey` optionally narrow the queue.
 */
export interface JiraSettings {
  /** e.g. `https://your-domain.atlassian.net`. */
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  /** Optional JQL to scope the ticket list beyond the default filter. */
  jql?: string;
  /** Optional project key (e.g. `ENG`) to scope the list. */
  projectKey?: string;
}

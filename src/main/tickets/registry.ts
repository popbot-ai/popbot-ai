/**
 * Resolves which `TicketSource` feeds the Tickets queue, based on the
 * `ticketSource` setting. Defaults to Linear. Adding a tracker is a single
 * line here plus its `*Source.ts` module and a `shared/ticketProvider.ts`
 * descriptor — no change to the IPC layer or the renderer.
 */

import { getSetting } from '../persistence/settings';
import { githubSource } from './githubSource';
import { jiraSource } from './jiraSource';
import { linearSource } from './linearSource';
import type { TicketSource } from './provider';

const SOURCES: Record<string, TicketSource> = {
  linear: linearSource,
  jira: jiraSource,
  github: githubSource,
};

/** The active ticket source. Unknown / unset values fall back to Linear. */
export function activeTicketSource(): TicketSource {
  const id = getSetting<string>('ticketSource') ?? 'linear';
  return SOURCES[id] ?? linearSource;
}

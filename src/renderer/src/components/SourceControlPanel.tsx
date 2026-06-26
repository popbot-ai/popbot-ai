/**
 * Source-control panel — BASE CONTRACT + DISPATCHER (renderer).
 *
 * The renderer analogue of the main-side `SourceControlProvider` base
 * class. Git and Perforce don't present the same way (WIP/commit/diff vs.
 * changelists + Swarm), so rather than one component branching on the
 * provider id everywhere, we define:
 *
 *   1. {@link SourceControlPanelProps} — the COMMON contract every
 *      provider panel implements (which chat drives it, diff-overlay
 *      handlers, close). `GitPanel` implements this; a future
 *      `PerforcePanel` / `LorePanel` implements the same shape.
 *   2. {@link SourceControlPanel} — the dispatcher. It feature-detects
 *      the repo's provider capabilities and renders the matching panel:
 *      providers with `capabilities.nativeClientUi` get their own client
 *      window; everyone else gets the built-in git-shaped sidebar.
 *
 * Today git is the only implemented provider, so this resolves to
 * `GitPanel` — but the seam is where Perforce/Lore panels plug in
 * without touching App.tsx.
 */
import type { GitScope } from '@shared/git';
import {
  SOURCE_CONTROL_PROVIDERS,
  DEFAULT_SOURCE_CONTROL,
  type SourceControlProviderId,
} from '@shared/sourceControl';
import { GitPanel } from './GitPanel';
import { P4Panel } from './P4Panel';

/** Common props every provider panel accepts. New panels implement this
 *  shape so the dispatcher can swap them without per-call wiring. */
export interface SourceControlPanelProps {
  /** Chat whose working copy drives this panel; null hides the contents. */
  chatId: string | null;
  /** Display name for the empty state (e.g. when no chat is focused). */
  chatName?: string;
  /** Ticket id for prompt template substitution (may be null). */
  chatTicket?: string | null;
  /** Slot number, surfaced as `${slot}` in templates. */
  chatSlot?: number | null;
  /** Repo this chat lives in — also selects the provider. */
  chatRepoId?: string | null;
  onClose: () => void;
  /** Path of the file currently shown in the persistent diff overlay. */
  diffPath: string | null;
  /** Open or refresh the diff overlay with a new file. */
  onOpenDiff: (scope: GitScope, path: string) => void;
  /** Close the diff overlay (used when scope changes / panel closes). */
  onCloseDiff: () => void;
}

/** Props for the dispatcher: the common panel props plus the provider to
 *  render for. Callers that don't yet track per-repo SCM can omit
 *  `providerId` and get the git default. */
export interface SourceControlPanelDispatchProps extends SourceControlPanelProps {
  /** Which provider backs the focused repo. Defaults to git. */
  providerId?: SourceControlProviderId | null;
}

export function SourceControlPanel({
  providerId,
  ...panelProps
}: SourceControlPanelDispatchProps): JSX.Element {
  const id = providerId ?? DEFAULT_SOURCE_CONTROL;
  const meta = SOURCE_CONTROL_PROVIDERS[id] ?? SOURCE_CONTROL_PROVIDERS[DEFAULT_SOURCE_CONTROL];

  // Providers whose model is too divergent for the git sidebar render
  // their own dedicated panel (Perforce → a separate P4Panel with
  // changelists + Swarm; Lore → its own panel). None are implemented
  // yet, so we fall through to the git sidebar; this is the single place
  // to add them.
  if (meta.capabilities.nativeClientUi) {
    if (id === 'perforce') return <P4Panel {...panelProps} />;
    // case 'lore': return <LorePanel {...panelProps} />;  // not implemented
    // Lore not implemented yet — fall through to the git sidebar so the
    // panel is never blank.
    return <GitPanel {...panelProps} />;
  }

  return <GitPanel {...panelProps} />;
}

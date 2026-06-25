/**
 * Source-control provider registry.
 *
 * Single entry point the rest of main uses to get "the provider for this
 * repo" instead of importing git functions directly. Selection is by the
 * repo's `scm` field (defaulting to git for back-compat). Git is the only
 * provider wired today; Perforce / Lore are roughed-in scaffolds (see
 * `@shared/sourceControl`) and throw a clear error until their concrete
 * class lands — they're never returned because the UI gates them on
 * `meta.implemented`.
 */
import type { RepoRecord } from '@shared/persistence';
import {
  DEFAULT_SOURCE_CONTROL,
  SOURCE_CONTROL_PROVIDERS,
  type SourceControlProviderId,
} from '@shared/sourceControl';
import type { SourceControlProvider } from './provider';
import { GitProvider } from './gitProvider';

export class SourceControlNotImplementedError extends Error {
  constructor(public providerId: SourceControlProviderId) {
    super(`Source-control provider "${providerId}" is not implemented yet`);
    this.name = 'SourceControlNotImplementedError';
  }
}

// Providers are stateless (all ops take explicit paths), so one shared
// instance per id is enough.
const instances: Partial<Record<SourceControlProviderId, SourceControlProvider>> = {};

function instantiate(id: SourceControlProviderId): SourceControlProvider {
  switch (id) {
    case 'git':
      return new GitProvider();
    case 'perforce':
    case 'lore':
      // Roughed-in only. Once a concrete class exists, construct it here.
      throw new SourceControlNotImplementedError(id);
    default: {
      // Exhaustiveness guard — a new id must be handled above.
      const _never: never = id;
      throw new SourceControlNotImplementedError(_never);
    }
  }
}

/** Resolve a provider id from a repo / explicit id / nothing. */
export function sourceControlIdFor(
  arg?: RepoRecord | SourceControlProviderId | null,
): SourceControlProviderId {
  if (!arg) return DEFAULT_SOURCE_CONTROL;
  if (typeof arg === 'string') return arg;
  return arg.scm ?? DEFAULT_SOURCE_CONTROL;
}

/**
 * The {@link SourceControlProvider} backing a repo. Accepts a RepoRecord,
 * an explicit provider id, or nothing (→ git). Memoized per id.
 */
export function getSourceControlProvider(
  arg?: RepoRecord | SourceControlProviderId | null,
): SourceControlProvider {
  const id = sourceControlIdFor(arg);
  return (instances[id] ??= instantiate(id));
}

/** Provider metadata (label + capabilities) without instantiating. */
export function sourceControlMeta(arg?: RepoRecord | SourceControlProviderId | null) {
  return SOURCE_CONTROL_PROVIDERS[sourceControlIdFor(arg)];
}

export { SourceControlProvider } from './provider';
export type {
  ScmStatus,
  ScmFileDiff,
  ScmDetectPrResult,
  EphemeralSlugOpts,
} from './provider';
// Re-export so callers that need an `instanceof` check (worktree-failed
// error classification) don't reach into the git module directly.
export { GitWorktreeError } from '../git/worktrees';

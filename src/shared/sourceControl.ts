/**
 * Source-control provider abstraction — DESIGN SCAFFOLD.
 *
 * Git is the only provider implemented today. Perforce and Lore are
 * "roughed in" here so the rest of the app can be written against ONE
 * general API instead of hard-coding `git` everywhere. The intent:
 *
 *   - Every provider (Git, Perforce, Lore, …) implements one GENERAL
 *     surface that the slot/worktree system + git sidebar depend on
 *     (workspace lifecycle, status/diff/commit/revert, base refs, PR
 *     detection). The concrete class lives in `src/main/scm/*`.
 *   - Each provider advertises OPTIONAL capabilities. The UI (and some
 *     main-side flows) feature-detect these and only render / attempt a
 *     provider-specific affordance when supported — code should branch
 *     on CAPABILITIES, never on the provider id.
 *
 * Git and Perforce do NOT work the same way (commits vs. changelists,
 * branches/worktrees vs. streams/client-workspaces, PRs vs. Swarm
 * reviews, stash vs. shelve). So the model is two-layered:
 *
 *   1. A SMALL COMMON SURFACE that genuinely maps across providers —
 *      open/tear-down a per-chat working copy, status, diff a file,
 *      commit/submit, revert. This is the abstract base class in
 *      `src/main/scm/provider.ts`; the generic git sidebar drives it.
 *   2. PROVIDER-SPECIFIC behavior that does NOT abstract cleanly. The
 *      app branches on capabilities, and a provider whose model is too
 *      divergent (Perforce) opts into its OWN dedicated source-control
 *      client window via `nativeClientUi` instead of being forced into
 *      the git-shaped sidebar.
 *
 * This keeps Perforce ("the studio standard") and Lore addable without
 * special-casing them throughout the worktree + review code.
 */

export type SourceControlProviderId = 'git' | 'perforce' | 'lore';

/** Optional capabilities a provider may support. Callers query these
 *  before showing the matching affordance or attempting an operation. */
export interface SourceControlCapabilities {
  /** Each chat gets its own isolated working copy (git worktree /
   *  Perforce client / Lore checkout). Gates slot + ephemeral worktree
   *  allocation. Without this the chat runs against a shared checkout. */
  worktrees: boolean;
  /** Chats live on their own branch/stream forked from a base.
   *  Gates the base-branch picker and parking-branch lifecycle. */
  branches: boolean;
  /** Uncommitted work can be set aside across close/reopen (git stash /
   *  Perforce shelve). Gates the "stash vs discard" close prompt. */
  stash: boolean;
  /** Pull/merge requests (or reviews) can be detected and surfaced.
   *  Gates the PR chip + `detectPr`. */
  pullRequests: boolean;
  /** Provider can enumerate candidate base refs to fork a chat from.
   *  Gates the base-branch list query. */
  baseRefSelection: boolean;
  /** The provider's working model is too divergent for the generic
   *  git-shaped sidebar, so it ships its OWN dedicated source-control
   *  client window/panel (e.g. Perforce changelists + Swarm). When true
   *  the renderer routes to the provider panel instead of the built-in
   *  WIP/commit sidebar. */
  nativeClientUi: boolean;
  /** Supports the `ephemeral` worktree mode (a throwaway working copy
   *  per chat, torn down on close). Git does; Perforce does NOT (its
   *  client workspaces are heavyweight + long-lived), so the repo
   *  wizard must hide/disable the ephemeral option for those providers
   *  and `chats:create` must refuse it. Gates `RepoWorktreeMode`. */
  supportsEphemeralRepos: boolean;
}

/** Static descriptor — drives any provider selector + capability gating
 *  without instantiating a client. */
export interface SourceControlProviderMeta {
  id: SourceControlProviderId;
  label: string;
  capabilities: SourceControlCapabilities;
  /** False while a provider is only roughed-in (no concrete class yet),
   *  so the UI can hide it from selectors. */
  implemented: boolean;
  /** Prompt-template substitutions for THIS version control system, spread
   *  into the start-* templates so the wording matches the backend instead of
   *  presuming git. A flat key/value map so new VCS can add their own terms
   *  without touching the renderer (e.g. `scm`, `scmnoun`, `commitverb`). */
  promptVars: Record<string, string>;
}

export const SOURCE_CONTROL_PROVIDERS: Record<SourceControlProviderId, SourceControlProviderMeta> = {
  git: {
    id: 'git',
    label: 'Git',
    capabilities: {
      worktrees: true,
      branches: true,
      stash: true,
      pullRequests: true,
      baseRefSelection: true,
      // Git uses the built-in WIP/commit sidebar — the generic surface.
      nativeClientUi: false,
      supportsEphemeralRepos: true,
    },
    implemented: true,
    promptVars: { scm: 'Git', scmnoun: 'branch', commitverb: 'commit' },
  },
  perforce: {
    id: 'perforce',
    label: 'Perforce',
    // Conservative placeholder — confirm/adjust when the Perforce client
    // lands. Perforce isolates via client workspaces (worktree-like) and
    // shelves changelists (stash-like); reviews come from Swarm. Streams
    // map loosely onto "branches".
    capabilities: {
      worktrees: true,
      branches: true,
      stash: true,
      // Helix Swarm reviews surface in the Reviews panel via the Perforce
      // provider's listPendingReviews (Swarm REST). Per-changelist detectPr
      // is still a no-op; the panel + manual "+" pin are the live paths.
      pullRequests: true,
      baseRefSelection: true,
      // Changelists + Swarm don't fit the git sidebar — Perforce gets its
      // own client window.
      nativeClientUi: true,
      // Perforce client workspaces are heavyweight + long-lived; no
      // throwaway-per-chat ephemeral mode.
      supportsEphemeralRepos: false,
    },
    implemented: true,
    promptVars: { scm: 'Perforce', scmnoun: 'changelist', commitverb: 'submit the changelist' },
  },
  lore: {
    id: 'lore',
    label: 'Lore',
    // Conservative placeholder — Lore's working model is still TBD. Start
    // with everything off so no affordance is offered until the client
    // proves the capability.
    capabilities: {
      worktrees: false,
      branches: false,
      stash: false,
      pullRequests: false,
      baseRefSelection: false,
      // Likely a bespoke panel once the model firms up.
      nativeClientUi: true,
      supportsEphemeralRepos: false,
    },
    implemented: false,
    promptVars: { scm: 'Lore', scmnoun: 'change', commitverb: 'save' },
  },
};

/** The provider used when a repo predates the `scm` field — every
 *  existing install is git today. */
export const DEFAULT_SOURCE_CONTROL: SourceControlProviderId = 'git';

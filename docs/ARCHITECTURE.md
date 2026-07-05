# Architecture

A practical map of the Electron process model and where each subsystem lives. For "why," see [POPBOT_DESIGN.md](POPBOT_DESIGN.md). For the **object graph + lifecycles + ownership rules** that everything in this doc hangs off of, see [CORE_MODEL.md](CORE_MODEL.md) — read that first if anything below feels unmotivated.

## Process model

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node)                                         │
│  ─ Slot / worktree lifecycle — git worktrees or shado VHDX slots,    │
│    per-SCM clone/client setup, branch/changelist switching           │
│  ─ SCM provider registry — git + perforce behind one abstraction;    │
│    callers branch on CAPABILITIES, not provider id                   │
│  ─ Agent host — Claude AND Codex backends behind AgentBackend        │
│    (one session per chat); the canUseTool policy boundary            │
│  ─ Editor launcher + per-slot MCP glue — focus/launch Unity/Unreal/  │
│    custom editors; hand the agent its slot's editor MCP HTTP URL     │
│  ─ PTY manager — a persistent terminal per chat                      │
│  ─ Persistence — better-sqlite3 (transcripts, chat/slot/repo state,  │
│    prefs, SDK + Codex session caches)                                │
│  ─ External APIs — tickets (Linear / Jira / GitHub), reviews         │
│    (GitHub PRs / Helix Swarm), Slack, Sentry                         │
└────────┬─────────────────────────────────────────────────────────────┘
         │ contextBridge (typed IPC channels, `window.popbot.*`)
┌────────▼─────────────────────────────────────────────────────────────┐
│ Renderer (Chromium + React + Tailwind)                               │
│  ─ App shell, panels, chat columns, settings sheets, modals          │
│  ─ Subscribes to agent event streams over IPC                        │
│  ─ Sends user actions (approve permission, send message, ...) back   │
│  ─ Owns nothing the main process needs to recover after a renderer   │
│    crash; renderer is a view layer                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**Rule:** the renderer never touches the file system, never spawns child processes, never holds canonical state. All of that is main. The renderer subscribes to events and dispatches intents.

## Source layout

```text
src/
├── main/                       # Electron main process — Node, no DOM
│   ├── index.ts                # entry; createWindow, app lifecycle, handler wiring
│   ├── ipc/                    # typed IPC handlers, one module per subsystem
│   │                           #   (agent, apps, chats, files, git, notifications,
│   │                           #    repos, reviews, sentry, settings, slack, term, tickets)
│   ├── agents/                 # AgentBackend interface + ClaudeBackend + CodexBackend
│   │                           #   + StubBackend; AgentHost, SDK/Codex session stores,
│   │                           #   CLI probes, recovery
│   ├── scm/                    # source-control provider registry + base class;
│   │                           #   gitProvider, perforceProvider, detect
│   ├── git/                    # git plumbing: worktrees, chat paths, reviews (gh PRs)
│   ├── p4/                     # Perforce: exec, client/workspace, file watcher,
│   │                           #   Swarm client + swarmReviews
│   ├── shado/                  # bundled shado VHDX CLI wrapper: base, slots, client
│   ├── tickets/                # ticket-source registry + linear/jira/github sources
│   ├── reviews/                # provider-agnostic Reviews orchestrator (groups by SCM)
│   ├── linear/                 # Linear API client
│   ├── jira/                   # Jira Cloud API client
│   ├── github/                 # GitHub (`gh` CLI) client
│   ├── slack/                  # Slack client + DM/@mention/channel poller
│   ├── sentry/                 # Sentry client + issue poller
│   ├── notifications/          # in-app notification classify + dispatch
│   ├── term/                   # per-chat PTY manager (node-pty)
│   ├── attachments/            # chat attachment (image/file) retention store
│   ├── persistence/            # better-sqlite3 schema (migrations) + typed queries
│   └── updates/                # electron-updater auto-update + on-demand check
├── preload/
│   └── index.ts                # contextBridge — exposes the typed `window.popbot` API
├── renderer/src/               # React UI
│   ├── main.tsx                # ReactDOM.createRoot mount
│   ├── App.tsx
│   ├── components/             # FLAT dir — panels (PanelA/B/D), chat column, dialogs,
│   │                           #   sheets, git/P4 panels, modals, primitives
│   ├── lib/                    # client-side hooks + buses (useChats, useReviews,
│   │                           #   agentEventBus, …); calls `window.popbot.*`, no Node
│   ├── styles/                 # Tailwind layer + ported styles
│   ├── assets/                 # engine / SCM / notification icons
│   └── fixtures/               # static sample data for dev
└── shared/                     # types/contracts shared across the bridge
    ├── ipc.ts                  # IPC channel names, payload types, the PopBotApi surface
    ├── domain.ts               # Chat/Slot/status enums (pure data)
    ├── agent.ts                # AgentEvent + permission types
    ├── persistence.ts          # ChatRecord/RepoRecord + model/effort ids
    ├── sourceControl.ts        # SCM provider ids + capability flags
    ├── ticketProvider.ts       # ticket provider ids + capabilities
    ├── reviews.ts              # review DTOs (PRs / Swarm)
    ├── gameEngine.ts           # engine ids + per-slot MCP port helpers
    ├── git.ts / perforce.ts    # SCM-specific DTOs
    └── linear.ts / notifications.ts / sentry.ts / slack.ts / updates.ts
```

## IPC contract

All IPC is typed and centralized in [`src/shared/ipc.ts`](../src/shared/ipc.ts) — the `IpcChannel` string map, the request/response payload types, and the `PopBotApi` surface the preload bridge exposes. Conventions:

- **`pb:` prefix** on every channel name, namespaced by subsystem (`pb:chats:create`, `pb:agent:event`, `pb:reviews:list-for`). See the `IpcChannel` const for the full list.
- **Request/response** uses `ipcRenderer.invoke` + `ipcMain.handle`. Returns are typed. Handlers are registered per subsystem from `main/ipc/*` and wired in `main/index.ts`.
- **Push events** (agent stream, PTY data, notifications, update progress, window-maximize) use `webContents.send` + `ipcRenderer.on`. Renderer subscribes; main pushes.
- **No raw IPC in components.** The preload script (`src/preload/index.ts`) exposes the typed `window.popbot.*` bridge; renderer code goes through the hooks/buses in `renderer/src/lib/` (`useChats`, `useReviews`, `agentEventBus`, …) rather than calling `ipcRenderer` directly.

## Slot, in code terms

A slot is not one struct; it's a **numbered lease** (`slot_id`) plus the on-disk
worktree/clone that lease points at. The lease state lives on the chat row
(`chats.slot_id`, `chats.worktree_path` in `persistence/`), and free-slot
computation is a query over open chats holding a slot for the repo — a repo's
pool size is `repos.slot_count`. `shared/domain.ts` carries the small shared
enum plus a legacy `Slot` record:

```ts
export type SlotState = 'free' | 'leased' | 'degraded' | 'creating';

// NOTE: this `Slot` interface is currently unused by the running code
// (only SlotState + ChatStatus are imported). It still names Unity
// specifically; the live model has generalized past that — the editor is
// engine-agnostic (Unity/Unreal/custom) and isn't a supervised child with a
// tracked pid, so treat this shape as legacy, not authoritative.
export interface Slot {
  id: number;
  worktreePath: string;
  branch: string | null;
  ports: { mcp: number; server: number };
  unityPid: number | null;
  serverPid: number | null;
  state: SlotState;
  pinnedBranch?: string;
  cleanOnRelease?: boolean;
}
```

Slot acquire / release / reconcile is spread across `git/worktrees.ts` (git
worktrees), `shado/slots.ts` + `scm/*Provider.ts` (VHDX slots + per-SCM
clone/client setup), and the `ipc/repos.ts` + `ipc/chats.ts` handlers. See
[POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit) for lease
policy, and **Cross-slot continuity** below for how a chat's work follows it
across slots.

## Warm-slot storage: shado VHDX copy-on-write

For AAA-scale trees (0.5–1 TB Perforce game depots) a slot can't be a `git
worktree` or a full checkout — you can't copy the depot N times, and a cold
sync+build is minutes-to-hours. **shado** (bundled Go CLI, sibling repo
`github.com/popbot-ai/shado`, invoked via `main/shado/`) provides the storage
substrate on Windows:

- **Saturate + freeze a base.** `shado create <repoPath>` syncs/copies the repo
  folder into an expandable VHDX, then freezes it **read-only**. The base holds
  the full tree *plus* warm derived state (build caches, `node_modules`,
  `Intermediate/`, `Saved/`, `DerivedDataCache/`, …).
- **Differencing children = slots.** Each slot is a copy-on-write VHDX child off
  the frozen base (`shado clone create --slot N`), mounted via `Mount-VHD` +
  `Add-PartitionAccessPath` at a **mount-point folder** (not a drive letter, so
  we scale past ~20 slots). A fresh, build-ready slot costs seconds and a few GB
  of delta instead of a 1 TB re-sync + cold build. Reset = destroy child +
  recreate from base (instant clean).
- **Layout.** Slots live on the **same drive as the repo** (the VHDX model
  requires it): `<drive>/<homeRel>/popbot/workspaces/<repoId>/<slotPrefix>-N`;
  the base + diffs + slot metadata under `…/workspaces/<repoId>/shado`
  (`SHADO_HOME`). Paths are derived in `main/shado/client.ts`
  (`popbotRootForRepo`, `shadoHomeForRepo`).
- **Elevation.** `shado create` / `clone create` / `remount` / `restore` need
  admin; PopBot runs non-elevated, so they're launched through a single UAC
  (temp `.bat` + `Start-Process -Verb RunAs`). Elevated-created clones end up
  owned by the Administrators group → git gets `-c safe.directory=*` per
  invocation, and p4 clients are host-locked.
- **Reboot.** VHDX mounts don't survive a reboot (detached clones + broken
  mount-point reparse folders). On launch we detect disconnected slot repos and
  surface a **center modal** ("Reconnect") the user clicks — one UAC re-mounts
  all of them (`remountReposElevated`). See `main/shado/base.ts`.

The git-worktree path (`repo.mode = 'slots'` on a non-shado repo) still exists
for ordinary repos; shado is selected per-repo for the VHDX/Perforce case.

### Per-SCM slot setup

A slot is an **independent clone/client**, not a shared checkout — this is the
key fact behind cross-slot continuity below.

- **git** (`scm/gitProvider.ts`): the slot is a full clone of the frozen base.
  `ensureSlotWorktree` parks it on `popbot/slot-N`; `checkoutBranch` creates the
  chat branch off the **latest** base (`fetch origin` → `checkout -f -B branch
  origin/<base>` → `clean -fd`), discarding inherited base dirt while keeping
  gitignored warm caches.
- **perforce** (`p4/*`, `scm/perforceProvider.ts`): each slot has its own p4
  client `popbot_<repoId>_slot<N>` rooted at the mount. Setup is `p4 flush
  @baseChangelist` (0-byte have-table update against the frozen base) + `p4 sync`
  of only the base→head delta. There is **no `p4 reconcile`** (a 20-min tree
  walk on a game depot): a per-slot `fs.watch` records changed paths and the
  provider opens just those with targeted `p4 edit/add/delete`. PopBot's own
  writes (sync/revert/unshelve) **pause** the watcher so they aren't re-opened.

## Cross-slot continuity: a chat's branch / changelist home

**Problem.** Because each slot is an independent clone (git) / client
(perforce), a chat's branch or pending changelist lives **only in the slot it
was created in**. Chats borrow slots from a shared pool and can reopen on a
*different* slot — where that work wouldn't exist. (The old `git worktree` model
didn't have this: all worktrees shared one `.git`, so branches were central.)

**Solution.** Consolidate a chat's work to a slot-independent **home** on close
and restore it on reopen. Hooked via `SourceControlProvider.persistChatOnClose`
/ `restoreChatOnReopen`, called from the `ChatsClose` / `ChatsReopen` handlers
(`ipc/chats.ts`), replacing the old slot-local stash. State persisted on the
chat: `chats.p4_shelf_cl` (perforce; git needs none).

- **git → the LOCAL ROOT repo.** The home is `repo.repoPath` — the on-drive repo
  folder every slot was cloned from — added to each slot as a `root` remote
  (`origin` stays the real GitHub remote, for PRs).
  - *Close:* carry uncommitted work as a throwaway `[Soft committed unstaged
    files]` commit (unless the user discarded), then `git push -f root <branch>`.
    The local root accumulates every chat's branch (its branch list = the old
    shared-worktree behavior).
  - *Reopen:* after the base checkout, `git fetch root <branch>` → `checkout -f
    -B branch FETCH_HEAD` → soft-undo the WIP commit so edits return uncommitted.
- **perforce → the ROOT CLIENT as a shelf.** A pending changelist is per-slot,
  so the home is a server-side **shelf** owned by a stable, never-synced per-repo
  client `popbot_<repoId>_root` (`ensureRootClient` — spec only, no sync).
  - *Close:* `p4 shelve` the slot's CL, then `p4 reshelve -f` it onto the chat's
    root-owned CL. **`reshelve` moves shelved content server-side** — verified on
    Helix 2025.2: cross-client, no workspace sync, nothing written to the root's
    disk ("move shelves, don't modify files"). Then delete the slot's shelf +
    opened files + CL, so the slot ends **empty**; the root client owns one
    shelved CL per chat.
  - *Reopen:* `p4 unshelve -s <rootCl> -c <newSlotCl>` into the new slot's fresh
    CL (watcher paused), keeping the root shelf as the parked backup.

Net: slots are interchangeable scratch space; the local-root git repo and the
root p4 client are the durable, user-visible homes for in-flight work.

## Agent backend

`AgentBackend` (`main/agents/types.ts`) is the interface between `AgentHost` and
a concrete backend. **Two real backends ship today** — `ClaudeBackend` (wraps
`@anthropic-ai/claude-agent-sdk`) and `CodexBackend` (wraps `@openai/codex-sdk`)
— plus a `StubBackend` for tests. A chat picks its backend (`chats.agent`) and
can switch; because the two SDKs have different native resume handles, model, and
effort settings, those are persisted **provider-scoped** (Claude's `session_id` +
`claude_model`/`claude_reasoning_effort`; Codex's `codex_thread_id` +
`codex_model`/`codex_reasoning_effort`). `AgentHost` selects the backend, spawns
one session per chat, and re-broadcasts each session's `AgentEvent`s to the
renderer + persistence.

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

Per-slot editor MCP is handed to the backend at spawn: `SpawnOpts.mcpServers`
carries the chat's Unity/Unreal editor endpoint (`{ type: 'http', url }`),
registered in-memory in the SDK options — nothing written to disk. Only the
`mcpHttp`-capable backend consumes it. See **Per-slot editor MCP** below.

The `canUseTool` callback lives next to the backend, not in the agent prompt — it's our hard-veto safety boundary. Rule resolution (`resolveRule`) consults per-chat then global permission rules before prompting. See [adr/0004-canusetool-policy-boundary.md](adr/0004-canusetool-policy-boundary.md).

## Persistence

- **`better-sqlite3`** at `<userData>/popbot.db` (macOS: `~/Library/Application
  Support/PopBot/`; equivalent per-OS `app.getPath('userData')` on Windows /
  Linux). The schema is a numbered migration list in `persistence/db.ts`
  (`user_version`-gated, each step atomic). Current tables:
  - `chats` — one row per chat: slot lease (`slot_id`), `worktree_path`, `repo_id`,
    active `agent`, per-provider model/effort + resume handles (`session_id`,
    `codex_thread_id`), `permission_rules`, and cross-slot state (`p4_shelf_cl`).
  - `messages` — one row per agent event (the durable transcript).
  - `repos` — per-repo config (path, color, slot prefix, default base, slot count,
    `mode` = `slots`/`ephemeral`, `scm`, `p4_config` JSON).
  - `settings` — JSON key/value app prefs (integration credentials-refs, UI prefs).
  - `notifications` — the in-app notification feed.
  - `sdk_session_entries` — Claude SDK SessionStore backing table (chat-keyed;
    PopBot owns the recovery copy so resume doesn't depend on `~/.claude` JSONLs).
  - `codex_thread_events` — durable cache of raw Codex stream events (Codex resumes
    from `~/.codex/sessions`; this is PopBot's own recovery/diagnostic copy).

  There is **no** ticket/PR cache *table*: the Tickets and Reviews queues cache in
  the renderer (see the `list-recent` IPC comments), not SQLite.
- **Per-slot scratch** lives in the slot's worktree/mount and per-chat runtime
  dirs (agent CLI session files, PTY, retained attachments). shado VHDX slots live
  on the repo's drive under `…/popbot/workspaces/<repoId>/…` (see the shado section).
- **Secrets** via `keytar` (OS keychain — macOS Keychain / Windows Credential
  Vault / libsecret). Never in the SQLite DB, never in logs.

## Ticket sources, SCM providers, reviews, editors, updates

Five provider seams the top-level subsystems hang off of — all designed so
adding a backend is local, and callers stay generic:

- **Ticket sources** (`tickets/`). One active `TicketSource` feeds the Tickets
  queue, chosen by the `ticketSource` setting via `tickets/registry.ts` (Linear /
  Jira / GitHub; defaults to Linear). Every source normalizes to the shared Linear
  DTOs, so the renderer renders all trackers through one path and branches only on
  the capabilities in `shared/ticketProvider.ts`, never the provider id. Adding a
  tracker is one line in the registry + a `*Source.ts` + a descriptor.
- **SCM providers** (`scm/provider.ts`, `scm/index.ts`). `SourceControlProvider`
  is the small common surface (workspace lifecycle, working-tree review, PR/review
  detection, cross-slot continuity). `GitProvider` and `PerforceProvider` are real;
  `lore` is roughed-in. `scm/index.ts` returns one instance per id. **Callers branch
  on CAPABILITIES (`shared/sourceControl.ts`), never on the provider id** — anything
  that doesn't abstract cleanly is a capability flag, and a too-divergent provider
  opts into its own client window via `capabilities.nativeClientUi`.
- **Reviews** (`reviews/`, `git/reviews.ts`, `p4/swarmReviews.ts`). A
  provider-agnostic orchestrator groups configured repos by SCM and dispatches to
  each provider's review methods (gated by `capabilities.pullRequests`), merging
  GitHub PRs and Helix Swarm reviews into one panel. Each provider owns its **own
  poll cadence** (`reviewPollIntervalMs` — Swarm slower than GitHub to protect a
  shared p4d), and the panel runs one timer per provider (`pb:reviews:providers` /
  `pb:reviews:list-for`).
- **Per-slot editor MCP** (`ipc/apps.ts`, `shared/gameEngine.ts`). Engines
  (Unity / Unreal / custom) are independently enable-able. When `useMcp` is on, each
  slot's editor is launched with a **per-slot MCP port** (`mcpBasePort + (slotId-1)`)
  so parallel editors don't collide, and `mcpEndpointForChat` hands the agent that
  slot's editor MCP HTTP URL at spawn. Editors are launched **detached** (focus-or-
  launch), not supervised long-lived children.
- **Updates** (`updates/`). electron-updater auto-update with a manual-download
  fallback for unsigned builds, plus an on-demand check for the About dialog
  (`pb:updates:*`).

## Cross-cutting

- **Logging** — main writes diagnostic logs via `diagLog` (`dlog`); the agent CLI
  and PTY carry their own per-chat runtime output; renderer logs route through main
  via IPC.
- **Startup recovery** — recovery is DB- and session-driven, not PID-file based
  (`main/index.ts` boot sequence): `initDb()` runs pending migrations;
  `clearStaleRunningStatuses()` flips any chat left in `run` back to `idle` (a
  previous run's agent session is gone); session-store import + SDK project-dir
  migration + `sessionPinRepair` + `recoverChatSessions` reconcile pinned
  Claude/Codex sessions against what's actually on disk; the CLI probes report
  which backends are online. On Windows, disconnected shado VHDX slots (a reboot
  dropped their mounts) are detected and surfaced for a one-UAC re-mount (see the
  shado **Reboot** note above).
- **Updates** — electron-updater auto-update; see the **Updates** provider above.

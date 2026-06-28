# Architecture

A practical map of the Electron process model and where each subsystem lives. For "why," see [POPBOT_DESIGN.md](POPBOT_DESIGN.md). For the **object graph + lifecycles + ownership rules** that everything in this doc hangs off of, see [CORE_MODEL.md](CORE_MODEL.md) — read that first if anything below feels unmotivated.

## Process model

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node)                                         │
│  ─ Slot manager — git worktrees, Library COW, branch switching       │
│  ─ Process supervisor — spawns Unity + sidecar server per slot       │
│  ─ Agent host — Claude Agent SDK sessions (one per chat)             │
│  ─ MCP client glue — per-slot HTTP MCP endpoint plumbing             │
│  ─ Persistence — better-sqlite3 (transcripts, slot state, prefs)     │
│  ─ Native helper IPC — calls popbot-windowmover for window placement │
│  ─ External APIs — Linear GraphQL, gh GraphQL                        │
└────────┬─────────────────────────────────────────────────────────────┘
         │ contextBridge (typed IPC channels)
┌────────▼─────────────────────────────────────────────────────────────┐
│ Renderer (Chromium + React + Tailwind)                               │
│  ─ App shell, panels, chat columns, settings, modals                 │
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
│   ├── index.ts                # entry; createWindow, app lifecycle
│   ├── ipc/                    # typed IPC handlers (per channel)
│   ├── slots/                  # slot lifecycle: worktree, Library, leases
│   ├── agents/                 # AgentBackend interface + ClaudeBackend impl
│   ├── mcp/                    # MCP client per slot
│   ├── unity/                  # Unity child-process supervision
│   ├── server/                 # sidecar server child-process supervision
│   ├── window/                 # native helper invocations + screen geometry
│   ├── persistence/            # better-sqlite3 schemas + queries
│   ├── linear/                 # Linear GraphQL client
│   ├── github/                 # gh GraphQL client
│   └── slack/                  # Slack OAuth + DM/@mention/channel watcher
├── preload/
│   └── index.ts                # contextBridge exposing typed IPC
├── renderer/                   # React UI
│   ├── index.html
│   ├── main.tsx                # ReactDOM.createRoot mount
│   ├── App.tsx
│   ├── components/             # generic primitives (Button, Tabs, ...)
│   ├── panels/                 # Tickets, Reviews, Chats list, Logs
│   ├── chat/                   # chat column, transcript, composer
│   ├── settings/               # per-chat settings panel + global prefs
│   ├── modals/                 # drift, dial-up, slot reset, etc.
│   ├── styles/                 # Tailwind layer + ported styles.css
│   └── lib/                    # client-side utilities (no Node)
└── shared/                     # types/contracts shared across the bridge
    ├── ipc.ts                  # IPC channel names + payload types
    └── domain.ts               # Chat, Slot, AgentEvent, etc.
```

## IPC contract

All IPC is typed and centralized in [`src/shared/ipc.ts`](../src/shared/ipc.ts) (when scaffold lands). Conventions:

- **`pb:` prefix** on every channel name, namespaced by subsystem (`pb:slot:lease`, `pb:agent:event`, `pb:linear:tickets`).
- **Request/response** uses `ipcRenderer.invoke` + `ipcMain.handle`. Returns are typed.
- **Push events** (agent stream, log tail, slot status) use `webContents.send` + `ipcRenderer.on`. Renderer subscribes; main pushes.
- **No raw IPC in components.** Renderer code calls thin client helpers in `renderer/lib/api.ts` that wrap the `window.popbot.*` bridge.

## Slot, in code terms

A `Slot` (defined in `shared/domain.ts`) is the durable record:

```ts
type Slot = {
  id: number;                       // slot-1, slot-2, ...
  worktreePath: string;             // ~/Library/Application Support/PopBot/slots/slot-N/worktree
  branch: string | null;            // null when detached / unleased
  ports: { mcp: number; server: number };
  unityPid: number | null;
  serverPid: number | null;
  state: 'free' | 'leased' | 'degraded' | 'creating';
  pinnedBranch?: string;
  cleanOnRelease?: boolean;
};
```

The slot manager (`main/slots/`) owns acquire / release / reconcile. See [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit) for lease policy.

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
- **perforce** (`scm/p4/*`, `scm/perforceProvider.ts`): each slot has its own p4
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

`AgentBackend` is the interface; `ClaudeBackend` is the v1 implementation wrapping `@anthropic-ai/claude-agent-sdk`. Defined day-1 so a Codex backend can drop in later.

```ts
interface AgentBackend {
  spawn(opts: SpawnOpts): AgentSession;
  capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
}
```

The `canUseTool` callback lives next to the backend, not in the agent prompt — it's our hard-veto safety boundary. See [adr/0004-canusetool-policy-boundary.md](adr/0004-canusetool-policy-boundary.md).

## Persistence

- **`better-sqlite3`** at `~/Library/Application Support/PopBot/popbot.db`. Schema: `chats`, `messages` (one row per agent event), `slots`, `prefs`, `linear_tickets_cache`, `gh_prs_cache`.
- **Per-slot scratch** at `~/Library/Application Support/PopBot/slots/slot-N/`. Worktree, logs, MCP screenshots, sidecar data dir.
- **Secrets** via `keytar` (macOS Keychain). Never in the SQLite DB, never in logs.

## Cross-cutting

- **Logging** — main writes to `popbot.log`; child processes (Unity, server) get their own log files under their slot dir; renderer logs route through main via IPC.
- **Crash recovery** — on startup, the slot manager scans slot dirs and reconciles `slot.json` against live PIDs; orphans are GC'd, dangling locks released.
- **Update channel** — TBD; see [PHASING.md](PHASING.md) Phase 4.

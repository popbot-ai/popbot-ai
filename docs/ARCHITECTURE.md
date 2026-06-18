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

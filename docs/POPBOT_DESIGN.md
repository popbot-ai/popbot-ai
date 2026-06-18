# PopBot Design

A multi-agent dev orchestrator for AutoRPG. Inspired by Conductor; adds in-game testing infrastructure so agents can launch the actual game, click through it, and verify behavior.

> **Status:** design — locked 2026-05-01. Living document; update in place as we discover during implementation.
>
> **Read this first:** [USER_STORIES.md](USER_STORIES.md) defines the six outcomes this design exists to deliver. When this doc and the user stories disagree, the user stories win and this doc gets updated.

## Goals

1. Run multiple AI dev agents in parallel, each in its own git worktree.
2. Let agents drive the actual game (windowed Unity Editor) for end-to-end testing.
3. Surface ticket / PR / Slack queues, transcript history, logs, and terminals in one window.
4. Default to autonomous operation; pause only on truly blocking events.

## Non-goals (v1)

- Production CI/CD (separate concerns)
- Cross-platform (macOS only; Linux/Windows later if needed)
- Multi-user / SSO (single developer per machine)

## App layout

```text
┌──────────────┬─────────────────────────────────────────────┐
│ Tickets │ PRs│  ┌──┐ ┌──┐ ┌──┐ ┌──┐  Thumbnails (zoom-out)│
│   ENG-...    │  └──┘ └──┘ └──┘ └──┘                       │
│   ENG-...    ├─────────────────────────────────────────────┤
│   ENG-...    │                                             │
├──────────────┤  ┌────────┐  ┌────────┐  ┌────────┐        │
│ Chats        │  │ chat-1 │  │ chat-2 │  │ chat-3 │  + new │
│   live...    │  │        │  │        │  │        │        │
│   ──────     │  │        │  │        │  │        │        │
│   inactive   │  │        │  │        │  │        │        │
│              │  └────────┘  └────────┘  └────────┘        │
├──────────────┴─────────────────────────────────────────────┤
│ Logs ▼  Terminal  ...                                      │
│ [Unity] [Server]   (active chat's streams, sync-scroll)    │
└────────────────────────────────────────────────────────────┘
```

Upper-left tabs: **Tickets** (Linear assigned to me) and **Reviews** (PRs requesting my review). Click a row → spawn a chat seeded for that work.

## Slots — the durable unit

A slot = a git worktree + its Library + (optionally) its running Unity Editor + (optionally) its running sidecar server. **Slots are created rarely, reused continuously.**

### Per-slot directory

```text
~/Library/Application Support/PopBot/slots/
├── slot-1/
│   ├── worktree/                    git worktree (persistent)
│   │   ├── Library/                 ~8 GB, lives here, slot owns it
│   │   ├── Assets/                  ~5.5 GB
│   │   └── ...
│   ├── server-data/                 sidecar's DB (local mode only)
│   ├── ports.json                   { mcp: 17901, server: 5101 }
│   ├── unity.log
│   ├── server.log
│   └── slot.json                    { branch, leasedBy, lastLeaseAt, unityPid?, serverPid? }
└── slot-2/...
```

### Real cost numbers (measured 2026-05-01 on AutoRPG)

| Op | Time |
|---|---|
| `git worktree add` (fresh, 62k files, LFS smudge) | ~23 s |
| Library COW from master (APFS clonefile) | ~1 s |
| First Unity launch on a slot (cold Library) | 1-3 min |
| Sticky hit (Unity already running, idle) | ~50 ms |
| Cold start (Unity off, branch matches) | 15-30 s |
| Branch switch in existing slot (delta + Unity reload) | 5-15 s |
| Slot creation total (worktree add + COW + first import) | ~1-3 min, **rare** |

### Disk budget

~14 GB per slot (8 GB Library + 5.5 GB Assets + scratch). 4 slots = ~55 GB. Shared `.git` (~8 GB) counted once.

### Lease policy

```text
acquire(branch X):
  1. Slot is on X and Unity running        → sticky hit (~50 ms)
  2. Slot is on X and Unity off            → spawn Unity (15-30 s)
  3. X is checked out in another slot      → route to THAT slot
  4. No slot is on X, free LRU slot exists → git checkout X (5-15 s)
  5. All slots busy on other branches      → queue, or evict LRU lease
```

### Branch uniqueness

Git refuses to check out the same branch in two worktrees. Resolved by:
- **Lite / review chats** use detached HEAD (no conflict).
- **Two test chats on the same branch** — second uses temp branch (`<branch>-slot-N`) or detached HEAD; PopBot's scheduler picks automatically.

### Pre-checkout safety

Before any branch switch in an existing slot:

1. `git stash --include-untracked` (always; safety net).
2. Refuse if there are unstaged commits the agent owns; commit first or fail loud.
3. Close any open Unity scenes (avoid GUID resolution issues across branches).
4. `git checkout <branch>`.
5. Pop stash if applicable, or restore from a per-branch stash record.

### Per-slot policy knobs (in prefs)

- `pinnedBranch?` — refuse leases for other branches; primary working slot.
- `cleanOnRelease: bool` — `git clean -fd && git checkout .` on release; default off.
- `autoStashOnSwitch: bool` — default on.

## Resource budgets (independent knobs)

Slots and active Unity instances are **separate budgets**. A slot can exist with its Unity off — it's just storage at that point. Running Unity is RAM-bound and dialable independently.

| Budget | Cost per unit | Default | User pref |
|---|---|---|---|
| **Slot count** (worktrees on disk) | ~14 GB | 2-4 | Prefs: "Slots" |
| **Max active Unity** (running processes) | ~3-4 GB RAM | 2 | Prefs: "Max active Unity" |
| **Hard Unity ceiling** (autonomous-mode auto-approve cap) | — | computed: `floor(systemRAM / 4 GB)` | Prefs: "Unity hard cap" |

### Lease policy (extended)

```text
acquire(branch X):
  1. Find slot for X (sticky / branch-match / LRU).
  2. If slot's Unity is running → use it (~50 ms).
  3. If slot's Unity is off:
     a. active_unity_count < max_active_unity → spawn Unity (15-30 s).
     b. Else: evict LRU idle Unity (other slot) → spawn.
     c. Else: queue OR ask user to dial up.
```

### Agent-initiated dial-up

New MCP tool, available when the agent is blocked on Unity capacity:

| Tool | Mode | Returns |
|---|---|---|
| `request_unity_capacity` | sync | `{ status: "queued" \| "approved" \| "denied", waitJobId? }` |

Behavior:

- **Interactive chat** → chat goes yellow, banner asks user to approve.
- **Autonomous chat** → auto-approve up to `Unity hard cap`; pause for human above that.
- User can also dial up/down preemptively in prefs at any time. Dial-down evicts LRU idle Unitys (never busy ones).

## Chat types

| Type | Slot | Library | Unity | Sidecar | Startup | RAM |
|---|---|---|---|---|---|---|
| **Lite** (review, plan, triage) | optional | — | — | — | ~1-2 s | ~50-100 MB |
| **Client Test** | required | owned by slot | GUI on screen 2 | local or remote | 50ms-30s | ~2-4 GB |
| **Server Test** | required | owned by slot | GUI on screen 2 | local always | 50ms-35s | ~2-5 GB |

Default for new chats: **Lite**. Promote when game testing is actually needed.

## Server modes

Per-chat setting; toggleable on the fly.

| Mode | Server source | Use when |
|---|---|---|
| `local` (default) | `./run_local.sh --port <P> --data-dir <D>` per slot | Everyday agent runs; backend changes; deterministic state |
| `remote-dev` | Shared remote dev server | Pure client iteration; drift detection guards entry |

### Drift detection

Before remote-dev lease accepted: PopBot reads `Assets/Scripts/Simulation/GameDataHash.cs` constant + DTO version locally; GETs `/health` on remote; compares. Mismatch → reject lease with structured error.

### `/health` returns

```jsonc
{
  "ok": true,
  "commit": "abc123",
  "gameDataHash": "0xdeadbeef",
  "dtoVersion": "v17",
  "uptimeSec": 4321
}
```

### Mid-session toggle

User flips `Server Mode` in chat settings; PopBot:

1. Drift check (if entering remote-dev). Refuse on mismatch.
2. Stop / start sidecar process as needed.
3. `client_set_server_endpoint { url }` via MCP — runtime repoint.
4. Force in-game session reset (logout/title) — old auth invalid.
5. Cancel in-flight jobs, banner: "server changed, restart task."

## Per-chat settings panel

| Setting | Default | Notes |
|---|---|---|
| Mode | `Interactive` | `Autonomous` = auto-approve safe, pause on truly stuck |
| Server mode | `local` | `remote-dev` (drift-checked) |
| Window mode | `GUI on screen 2` | `Headless` (later, opt-in) / `Visible` |
| Time scale | `1.0` | Fast-forward animations |
| Game view resolution | `1920×1080` | Pinned for reproducible screenshots |
| Auto-screenshot every action | off | For proof bundles |
| Verbose logs | off | Toggle when debugging the agent itself |
| Agent backend | `claude` | `codex` (Phase 4) |
| Default fixture | none | Boot with a save blob |
| Token budget | `1M` | Pause on hit (autonomous mode) |
| Time budget | `60m` | Pause on hit (autonomous mode) |
| Loop detection | on | Pause on N identical tool calls / no progress for K min |

## Autonomous mode

### Policy engine — plugged into `canUseTool`

Don't bury policy in the prompt; the model can talk itself out of it. Use the SDK's hard-veto hook.

**Auto-approve in autonomous mode (silent):**

- Read / Edit / Write / Grep / Glob inside the slot's worktree
- Bash inside worktree (with deny-list below)
- MCP calls to slot's own MCP server
- Skill / sub-agent invocations
- TodoWrite, internal SDK ops

**Always pause for human (even autonomous):**

- `git push`, `git reset --hard`, `git checkout --`, force-anything, branch deletion
- Anything outside the slot's worktree path
- Network calls to non-allowlisted hosts
- `rm -rf` outside `tmp/` or slot dir
- `gh pr create` and any GitHub publish action
- Slack / email / external messaging
- Modifying `~/.claude`, `.mcp.json`, system config

### "Truly stuck" detection

**Agent self-reports** (via SDK `message_done` shape):

- Clarifying question
- Explicit blocker
- Terminal "I'm done"

**PopBot watches** (defense in depth):

- Loop — N identical tool calls in a row
- Stall — no progress event for K minutes
- Token / time budget exceeded
- Repeated test failures (same failure K times)

### Status colors (chat thumbnail)

| Color | State |
|---|---|
| Blue | Running |
| Green | Task complete |
| Yellow | Paused — needs user |
| Red | Errored |
| Gray | Idle / unstarted |

In autonomous mode you scan thumbnails for **yellow**. Everything else is fine.

## MCP automation surface

### Rule: every tool returns within ~100 ms

Long ops return `{ jobId }` immediately; agent polls. Never block the MCP HTTP listener for >100 ms.

### Job infrastructure

| Tool | Mode | Returns |
|---|---|---|
| `job_status` | sync | `{ status, progress?, message?, startedAt, durationMs }` |
| `job_get_result` | sync | tool's full payload; disposes job |
| `job_cancel` | sync | sets cooperative cancel flag |
| `job_list` | sync | active + recent (TTL ~60s) |

Coroutines run via `EditorCoroutineUtility.StartCoroutineOwnerless`, driven by `EditorApplication.update`. `JobContext` exposes `SetProgress(float, msg)`, `Canceled`, `SetResult(JObject)`, `Fail(error)`.

### Tool catalog — Phase 1 minimum

**Lifecycle:**

- `play_status` (sync), `play_pause` / `play_resume` / `play_step` (sync), `time_scale_set` (sync)
- `play_enter` (job), `play_exit` (sync)
- `editor_quit` (sync)

**Observe:**

- `screenshot` (sync) — writes to `Library/MCP/Screenshots/{session}/{label}.png`, returns path
- `game_state_summary` (sync) — top of screen stack, currencies, level, chapter, equipped, unlocks, last 10 errors
- `screen_stack` (sync), `chapter_status` (sync)
- `ui_tree` (sync) — hierarchy with resolved `text-loc`
- `ui_query` (sync) — CSS-like selectors (`.btn`, `#Confirm`, `[text-loc=Friends.Title]`)

**Act:**

- `ui_click` (sync), `ui_click_by_loc` (sync) — fires `PointerDown/Up/ClickEvent` via `panel.SendEvent`

**Sync / wait:**

- `wait_until` (job) — predicates: `screen`, `log`, `event`, `path`
- `wait_for_idle` (job)

**Logs (extend existing):**

- `console_get_logs` — add `sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack: "none"|"first"|"all"`
- `server_logs` (sync) — tail PopBot's `server.log`, same shape as `console_get_logs`
- `server_health` (sync), `client_set_server_endpoint` (sync)

**Sessions:**

- `mcp_session_start` / `mcp_session_end` — predictable artifact dirs at `tmp/mcp-sessions/{slug}/`

### Tool catalog — later phases

- `command_apply`, `command_list` — primary action surface bypassing UI
- `save_blob_get` / `save_blob_load`, fixture management
- `crash_dump`, `ui_dump_uxml`, `ui_drag`, `events_pop`, `gameview_resolution_set`
- `game_state_path` — reflection-based reader with allowlisted roots

## Window management

Default: GUI Editor with the window placed by a native helper.

**Native macOS window-mover (~50 LOC Swift):**

1. Tight `AXUIElement` polling (50 ms) so the helper grabs the window within ~100 ms of appearance.
2. `setFrame:` to a configured rect on screen 2.
3. `kAXMinimizedAttribute = true` (drop to dock).
4. Don't steal focus.

**Pre-set `EditorPrefs` for window position before launch.** Unity restores last window position on startup, so the *second* launch onward opens already-positioned. First launch flashes briefly (~200 ms); subsequent launches don't.

**User-side one-time setup** (documented in PopBot first-run): `Dock → right-click Unity → Options → Assign To: Desktop X`. macOS routes future Unity windows to that Space automatically. With this set, even the first-launch flash happens on a Space the user isn't looking at.

Per-slot configurable position so multiple Unitys land at predictable spots on screen 2.

**Headless `Window Mode`** is opt-in after batchmode validation passes (Phase 4-ish). Architecture identical; only the launch flag changes.

## Server / Unity pairing protocol

Startup ordering and lifecycle have to be tight or you hit subtle failures.

### Startup sequence (PopBot enforces)

1. Spawn `./run_local.sh --port S --data-dir D`. Tee stdio to `server.log`. Record `server_pid`.
2. Poll `/health` until 200 (with `commit/gameDataHash/dtoVersion`). Timeout 30 s. Failure → kill server, surface error.
3. Write `client-server.json` into worktree pointing at `localhost:S`.
4. Spawn Unity with `POPBOT_MCP_PORT=M`. Record `unity_pid`.
5. Poll `/mcp` until 200. Timeout 60 s. Failure → kill both, surface error.
6. Native window-mover runs.
7. Slot is live; agent can lease.

### Death cascade

- **Server dies mid-session** → PopBot detects via PID liveness + `server_health` 5xx → marks slot degraded → tries one server restart → if that fails, surfaces in chat as red.
- **Unity dies** → server keeps running (server outlives Unity restarts; cheaper). PopBot can spawn a fresh Unity against the same server.
- **Slot release** → server SIGTERM (5 s grace) → SIGKILL → Unity `editor_quit` MCP call → SIGTERM (5 s grace) → SIGKILL.

### Reconciliation on PopBot startup

Scan slot.json files; for any recorded pid, `kill -0 <pid>`; if dead, clean up state and reset slot. Standard orphan-process hygiene.

## Agent integration

### Claude Agent SDK (v1)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = query({
  prompt,
  options: {
    cwd: slot.worktreePath,
    mcpServers: {
      'popbot-unity': { type: 'http', url: `http://localhost:${slot.mcpPort}/mcp` }
    },
    permissionMode: chat.autonomous ? 'acceptEdits' : 'default',
    canUseTool: (tool, args) => popbotPolicy.evaluate(tool, args, chat),
  }
});

for await (const event of session) {
  routeToChatUI(event);
  routeToLogBuffers(event);
  autonomyEngine.observe(event);
}
```

What we get for free: skills, memory, sub-agents, hooks, MCP, permission requests as structured events. **Don't subprocess-scrape `claude` CLI** — fights the SDK for every advanced feature.

### AgentBackend interface (defined day-1; one impl in v1)

```ts
interface AgentBackend {
  spawn(opts: SpawnOpts): AgentSession;
  capabilities: { skills: boolean; memory: boolean; subAgents: boolean; mcpHttp: boolean };
}
interface AgentSession {
  sendUser(text: string): void;
  approve(permId: string, decision: 'allow' | 'deny'): void;
  pause(): void;
  stop(): void;
  events: AsyncIterable<AgentEvent>;
}
```

Codex backend (Phase 4) adapts OpenAI Agents SDK into this interface. Skills/memory not available; UI flags this clearly.

### Per-chat MCP config

Each agent spawns with `mcpServers` injected for **its slot's** ports — `popbot-unity` URL = `localhost:<slot.mcpPort>/mcp`. Other MCPs (Linear, Sentry, Amplitude, BetterStack) inherited from `~/.claude/settings.json` or `.mcp.json` automatically by the SDK.

## Tech stack

- **Electron** (Node + Chromium)
- **React + Tailwind** for UI
- **xterm.js + node-pty** for terminal panel
- **better-sqlite3** for transcript persistence (one row per event, indexed by chat + timestamp)
- **keytar** for OAuth tokens / API keys / agent creds
- **Linear GraphQL API** for ticket panel
- **`gh` GraphQL** for unreviewed PRs panel
- **Native Swift helper** for window placement

## Phasing

### Phase 0 — Prereqs (~3 days)

| Item | Owner | Size |
|---|---|---|
| MCP `POPBOT_MCP_PORT` env override | Unity MCP | 5 min |
| `./run_local.sh --port` + `--data-dir` args | server | 30 min |
| `/health` returns `commit`, `gameDataHash`, `dtoVersion` | server | 30 min |
| Native macOS window-mover helper (Swift) | PopBot | ~½ day |
| Slot lifecycle prototype (worktree add, Library COW, branch switch, stash safety) | PopBot | ~1 day |

### Phase 1 — MCP automation surface (~3-5 days)

Job infrastructure + the Phase-1 tool catalog above. Migrate existing long tools (`rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`) onto the job model.

### Phase 2 — PopBot Electron MVP (~1-2 weeks)

Single chat column, `ClaudeBackend` only, single slot, single Unity. Settings panel skeleton. `canUseTool` policy engine. Native helper integrated. End-to-end loop: open chat → agent edits code → agent runs game → agent verifies via screenshots + logs → done.

### Phase 3 — Multi-chat + panels (~1 week)

Multiple chat columns (add/remove with floating +/x). Thumbnail strip with status colors. Linear tickets + unreviewed PRs panels. Bottom log panel with side-by-side Unity/server tabs. Mode/server-mode toggles in chat settings.

### Phase 4 — Polish + advanced

Codex backend adapter. Headless `Window Mode` (after batchmode validation). `crash_dump`, `events_pop`, `command_apply`, fixture management. Side-by-side log time-correlation. Autonomy budgets and loop detection refinement.

## Open questions

1. **Batchmode validation** — does AutoRPG actually run in `-batchmode` Play mode? Validation script in Phase 4-ish; not blocking for v1.
2. **Master Library refresh cadence** — manual button vs auto vs N-day TTL? Default: manual button in prefs.
3. **Slot count default** — 4 hardcoded, or scale by RAM/cores? Probably default 2-3, configurable.
4. **PopBot repo** — separate from `autorpg`, or live in `tools/popbot/`? Separate when it stabilizes; in-tree during early development.

## Risks

| Risk | Mitigation |
|---|---|
| `git checkout` corrupts a slot mid-stash | Always stash first; verify clean post-checkout; refuse if dirty |
| Two PopBot instances stomp the same slot | Lock file per slot dir; reconcile orphans on startup |
| Unity hangs and slot lease never releases | PID liveness check + GC on PopBot startup |
| LFS lock conflicts across worktrees | Rare; surface clearly when it happens |
| Slot Library drifts far from master | Manual "reset slot" rebuilds from master |
| Disk fills up | Show per-slot size in prefs; "reset" reclaims |
| Backend drift on remote-dev mid-session | `server_health` re-check on errors; banner + halt |
| Autonomous mode auto-approves something unsafe | Hard-coded deny-list in `canUseTool`; never overridable by chat config |

## Proof artifacts (agent debug deliverable)

When an agent completes a debug task, it writes to `tmp/mcp-sessions/{slug}/`:

```text
proof.md             ← deliverable: repro / before / root cause / fix / after / verification
before/              ← screenshots + filtered log dumps
after/               ← screenshots + clean log dumps
diff.patch           ← agent runs git diff and saves
```

`proof.md` follows a 6-section template (Repro / Before / Root Cause / Fix / After / Verification). The convention is documented in a SKILL (`agent-debug`); the MCP only provides predictable session paths.

## Quick reference — what changed from earlier proposals

For anyone reading the conversation that produced this doc:

- Library pool / process pool / worktree pool **collapsed into one concept: the slot.** Slot owns its worktree, Library, optional Unity, optional sidecar. No symlinks, no separate pools.
- `git worktree add` is **~23s on AutoRPG** (LFS smudge over 62k files), not 1-2s. Slot creation is rare; reuse-via-checkout is the everyday hot path.
- **GUI Editor on screen 2** is the v1 default. Headless batchmode is Phase 4 opt-in after validation.
- Server runs in-tree via `./run_local.sh`; per-slot port + data-dir for isolation.
- Agent integration: **Claude Agent SDK first**, AgentBackend interface, Codex Phase 4.

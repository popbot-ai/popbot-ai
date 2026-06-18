# Phasing

Roadmap for getting PopBot from "design + prototype" to "useful daily driver." Mirrors the phasing in [POPBOT_DESIGN.md](POPBOT_DESIGN.md#phasing) but tracks concrete progress with checkboxes.

Update this file as items land. One commit can check multiple boxes.

---

## Phase 0 — Prereqs (~3 days)

Foundational pieces in the AutoRPG repo + a native helper here. Most of these block actual end-to-end testing but not the Electron scaffold.

### In `~/pop/autorpg`

- [ ] **`POPBOT_MCP_PORT` env override** on the in-Editor MCP server (`autorpg-unity/Assets/Editor/MCP/UnityMcpServer.cs`). Read port from env, fall back to `17893`. ~5 min.
- [ ] **`./run_local.sh --port` + `--data-dir` flags.** Server takes both as args; data dir for per-slot DB isolation. ~30 min.
- [ ] **`/health` endpoint extension** — return `{ ok, commit, gameDataHash, dtoVersion, uptimeSec }`. PopBot uses these for drift detection at lease time. ~30 min.

### In this repo

- [ ] **Native macOS window-mover helper** — Swift CLI at `native/popbot-windowmover/`. Subcommands: `move`, `minimize`, `wait-for-window`. ~½ day.
- [ ] **Slot lifecycle prototype** — standalone TS module under `src/main/slots/` exercised by a script under `scripts/`. Covers worktree add, Library COW from master, branch switch with stash safety, lease/release, orphan reconcile. ~1 day.

---

## Phase 1 — MCP automation surface (~3-5 days)

In `~/pop/autorpg`. Builds out the in-Editor MCP tools the agents will actually use.

- [ ] **Job infrastructure** — `job_status`, `job_get_result`, `job_cancel`, `job_list`. All long-running tools return `{ jobId }` immediately.
- [ ] **Lifecycle tools** — `play_status`, `play_enter` (job), `play_exit`, `play_pause/resume/step`, `time_scale_set`, `editor_quit`.
- [ ] **Observe tools** — `screenshot`, `game_state_summary`, `screen_stack`, `chapter_status`, `ui_tree`, `ui_query`.
- [ ] **Act tools** — `ui_click`, `ui_click_by_loc`.
- [ ] **Sync tools** — `wait_until` (job), `wait_for_idle` (job).
- [ ] **Logs / server tools** — `console_get_logs` extended (`sinceTimestamp`, `dedupe`, `dumpTo`, `includeStack`), `server_logs`, `server_health`, `client_set_server_endpoint`.
- [ ] **Sessions** — `mcp_session_start`, `mcp_session_end` for predictable artifact dirs.
- [ ] **Migrate existing long tools** to the job model: `rebuild_gamedata`, `rebuild_dtos`, `addressables_build`, `addressables_clean`.

---

## Phase 2 — PopBot Electron MVP (~1-2 weeks)

End-to-end usable for a single chat. **In progress.**

- [ ] **Electron scaffold** — `package.json`, Vite + React + TS + Tailwind, electron-builder, ESLint + Prettier, Vitest.
- [ ] **Main / preload / renderer split** with typed IPC bridge.
- [ ] **Port the 8 prototype JSXs** to `.tsx` under `src/renderer/`. Static UI runs in the Electron window with no functional backing.
- [ ] **better-sqlite3 schema** — chats, messages, slots, prefs.
- [ ] **Single ClaudeBackend session** wired into one chat column. Send message, receive event stream.
- [ ] **`canUseTool` policy engine** — hard-coded deny-list + allow-by-mode. Renderer surfaces permission requests as modals.
- [ ] **Slot manager** wired up — one slot, real worktree, real Unity launch via the Phase 0 helper.
- [ ] **Native window-mover integration** — Unity opens, helper places it on screen 2.
- [ ] **Settings panel skeleton** — per-chat mode, server mode, time scale, agent backend.
- [ ] **End-to-end loop demo** — open chat → agent reads code → agent runs game → agent screenshots → agent reports.

---

## Phase 3 — Multi-chat + attention queue panels (~1-2 weeks)

Lights up [US-1](USER_STORIES.md#us-1--awareness-of-attention-queue), [US-2](USER_STORIES.md#us-2--one-click-activation), [US-5](USER_STORIES.md#us-5--easy-multitasking-via-thumbnails), [US-6](USER_STORIES.md#us-6--at-a-glance-status).

- [ ] Multiple chat columns; floating add/remove.
- [ ] Thumbnail strip with status colors (US-5, US-6).
- [ ] **Linear tickets panel** (assigned to me, ranked by priority + due date).
- [ ] **Unreviewed PRs panel** (`gh` GraphQL).
- [ ] **Slack panel** — DMs, @mentions, owned channels. Net-new subsystem (`src/main/slack/`); OAuth via `keytar`. See [USER_STORIES.md → Deviations](USER_STORIES.md#slack-as-a-third-attention-source-us-1).
- [ ] **One-click chat spawn** from any panel row; chat seeded with the source's context (US-2).
- [ ] Bottom log panel — Unity + server tabs, sync-scroll for active chat.
- [ ] Mode + server-mode toggles in chat settings, with mid-session repoint.
- [ ] Drift detection on `remote-dev` lease.

---

## Phase 4 — Polish + advanced

- [ ] **Codex backend adapter** — `CodexBackend implements AgentBackend`, capabilities flagged in UI.
- [ ] **Headless `Window Mode`** — opt-in after batchmode validation script proves it works on AutoRPG.
- [ ] **`crash_dump`, `events_pop`, `command_apply`, fixture management** MCP tools.
- [ ] **Side-by-side log time-correlation** between Unity and server panels.
- [ ] **Autonomy budgets + loop detection** refinement (token / time / repeated-failure pause triggers).
- [ ] **Update channel** — auto-updater via electron-builder + signed builds.

---

## Open questions (carry-overs from design)

1. Does AutoRPG actually run in `-batchmode` Play mode? Validation script in Phase 4-ish; not blocking v1.
2. Master Library refresh cadence — manual button vs auto vs N-day TTL? Default: manual button in prefs.
3. Slot count default — 4 hardcoded, or scale by RAM/cores? Probably default 2-3, configurable.

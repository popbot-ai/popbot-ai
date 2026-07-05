# Core Model

The object graph PopBot's app is built around. Everything else — IPC,
persistence, UI panels, the agent loop — hangs off these. If you change
behavior in a way that violates a rule here, **either update the model
first or tell the user the model is changing.**

For "where does the code live?" see [ARCHITECTURE.md](ARCHITECTURE.md).
For "what does the user see?" see [USER_STORIES.md](USER_STORIES.md).

---

## TL;DR — the four nouns that matter

| Noun | Durable? | Owner | Lifetime |
|---|---|---|---|
| **Chat** | yes (SQLite) | main | created by user, lives until explicitly deleted |
| **Message** | yes (SQLite, append-only-ish) | main | child of Chat |
| **Slot** | yes (filesystem + SQLite row) | main / `SlotManager` | created rarely, reused; never per-chat |
| **AgentSession** | **no** (in-memory only) | main / `AgentHost` | spawned when a Chat goes "running"; disposed when Chat closes or app exits |

Everything in the renderer is a **view** over these. The renderer never owns
canonical state.

---

## Durable nouns (survive restart)

### Chat

The user's unit of work. One ticket, one PR review, one Slack thread, one
"poke around the codebase" session — each is one Chat.

```ts
interface ChatRecord {
  id: string;                                // chat_<12hex>
  name: string;                              // "ENG-20512 · ability cooldown"
  ticket: string | null;                     // "ENG-20512"
  pr: number | null;                         // 7401
  branch: string | null;                     // git branch this work targets
  type: 'lite' | 'client_test' | 'server_test';
  mode: 'interactive' | 'autonomous';
  agent: 'claude' | 'codex';
  status: ChatStatus;                        // see lifecycle below
  snippet: string;                           // last agent prose (cached for thumbnail)
  tokensUsed: number;
  tokensBudget: number;
  createdAt: number;
  lastActiveAt: number;
  closedAt: number | null;                   // null = open
}
```

**Status lifecycle** (US-6 — what colors the thumbnail):

```text
              ┌──────────────┐
              │   idle (○)   │ ← initial state, no agent attached
              └──────┬───────┘
        send/respawn │
              ┌──────▼───────┐
              │  running (▶) │ ── error ──→  errored (✗)
              └──┬───────┬───┘
   needs review │       │ message-end + no work pending
              ┌─▼─────┐ │
              │paused │ │
              │  (?)  │ │
              └──┬────┘ │
       resolve   │      │
              ┌──▼──────▼─────┐
              │ complete (✓)  │
              └───────────────┘
```

**Status is descriptive, not prescriptive** — derived from the AgentSession
when one's attached, persisted to DB on transition. A chat being `idle`
means "no agent doing work right now." It does not mean "the chat is
closed."

**Open vs closed:** a chat is "open" iff `closedAt IS NULL`. Open chats
are loaded into memory at startup; closed chats are query-only. **Closing
a chat releases its slot lease + disposes its AgentSession but never
deletes Messages.**

### Message

Append-only-ish event log inside a Chat. The transcript is a sequence of
typed records:

```ts
interface MessageRecord {
  id: string;                                   // msg_<12hex>
  chatId: string;
  role: 'user' | 'agent' | 'system';
  kind: 'text' | 'tool' | 'permission' | 'system';
  body: string;                                 // JSON-encoded payload (shape per kind)
  createdAt: number;
  updatedAt: number;
}
```

**Why JSON in `body`?** Each kind has a different payload shape (text vs
tool-call vs permission request) and the renderer dispatches on `kind`.
Storing as a typed JSON blob keeps the table flat and the renderer code
honest.

**"Mostly append-only":** `tool` and `permission` rows are mutated **once**:

- `tool` rows: written on `tool-use` (name + args), updated on `tool-result`
  (fills `result` + `isError`).
- `permission` rows: written on `permission-request` (tool + args + reason),
  updated on user decision (sets `decision`).
- `text` rows: written on `message-start` with empty text, **coalesced** in
  a small in-memory buffer as `text-delta` events arrive, flushed on
  `message-end` (and every ~250 ms to keep the renderer live). One row per
  "agent prose turn," not one row per delta.

**No cascading deletes from rolling back agent work.** If an agent makes a
mistake and you want it to "try again," you send a new user message. The
old transcript stays. The model never silently rewrites history.

### Slot

A warm, isolated, disposable workspace: an isolated checkout over a
copy-on-write folder (a Git worktree, or a Perforce client) + a warm
build cache (e.g. an engine's asset/import cache) + (optionally) a running
editor for the app under test (Unity, Unreal, or a custom engine) +
(optionally) a running sidecar server. **Created rarely, reused
continuously.** Slots are owned by the user / app, not by Chats.

```ts
interface SlotRecord {
  id: number;                                   // slot-1, slot-2, ...
  worktreePath: string;
  branch: string | null;                        // null if free / detached
  ports: { mcp: number; server: number };
  unityPid: number | null;                      // editor PID; refreshed via PID liveness
  serverPid: number | null;
  state: 'free' | 'leased' | 'degraded' | 'creating';
  pinnedBranch?: string;                        // refuse leases for other branches
  cleanOnRelease?: boolean;
  leasedByChatId?: string;                      // soft pointer; a Chat → Slot binding
  lastLeaseAt?: number;
}
```

**Slot ↔ Chat binding** is **transient** — it lives in `slot.leasedByChatId`
and the corresponding Chat's runtime metadata. On startup we reconcile this
by walking slots and matching against open chats. Stale leases (chat
closed, lease never released) are reaped.

For the full slot lifecycle see [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit).

### Permission grant

A durable user decision that some tool / target combination is approved
without re-prompting. Two scopes:

```ts
interface PermissionGrant {
  id: string;                                   // grant_<12hex>
  scope: 'global' | 'chat';
  chatId: string | null;                        // non-null iff scope='chat'
  tool: string;                                 // exact tool, e.g. 'Bash', 'git_push', 'mcp__linear__save_issue',
                                                //   OR a trailing-`*` wildcard, e.g. 'mcp__unrealEditor__*'
  /** Optional refinement: 'Bash' tool restricted to commands matching this prefix. */
  argMatcher: string | null;                    // raw string OR /regex/ — TBD
  decision: 'allow' | 'deny';
  createdAt: number;
}
```

`tool` may be a trailing-`*` wildcard, so an entire MCP server can be
allowed with one grant (`allow-mcp-server` → `mcp__<server>__*`) — this is
how a slot's editor MCP is permitted once instead of once-per-tool. Deny
rules always win over allow, and a more specific pattern wins over a
broader one (see `resolvePermissionRules` in `src/shared/agent.ts`).

Grants accumulate per chat (US-9: "always allow git push for this chat").
Hard-coded **deny rules** in [adr/0004](adr/0004-canusetool-policy-boundary.md)
are not stored here — they live in code and cannot be overridden.

### Settings

Two layers:

- **Global prefs**: theme, default chat type, slot count, master Library
  refresh cadence, etc. One-row table.
- **Per-chat overrides**: server mode, time scale, window mode, token
  budget, etc. Stored in a `chat_settings` table keyed by `chatId`.

Either may be empty (defaults apply). Mutated via Settings panels in the
renderer.

### Cached attention items

The user's queues of assigned tickets (Linear / Jira / GitHub Issues) and
pending reviews (GitHub PRs / Helix Swarm changelists). Cached locally so
panels render instantly; refreshed on a schedule + on demand.

```ts
interface AttentionItem {
  id: string;                                   // source-prefixed: linear:ENG-20512, jira:ENG-123, gh:7401, swarm:1284
  source: 'linear' | 'jira' | 'github' | 'swarm';
  /** Source-specific raw payload, JSON. */
  payload: string;
  /** Local UI-state: have I dismissed this? Is there a chat already open for it? */
  dismissedAt: number | null;
  spawnedChatId: string | null;
  fetchedAt: number;
}
```

Ticket sources are interchangeable behind a common provider (Linear, Jira,
GitHub Issues); review sources likewise (GitHub PRs, Swarm). Cached, not
authoritative — the source of truth is the tracker / review system itself.

---

## Runtime nouns (in-memory; do not survive restart)

### AgentSession

The thing that talks to the LLM. One AgentSession per "running" Chat.
Backed by an `AgentBackend` (the Claude Agent SDK or the Codex SDK; both
ship today).

```ts
interface AgentSession {
  sendUser(text: string): Promise<void>;
  approve(permissionId: string, decision: PermissionDecision): void;
  stop(): void;        // cancel in-flight work; can still receive new messages
  dispose(): void;     // tear down entirely
}
```

**Owned by `AgentHost`** (a singleton in main process). AgentHost holds a
`Map<chatId, AgentSession>`. Sessions are created lazily on first
`agent.send` for a chat and disposed when the chat closes.

**Sessions emit `AgentEvent`s** (see `src/shared/agent.ts`). AgentHost
intercepts every event and:

1. **Persists** it (deltas coalesce into a text row; tool-use creates a
   tool row; permission-request creates a permission row).
2. **Re-broadcasts** it to the renderer via `webContents.send`. The
   renderer is one of N subscribers; main is the authoritative recorder.
3. **Updates Chat metadata** — `status`, `snippet`, `tokensUsed`,
   `lastActiveAt` get rolled forward as events arrive.

**Sessions never write to the DB directly.** Only AgentHost does. This
keeps the persistence schema's evolution decoupled from backend swaps.

### Permission request (in flight)

When the SDK's `canUseTool` callback fires:

1. PolicyEngine evaluates: hard-allow (auto), hard-deny (auto), or ask user.
2. If "ask user," AgentHost emits a `permission-request` event to the
   renderer **and parks the SDK callback** — keyed by `permissionId` — in a
   pending map.
3. Renderer shows the modal; user clicks decision; IPC back to main.
4. AgentHost looks up the pending callback and resolves it. SDK proceeds
   or aborts.
5. If "always allow this" was checked, write a `PermissionGrant` row.

Pending requests are **not persisted**. If the app crashes mid-decision,
the agent's tool call gets cancelled on restart.

### Process supervisor handles

Per slot: a `child_process.ChildProcess` for the app-under-test editor
(Unity / Unreal / custom engine — the `unityPid` field records its PID
regardless of engine), another for the sidecar server. Owned by
`SlotManager`. Health-checked via PID liveness + HTTP probes. Killed on
slot release / app quit. **Reconciled on startup** by walking the slot
dir's `slot.json` and verifying recorded PIDs are still alive.

---

## Ownership rules

These are **invariants**. Code that violates them is a bug.

1. **Renderer is pure view.** No fs, no child_process, no DB access. Talks
   to main exclusively via the typed `window.popbot.*` bridge.

2. **Main is the only writer to the DB.** Renderer reads via IPC; never
   touches `popbot.db`.

3. **AgentHost is the only thing that mutates Chat status / snippet /
   tokens during a session.** Other code can read those fields but can't
   write them while a session is active for that chat. (User-driven
   mutations like rename happen when no session is active, or are queued.)

4. **Backends never write to the DB.** They emit events; AgentHost
   persists. This keeps ClaudeBackend / CodexBackend / StubBackend
   interchangeable without DB schema entanglement.

5. **PolicyEngine is the single source of truth for "may this tool run?"**
   No backend bypasses it. Permission grants flow through it.

6. **Slot ↔ Chat binding is transient.** The Chat record never names a
   slot. The Slot record names the chat that holds the lease (soft
   pointer, reconciled on startup).

7. **The transcript never silently mutates.** Append new rows; the
   one-shot updates on tool/permission rows are explicit and bounded.

---

## State flow — a single user message, end-to-end

A worked example of the model in motion.

```text
User types "fix the cooldown flicker" in chat c1 and presses ⌘↵
  │
  ▼
Renderer: api.agent.send({ chatId: 'c1', text })
  │  IPC: pb:agent:send
  ▼
Main · AgentHost.send('c1', text)
  ├─→ DB: appendMessage({ chatId, role: 'user', kind: 'text', body: { text } })
  ├─→ DB: updateChatStatus('c1', 'running', snippet=text.slice(0,140))
  ├─→ webContents.send('pb:agent:event', { type: 'message-start', ..., role: 'user' })
  └─→ session.sendUser(text)            // AgentSession (Claude SDK)
        │
        │  SDK streams events back via the onEvent callback wired at spawn:
        │
        ├─→ { type: 'message-start', role: 'agent', messageId: 'msg_abc' }
        │     ├─→ DB: appendMessage({ id: 'msg_abc', kind: 'text', body: { text: '' } })
        │     └─→ webContents.send → renderer appends an empty agent message bubble
        │
        ├─→ { type: 'text-delta', messageId: 'msg_abc', delta: 'Looking at ' }
        │     ├─→ buffer.append('msg_abc', 'Looking at ')      // in-memory
        │     │     (flush every 250ms or on message-end → DB UPDATE)
        │     └─→ webContents.send → renderer concatenates into the bubble
        │
        ├─→ { type: 'tool-use', messageId: 'msg_abc', toolUseId: 't1',
        │     name: 'unity.run_fixture', args: {...} }
        │     ├─→ PolicyEngine.evaluate('unity.run_fixture', args)  → 'allow' (whitelisted)
        │     ├─→ DB: appendMessage({ id: 'tool_t1', kind: 'tool',
        │     │                        body: { toolUseId, name, args } })
        │     └─→ webContents.send → renderer renders tool row
        │
        ├─→ { type: 'tool-result', toolUseId: 't1',
        │     text: '3/3 ok · 14.2s', isError: false }
        │     ├─→ DB: updateMessageBody('tool_t1', { ...prev, result, isError })
        │     └─→ webContents.send → renderer updates tool row badge
        │
        ├─→ { type: 'permission-request', permissionId: 'p1',
        │     tool: 'git_push', args: { ref: '...' }, reason: 'back up progress' }
        │     ├─→ PolicyEngine.evaluate('git_push', args)   → 'ask'
        │     ├─→ AgentHost.pendingPermissions.set('p1', sdkCallback)
        │     ├─→ DB: appendMessage({ id: 'perm_p1', kind: 'permission',
        │     │                        body: { permissionId, tool, args, reason } })
        │     ├─→ DB: updateChatStatus('c1', 'paused', snippet='needs you: ...')
        │     └─→ webContents.send → renderer shows PermissionModal
        │
        │  ┌─── user clicks "Allow once" in the modal ───────────────────────┐
        │  ▼                                                                  │
        │  Renderer: api.agent.approve({ chatId: 'c1', permissionId: 'p1', │
        │                                 decision: 'allow' })                │
        │   │  IPC: pb:agent:approve                                          │
        │   ▼                                                                  │
        │  Main · AgentHost.approve('c1', 'p1', 'allow')                      │
        │     ├─→ DB: updateMessageBody('perm_p1', { ...prev, decision })     │
        │     ├─→ DB: updateChatStatus('c1', 'running')                       │
        │     ├─→ pendingPermissions.get('p1')(true)   // resolves SDK        │
        │     └─→ webContents.send → renderer dismisses modal                 │
        │
        ├─→ { type: 'message-end', messageId: 'msg_abc' }
        │     ├─→ buffer.flush('msg_abc')      → DB UPDATE final text
        │     └─→ webContents.send → renderer freezes the bubble
        │
        └─→ { type: 'session-status', status: 'idle' }
              ├─→ DB: updateChatStatus('c1', 'idle')
              └─→ webContents.send → renderer thumbnail goes from blue to gray
```

Two things to notice:

- **The renderer never decides anything.** It dispatches intents and
  re-renders from events.
- **DB writes happen at the same place as renderer notifications.** They
  are bound by the same handler in AgentHost. This means a renderer crash
  can't cause persistence drift.

---

## Recovery flow — restart from cold

US-7 in code form. App quits ungracefully. Hours later, user opens it again:

1. **DB init** — `initDb()` opens `popbot.db`, runs pending migrations.
2. **Slot reconcile** — walk `~/Library/Application Support/PopBot/slots/`,
   for each slot read `slot.json`, verify `unityPid` / `serverPid` are
   alive (`kill -0`); if dead, mark slot free and clear the PIDs.
   Resolve any orphaned leases (chat that doesn't exist, or chat whose
   `closedAt` is set).
3. **Open chats** — `listOpenChats()` returns chats with `closedAt IS NULL`,
   sorted by `lastActiveAt DESC`. Renderer asks for them at first paint.
4. **No automatic agent spawn.** Sessions are spawned lazily on first
   `agent.send`. A user opening their old chat just sees the transcript;
   the agent doesn't pick up where it left off until the user prompts.
5. **Slot lease on demand.** Same — leasing happens when the chat type
   needs it (Client/Server Test) and a tool that requires Unity is about
   to fire.

The result: opening the app is fast (DB read + slot ping), and you can
inspect any chat's history without paying the agent-spawn cost.

---

## Backend interchangeability

```ts
interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: { skills, memory, subAgents, mcpHttp: boolean };
  spawn(opts: SpawnOpts): AgentSession;
}
```

- **ClaudeBackend** wraps `@anthropic-ai/claude-agent-sdk`. The default.
- **CodexBackend** wraps `@openai/codex-sdk` (which drives `codex exec`).
  Shipped. Each backend advertises its `capabilities` and the UI
  feature-detects them per chat.
- **StubBackend** echoes user text with a fake stream. Used for wiring
  validation + UI tests.

The chat record's `agent` field selects which backend AgentHost spawns.

---

## What's intentionally NOT in the model

- **Workflows / DAGs / approval chains.** A chat is a conversation. We're
  not modeling pipelines.
- **Multi-user.** Single developer per machine; no auth, no sharing.
- **Notebooks / saved queries / templates.** All emergent from the
  transcript; no first-class type yet.
- **Versioned chat snapshots / branching transcripts.** The transcript is
  linear. Forking a chat = creating a new chat seeded from the old one's
  history (a future feature, not in the model today).

If we end up needing one of these, it gets added here first, then to code.

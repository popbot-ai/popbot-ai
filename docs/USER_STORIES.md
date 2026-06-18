# User Stories

The "what does success look like" reference for PopBot. Captured 2026-05-01. Every implementation choice should trace back to one of these.

The user is a single developer (Ben) running PopBot on his own machine. "I" below is him.

---

## US-1 · Awareness of attention queue

> *"I should be aware of high-priority issues, Slack messages, and other PRs that I need to attend to."*

Three sources surfaced together at the top of the window:

- **Linear tickets** assigned to me, ranked by priority + due date.
- **Slack messages** addressed to me (DMs, @mentions, channels I own). _New requirement; not in original design — see [Deviations](#deviations)._
- **GitHub PRs** requesting my review.

Each row shows enough at a glance to triage without clicking (title, source, age, priority indicator). High-priority items visually stand out from low-priority ones.

**Maps to:** [POPBOT_DESIGN.md → App layout](POPBOT_DESIGN.md#app-layout) (Tickets / Reviews panels — extend with a Slack panel).

---

## US-2 · One-click activation

> *"I should be able to initiate activity on any of these easily, and open a chat to begin work."*

Clicking any row in the attention queue spawns a new chat seeded for that work:

- Linear ticket → chat seeded with the ticket body, branch named for the ticket key, agent prompt prefilled.
- Slack message → chat seeded with the conversation context, ready to draft a response or kick off real work.
- PR → chat seeded with the diff and review checklist.

No setup friction between "I see something I need to handle" and "an agent is working on it."

**Maps to:** [POPBOT_DESIGN.md → App layout](POPBOT_DESIGN.md#app-layout) ("Click a row → spawn a chat seeded for that work").

---

## US-3 · Real game testing in the chat

> *"Chats should be able to engage a Unity instance and run unity/server when needed so they can test and debug work."*

When a chat needs to verify behavior in the actual game, the chat acquires a slot, spawns Unity (placed on screen 2), and optionally spawns the sidecar server. The agent drives the game via the in-Editor MCP — entering Play mode, clicking UI, screenshotting, reading logs, asserting state.

Acquiring a slot is the slow part the first time (~15-30 s cold); subsequent activity is sticky (~50 ms).

**Maps to:** [POPBOT_DESIGN.md → Chat types](POPBOT_DESIGN.md#chat-types) (Client Test / Server Test), [Slots](POPBOT_DESIGN.md#slots--the-durable-unit), [MCP automation surface](POPBOT_DESIGN.md#mcp-automation-surface).

---

## US-4 · Autonomous end-to-end completion with proof

> *"Agents should be able to work fully autonomously, and fix/debug and complete an entire ticket, including delivering proof that the fix/change worked as required in a markdown doc that can be inspected."*

In autonomous mode the agent runs a full read → reproduce → fix → verify cycle without intervention, and writes a `proof.md` artifact at the end. The proof contains:

- **Repro** — the exact steps that demonstrated the bug.
- **Before** — screenshots + filtered log dumps from the broken state.
- **Root cause** — the agent's diagnosis.
- **Fix** — the diff or summary of changes.
- **After** — screenshots + clean log dumps from the fixed state.
- **Verification** — a re-run of the repro, now passing.

I can open `proof.md` and decide whether the work is good without re-running anything myself. Pause-to-review is only needed for risky operations (`git push`, `gh pr create`, etc.).

**Maps to:** [POPBOT_DESIGN.md → Autonomous mode](POPBOT_DESIGN.md#autonomous-mode), [Proof artifacts](POPBOT_DESIGN.md#proof-artifacts-agent-debug-deliverable).

---

## US-5 · Easy multitasking via thumbnails

> *"I should be able to easily multitask between agents, by clicking on thumbnails."*

The thumbnail strip is the primary navigation surface for parallel work. A row of compact previews — one per chat — lets me jump between agents instantly. Clicking a thumbnail brings that chat to the foreground; the other chats keep running in the background.

The thumbnail itself communicates state, not just identity. See US-6.

**Maps to:** [POPBOT_DESIGN.md → App layout](POPBOT_DESIGN.md#app-layout) (thumbnail row), Phase 3 in [PHASING.md](PHASING.md).

---

## US-6 · At-a-glance status

> *"I should be able to easily get an idea what an agent is doing, and if they need assistance or direction from me at a glance."*

Every chat thumbnail shows its current state without me having to click in:

| Color | Meaning |
|---|---|
| Blue | Running |
| Green | Task complete |
| **Yellow** | **Paused — needs me** |
| Red | Errored |
| Gray | Idle / unstarted |

Yellow is the one that demands attention. Scanning the thumbnail row should answer "is anyone stuck?" in under a second. Beyond color, the thumbnail surfaces a short progress hint (last action, current step) so I can decide whether to dive in.

**Maps to:** [POPBOT_DESIGN.md → Status colors](POPBOT_DESIGN.md#status-colors-chat-thumbnail).

---

---

## US-7 · Recover and continue from anywhere

> *"I should easily be able to recover and continue with tickets, even ones that are no longer active, from where I left off."*

A chat is durable. Even after I close it, restart PopBot, or reboot, I can re-open any past chat and pick up exactly where I left off:

- Full transcript replays into the chat column.
- Slot is reacquired (or spun up cold) on the same branch I was on.
- Unity + sidecar state restores to the relevant fixture / save blob if one was set.
- The agent re-reads the recent transcript before responding to my next message — context isn't lost across the restart.

Closing a chat releases its slot; reopening reacquires. The chat is the durable record; the slot is transient infrastructure.

**Maps to:** [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--the-durable-unit) (slot vs. chat lifecycle), [Tech stack → better-sqlite3](POPBOT_DESIGN.md#tech-stack) (transcript persistence). Per-chat record schema lives in `src/main/persistence/`.

---

## US-8 · Per-ticket inspection: chat + Unity + logs + proof

> *"I should be able to easily take a look at the progress of a ticket by showing the content, server/Unity instance running, relevant logs, completion artifact (markdown)."*

For any chat (active or paused), one click brings up everything I need to evaluate progress:

- **Chat content** — the running transcript with the agent's reasoning, tool calls, and outputs.
- **Server / Unity status** — is the slot up, what branch, what's the screen stack, is Unity in Play mode.
- **Relevant logs** — Unity console + sidecar server, filtered to the chat's session, sync-scrolled.
- **Completion artifact** — the `proof.md` (and supporting `before/`, `after/`, `diff.patch`) the agent produced, rendered inline.

This is the "show me what happened" view. Not the raw firehose — the curated cross-section that answers "is this done well?"

**Maps to:** [POPBOT_DESIGN.md → App layout](POPBOT_DESIGN.md#app-layout) (chat column + bottom log panel), [Proof artifacts](POPBOT_DESIGN.md#proof-artifacts-agent-debug-deliverable). The proof-renderer lives in `src/renderer/chat/ProofViewer.tsx` (planned).

---

## US-9 · Just-in-time permission grants

> *"I should easily be able to give permission to agents to do various things that they should not be allowed to do entirely autonomously."*

When an agent wants to do something on the always-pause list (`git push`, `gh pr create`, `rm` outside the slot, network calls to non-allowlisted hosts, etc.), PopBot pauses and asks me. The grant flow is:

- Modal pops up with **what** the agent wants to do, **why** (the agent's stated reason), and the **command / arguments**.
- I can **allow once**, **allow for this chat / session**, **always allow** (durable per-tool, per-target rule), or **deny**.
- Allow-rules accumulate per chat, surfaced in the chat settings panel so I can revoke them.
- The hard-coded deny-list is never overridable from the UI — see [adr/0004](adr/0004-canusetool-policy-boundary.md).

The point: autonomy is the default, but I can frictionlessly approve a specific risky action without opening a terminal or babysitting the agent.

**Maps to:** [POPBOT_DESIGN.md → Autonomous mode](POPBOT_DESIGN.md#autonomous-mode), [adr/0004 — canUseTool policy boundary](adr/0004-canusetool-policy-boundary.md). The grant store lives in `src/main/agents/policy/`.

---

## Deviations and additions

This section flags places where the user stories diverge from the locked design. When implementing, use the user stories as the source of truth and update the design doc.

### Slack as a third attention source (US-1)

The original design covers Linear tickets and unreviewed PRs. Slack messages were not in scope. To honor US-1:

- Add a **Slack panel** to the upper-left tab group alongside Tickets and Reviews.
- Source: Slack DMs, @mentions, and messages in channels I own. Filtering rules TBD per chat-spawn workflow.
- Auth: Slack OAuth (token in keychain via `keytar`).
- Spawning a chat from a Slack message seeds the agent with the conversation context.

This is a **net-new subsystem** — Slack API client in `src/main/slack/`, panel in `src/renderer/panels/slack/`. Phase it into [PHASING.md](PHASING.md) Phase 3 alongside the other panels, but treat it as a first-class peer, not an afterthought.

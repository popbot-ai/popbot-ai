# PopBot — Feature & Workflow Guide

PopBot is a desktop cockpit for running **many AI coding agents in parallel**. This guide covers the ideas it's built on — why it exists, how the pieces work, what shaped the design, and how a team at Proof of Play used it on a real, asset-heavy project that shipped. It is written for engineers who can find the UI themselves; the point here is the reasoning, so you can adapt the tool to your own workflow rather than follow a script.

Adapting it to your workflow is an intended use, not an afterthought. PopBot is published as a reference implementation — a shape to modify for your team rather than a fixed product — reflecting a view about how software is best built in the age of AI: teams running fleets of agents are generally better served owning and reshaping the tool than adopting one whose decisions are fixed for them. Read the "why" behind each piece below as a map of where you would cut to change it. [Make it yours](#make-it-yours) covers the how, where, and why in detail.

- [Why we built PopBot](#why-we-built-popbot)
- [Core concepts](#core-concepts)
  - [Agents & models](#agents--models)
  - [Slots: warm, isolated, disposable workspaces](#slots-warm-isolated-disposable-workspaces)
  - [Copy-on-write: unlimited copies on one repo's disk](#copy-on-write-unlimited-copies-on-one-repos-disk)
  - [Source control: Git and Perforce](#source-control-git-and-perforce)
  - [The inbox: one queue, many sources](#the-inbox-one-queue-many-sources)
  - [Repoless chats (for code review)](#repoless-chats-for-code-review)
  - [Base branch](#base-branch)
  - [Persistent, archivable chats](#persistent-archivable-chats)
- [Anatomy of the workspace](#anatomy-of-the-workspace)
- [How it was used at Proof of Play](#how-it-was-used-at-proof-of-play)
- [End-to-end workflows](#end-to-end-workflows)
  - [A feature ticket](#a-feature-ticket)
  - [A bug ticket](#a-bug-ticket)
  - [A code review](#a-code-review)
  - [Reopening an archived chat](#reopening-an-archived-chat)
- [Integrated source control & review](#integrated-source-control--review)
- [Testing in a slot: the app under test](#testing-in-a-slot-the-app-under-test)
- [Permissions & safety](#permissions--safety)
- [Localization](#localization)
- [Preferences](#preferences)
- [Make it yours](#make-it-yours)

---

## Why we built PopBot

A single AI coding agent is easy to run. The moment you want **more than one working at once**, three problems appear:

1. **Isolation.** Two agents editing the same checkout corrupt each other's work. You can't have three agents and one working tree — and on a large game project, you can't afford three full checkouts either.
2. **Oversight.** Agents are fast and mostly right, but "mostly" isn't good enough for `git push`, `p4 submit`, or opening a PR. You need a human gate on the irreversible actions — without babysitting every file edit.
3. **Verification.** Code that compiles isn't code that works. For a game especially, the only real test is *running it* and clicking through. An agent that can't see the app is guessing.

PopBot was built to solve all three for a small team shipping a live game. The insight: treat each unit of work — a ticket, a bug, a review — as a **chat**, give each chat its own isolated **workspace** plus (when needed) its own running copy of the app, run them **autonomously but gated**, and surface the whole fleet in one window so one person can lead a dozen agents at once.

The design was driven by a concrete set of [user stories](USER_STORIES.md): *"As an engineer, I click a ticket and an agent starts working it on a correct branch."* *"As a reviewer, I open a changelist and get a real review without checking anything out."* *"As a lead, I glance at the wall and know which agents need me."* Everything below exists to serve those. If you understand *why* each piece is shaped the way it is, you'll know which parts to keep and which to replace when you fork it for your own stack.

---

## Core concepts

### Agents & models

Every chat is driven by one **agent backend**:

- **Claude Code** — via the Claude Agent SDK. Models: **Claude Opus** (default) and **Claude Fable**.
- **Codex** — via the OpenAI Codex SDK. Model: **GPT / Codex**.

PopBot doesn't reimplement these agents — it **drives the real ones** through their official SDKs, which wrap the same **`claude`** and **`codex`** command-line tools you'd run in a terminal. The full power of each agent — its tools, skills, MCP servers, and subagents — is available inside every chat, and PopBot stays in lockstep with whatever version of those CLIs you have installed. If it works in terminal Claude Code, it works here. That's a deliberate bet: agents improve fast, and anything that wrapped or forked them would rot. By driving the CLIs directly, PopBot inherits every upgrade for free.

Per chat, you choose the backend, the **model**, and the **reasoning effort** (`low` → `xhigh` / `max` — more effort means deeper thinking and more thorough tool use, at higher cost/latency). You set sensible **defaults** — separately for *new chats* and for *code reviews*, since a review wants different depth than a feature build — and override per chat when a task warrants it.

Two session controls matter for long-running work:

- **Switch mid-session.** Change model or effort on an in-flight chat; PopBot reconfigures the agent without losing the thread.
- **Restart with context.** Spin up a *fresh* agent session primed with this chat's transcript (its opening turns plus the most recent ones), useful when a session gets long or wedged. The conversation history is preserved; the agent simply gets a clean runtime.

Credentials for the integrations are stored **locally on your machine**, in the app's own database — never in this repository.

### Slots: warm, isolated, disposable workspaces

A **slot** is the unit of parallelism, and it's the central idea in PopBot. The naive way to run N agents is N checkouts of the repo — which collides on shared trees, or costs N × (checkout time + build cache). A slot is the answer to "how do you give an agent a *real, independent* place to work that is also *already warm* and *cheap to hand back*."

A slot has three properties, and each one is load-bearing:

- **Isolated.** Each slot is its own working directory on its own branch (or Perforce stream), so N agents edit N branches with zero interference. One agent's `git reset` can't touch another's work.
- **Warm.** A slot keeps stateful build artifacts that persist across uses — for a game engine, its own import/asset cache; a dedicated **sidecar server** with its own data directory; assigned **ports**; per-slot logs; and, while a chat is active, a live **editor process**. A bare working directory gives you isolated *source*; a slot gives you an isolated, already-*warmed* place to build, run, and test.
- **Disposable.** Slots are pooled. A chat **leases** a free slot for its lifetime and **returns** it on close. Creating a warm workspace is expensive; reusing one is nearly free, so PopBot keeps a pool of them warm and cycles work through it.

**Why "warm" is the whole game for engine work.** A game engine keeps a massive processed-asset cache — Unity's `Library/`, Unreal's `DerivedDataCache` — often several gigabytes, expensive to produce. A fresh checkout, or a branch switch that invalidates it, forces the engine to **reimport the project**, which can take many minutes. Pay that on every task and every branch switch and your agents spend more time waiting on the engine than writing code. Slots eliminate that tax by giving each one its **own persistent cache**:

- **Switching an agent back into its slot takes seconds, not minutes** — the cache is already warm, so only genuinely changed assets reprocess.
- **A slot can keep the editor *running*.** A "sticky" reuse (same slot, same branch) hands the agent a live editor almost instantly instead of a cold launch.
- **Ten agents don't thrash one import cache.** Each slot has its own warm cache, so parallel game work never serializes behind a single reimport.

Before any branch switch, PopBot runs a **safety sequence** — it stashes uncommitted work, refuses to clobber commits the agent owns, switches, and restores state — so a slot handoff never silently loses work. Slots can run in **slot-pool** mode (reused, the default) or **ephemeral** mode (a fresh workspace per chat) when you'd rather trade warmth for a clean slate.

> **Why this matters:** isolation is what makes "ten agents at once" safe instead of catastrophic. Warmth is what makes it *fast*. Disposability is what makes it *cheap*. Take away any one and parallel agents stop being worth it.

### Copy-on-write: unlimited copies on one repo's disk

Isolation and warmth are only affordable if a slot's *files* are cheap. On a small repo, N git worktrees are fine. On a terabyte-scale game project — with a huge asset library and, on many teams, **Perforce** rather than Git — N real copies would be hundreds of gigabytes and minutes each to materialize. That kills the whole model.

So a slot's workspace is a **copy-on-write folder**. Every slot shares one **base image** of the repo and stores only the blocks it actually changes. The practical result:

- **A fresh, live, full copy of a terabyte tree is ready in seconds** — not a shallow view, real editable files — and is released just as fast.
- **Unlimited copies cost the disk of a single repo.** Ten agents on a 1 TB project don't need 10 TB; they need ~1 TB plus each slot's small delta.
- **It works the same on Windows, macOS, and Linux** (via `shado`, PopBot's shadow-workspace layer — differencing VHDX on Windows, native CoW filesystems elsewhere), and it's what lets Perforce trees participate at all.

This is the piece that makes the slot idea scale from "a web repo with a few worktrees" to "a AAA-sized game tree with a fleet of agents." It's also the least visible feature and arguably the most important: without cheap copies, warm isolated slots are a luxury; with them, they're the default.

### Source control: Git and Perforce

PopBot treats source control as a **provider** behind a common interface, because "run an agent on an isolated branch, then review and land the change" is the same shape whether the backend is Git or Perforce. Both are first-class:

- **Git** — worktrees for isolation, branches per chat, PRs via the `gh` CLI, GitHub as the review surface.
- **Perforce** — streams/branches per chat over copy-on-write shadow workspaces, changelists as the unit of work, and **Helix Swarm** as the review surface. Swarm reviews pin into the same Reviews inbox as GitHub PRs, each opening its own review chat.

The concepts you'll see below — base branch, the git/SCM panel, templated actions, the review inbox — are written against this common interface. Where the wording says "branch" or "PR," read "changelist" or "Swarm review" if you're on Perforce; the workflow is deliberately identical.

### The inbox: one queue, many sources

The inbox is an *idea*, not an integration: **your assigned work and your pending reviews, ranked, each one click away from becoming an agent chat.** What feeds it is pluggable:

- **Tickets** — **Linear** issues, **Jira** issues, and **GitHub Issues** assigned to you (GitHub Issues support is newer and still somewhat experimental). Click one and PopBot names a branch, leases a slot, moves the ticket to *In Progress*, and seeds the agent with its description.
- **Reviews** — **GitHub** pull requests and **Helix Swarm** changelists awaiting your review. Click one and a repoless review chat opens instantly.

Adding a source doesn't change the workflow — it just adds rows to the same queue. That's the point: the inbox-as-queue model is generic, and the specific trackers are interchangeable defaults.

### Repoless chats (for code review)

Not every chat needs a workspace. **Reviewing** a change is read-only — you don't edit, you read the diff and the surrounding code and post comments. So review chats are **repoless**: they spawn instantly, lease no slot, and consume no workspace.

This is a deliberate, important split:

- A **build chat** (feature/bug) leases a slot, may take a moment to warm up, and holds a workspace for its lifetime.
- A **review chat** is **instant and free** — you can open five of them to triage your review queue while your build chats keep running undisturbed.

It also means your slot pool is reserved for work that actually needs isolation. Reviews never starve builds of slots — a property that matters a lot when the pool is bounded by RAM and disk.

### Base branch

When a chat *does* write code, it forks from a **base** — typically `develop`/`main` on Git, or the mainline stream on Perforce. PopBot defaults the base per repository, remembers your last choice so the common case is one click, and lets you branch off a feature line or release branch when a task needs it. It derives the new branch name from your convention — e.g. `<username>/<ticket>-<slug>` — so branches are consistent and traceable back to their ticket. The base also powers later actions: "rebase onto base," "open PR / review against base," and drift checks all key off it.

### Persistent, archivable chats

Every chat is a **durable transcript** stored locally — prose, tool calls, diffs, permission decisions, the lot. Nothing is ephemeral.

- **Closing** a chat releases its slot (freeing a workspace for other agents) but **keeps everything**. The chat moves to the **archive**.
- **Reopening** a chat from the archive re-leases a slot, restores its branch, and the agent resumes with its **full history** — you can pick up a feature days later to address review feedback without re-explaining anything. If it reopens in a *different* slot, PopBot tells the agent so up front, so it re-orients to the new working directory cleanly.
- The archive is searchable across name, ticket, branch, and content.

Because rollback is just "send another message" (there are no destructive history edits), a chat accumulates the complete, auditable story of how a change was made.

---

## Anatomy of the workspace

![PopBot UI anatomy](../images/anatomy.png)

| Region | What it is |
|---|---|
| **Inbox — tickets & reviews** | Assigned tickets (Linear / Jira / GitHub Issues) and reviews awaiting you (GitHub PRs / Swarm changelists), ranked. Click a row to spawn a chat seeded with its context. |
| **Slots** | The pool of warm workspaces. Each pill shows whether a slot is free or leased by a chat. |
| **Chat archive** | Every past chat, searchable and reopenable with full history. |
| **Chat thumbnails** | A live, scrolling preview of every open chat — a real view of what each agent is doing right now, color-coded by status: blue = running, green = done, yellow = needs you, red = error, gray = idle. |
| **Chats** | The focused agent sessions — streaming prose, tool calls, and inline code diffs. |
| **Per-chat terminal** | An embedded terminal pinned to that chat's workspace. |
| **SCM panel** | Working-tree/changelist status, recent commits, file diffs, and one-click commit / push / PR / review actions. |

Because every chat stays on the **thumbnail strip** and the **columns sit side by side**, you're never hunting for status. The color is the signal — blue = running, green = done, yellow = needs you, red = error — so a glance tells you which agents are working, which are done, and which are **waiting on you**.

But each thumbnail is also a **live preview of the conversation**, not just a status light — so at a glance you can see *what* every agent is actually working on. That's what lets you **catch useless work early**: spot an agent going down the wrong path and redirect it before it burns time and tokens, instead of discovering the dead end after it's "done." It's the difference between supervising a fleet and being surprised by it.

### Why thumbnails, and why one view

This layout is a deliberate answer to a specific problem, and it's worth stating the reasoning because it's the part most tools get wrong.

Running one agent is a focus task: you watch a single conversation and respond. Running *many* is a **monitoring** task, and monitoring has a different failure mode — the bottleneck isn't your typing speed, it's your attention. An agent that quietly wanders off produces work you have to notice, understand, and throw away. With N agents, the cost of *not noticing* scales with N, and the natural interfaces make noticing hard: tabs hide every agent but one, and a launch-and-wait model hides all of them until they surface a result.

So the design commits to two things:

- **Every agent is always visible.** The thumbnail strip shows the whole fleet at once, and each thumbnail is a live view of the actual conversation, not a spinner. You are meant to be able to stand back and take in the state of a dozen agents in one sweep of the eyes — which agents are moving, which are stuck, which are about to do something you'd want to stop.
- **Status is a color, content is a glance away.** Color answers "who needs me?" in under a second; the live preview answers "what is this one doing?" without a click; and the side-by-side columns let you drop into any one of them without losing the others. The interface is optimized for *cheap re-checking*, because with many agents you re-check constantly.

The payoff is the ability to **intervene early**. The expensive mistake with autonomous agents isn't a crash — it's an agent confidently spending an hour building the wrong thing. A view that surfaces intent continuously turns that from a post-hoc discovery into a mid-course correction. That is the whole reason the fleet is on screen at all times instead of behind tabs or a notification.

---

## How it was used at Proof of Play

PopBot wasn't a lab experiment. It was built and used daily by the team at **Proof of Play** on a real, asset-heavy project that shipped. That origin explains most of the design choices, and it's the clearest way to understand what the tool is for.

The practical result was straightforward: the slot model — warm, isolated, copy-on-write workspaces — made parallel agent work feasible on a large asset tree, and the team got more done because of it. Multiple agents could run at once without colliding or paying the engine's reimport tax on every switch, so throughput went up rather than the parallelism turning into overhead.

The shape of a typical day: a lead with the wall of thumbnails open, four or five agents in flight — a couple grinding feature tickets, one chasing a bug, one or two doing code reviews. The lead isn't writing code minute-to-minute; they're **watching the fleet**, stepping in only at the gates (a push, a PR, a risky action) and when a thumbnail goes yellow or an agent visibly wanders. The tickets come from the team's real tracker; the reviews are real PRs and changelists the rest of the team sees land.

The hard constraints that game project imposed are exactly the features that ended up mattering most:

- **The asset tree was enormous**, so warm slots and copy-on-write workspaces weren't a nicety — without them, a fleet of agents on that tree was simply unaffordable. This is why those two ideas are the backbone of the tool.
- **The engine was the source of truth for "does it work,"** so an agent that couldn't launch and drive the running game was useless for most gameplay work. Hence the app-under-test integration.
- **Source control was Perforce for the game and Git for tooling**, so provider-agnostic SCM wasn't optional.
- **One person needed to lead many agents**, so the whole cockpit is optimized for *oversight at a glance* rather than deep single-session focus.

If your situation rhymes with any of that — a large tree, a real app to test, more work than one agent can handle — the design will map closely onto your needs, because it was built for exactly that. If it doesn't, the [Make it yours](#make-it-yours) section is about keeping the ideas and swapping the specifics.

A note on scope: that project ultimately didn't find commercial traction, and we're not claiming otherwise. But the engineering problem it posed was real — a large asset tree, a fleet of agents, one team — and the parts of PopBot that solved it are the parts documented here. The tool's value doesn't depend on the game's outcome, and we'd rather state that plainly than imply more.

---

## End-to-end workflows

### A feature ticket

1. **Notification → inbox.** A ticket assigned to you appears in the **Tickets** inbox (PopBot polls Linear / Jira / GitHub Issues, ranked by priority and due date). The notification bell flags it.
2. **One click to start.** Click the ticket row. PopBot opens a **new-chat** dialog defaulted to your repo and base (remembered from last time) — confirm, or adjust the agent/model/effort.
3. **Slot allocation.** Because this chat will write code, PopBot **leases a slot**: it picks a free workspace, derives the branch name `you/eng-123-<slug>` from the ticket, and switches the workspace to it (running the stash-safety sequence first).
4. **Ticket auto-promoted.** The ticket is moved to **In Progress** automatically (idempotent, fire-and-forget) so your board reflects reality without a context switch.
5. **Agent starts.** The agent receives a seeded first message (your customizable *start-ticket* template, filled with the ticket title, description, and branch) and begins: exploring the code, making edits, running commands — all inside its slot's workspace.
6. **Verification in the slot.** For a game change, the agent **launches the app in its slot** (an engine editor + sidecar server on a second display) and exercises the feature — clicking through UI, reading logs, screenshotting — instead of guessing that it works.
7. **Gated finish.** When it's ready to push, the agent **pauses** (pushing is a gated action). The thumbnail turns yellow ("needs you").
8. **You review & ship.** Open the **SCM panel**, read the diff, and hit **Push PR** (or **Push draft**). The action sends a pre-filled instruction to the agent, which pushes the branch and opens the PR / Swarm review against your base.

Throughout, you weren't watching — you were doing the same for two other tickets. You only stepped in at the gate.

### A bug ticket

The bug flow is the feature flow with a tighter loop, and it shows off **parallelism**:

1. A bug report arrives (a ticket, or you start a chat manually with the bug description).
2. Spawn a chat → it leases **its own** slot and branch. Your in-flight feature chat is completely untouched — different workspace, different branch.
3. The agent reproduces the bug **by running the app in its slot**, finds the cause, fixes it, and re-runs to confirm the repro is gone.
4. You glance at the **thumbnail strip**: feature chat green (done, awaiting your push), bug chat blue (running). Two agents, two isolated trees, zero collisions.
5. Push the fix when it pauses for approval.

### A code review

1. **Notification → Reviews.** A teammate requests your review. The PR (GitHub) or changelist (Swarm) appears in the **Reviews** inbox.
2. **Instant, repoless chat.** Click it → a **review chat** opens immediately — no slot, no checkout, no wait. It's seeded with the *start code review* template (read the surrounding code, not just the diff; trace the systems; hunt for real bugs, races, edge cases, security and perf issues).
3. **Real review.** The agent reads the diff **and** the code around it, reasons about correctness, and posts **inline comments** plus a verdict (approve / request changes) on GitHub or Swarm — then summarizes the red flags for you in the chat.
4. **Re-review later.** If the author pushes fixes, hit **re-review**: PopBot focuses the existing review chat and tells the agent to look **only at the new commits**, verify each prior thread is actually addressed, and update its review.

All of this happens while your build chats keep running — reviews never take a slot.

### Reopening an archived chat

Work is rarely one-and-done. The reopen flow is first-class:

1. A feature chat shipped its PR; you **closed** it to free the slot. It's now in the **archive** (transcript fully preserved).
2. Two days later, the change gets review comments. Find the chat in the archive (search by ticket, branch, or text) and **reopen** it.
3. PopBot **re-leases a slot**, restores the chat's branch into the workspace, and the agent resumes with its **entire history** — it already knows what it built and why. If it lands in a different slot than before, PopBot orients it to the new working directory.
4. Paste or summarize the review feedback. The agent addresses it, re-tests in the slot, and pushes the update — no re-onboarding, no lost context.

Because the branch, the transcript, and the reasoning all persist, picking a task back up costs seconds, not a re-explanation.

---

## Integrated source control & review

Source control is wired in deeply, through the native CLI for each provider — **`gh`/`git`** for GitHub, **`p4`** and the Swarm API for Perforce — so everything an agent does is real activity your team sees in the normal places.

- **Reviews inbox.** GitHub PRs and Swarm changelists awaiting your review (and your own recent submissions) surface as one-click chat sources.
- **PR / review status chips.** Each chat linked to a change shows a live status chip — Open / Merged / Closed / Draft — that you can click to open it on GitHub or in Swarm.
- **The SCM panel.** For any build chat, see working-tree/changelist status, recent commits, and per-file diffs. Click a file for a full unified-diff overlay.
- **One-click actions.** Templated, editable actions send a pre-filled instruction to the agent: **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR** (address review comments), **Rebase onto base**. Each expands variables like `${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, and `${prurl}` so the agent has exactly what it needs.
- **Creation against your base.** Pushing opens the PR (or Swarm review) against the chat's configured base, named by your branch convention.

Review is a distinct, optimized path (see [A code review](#a-code-review)):

- **Repoless and instant** — no slot, no checkout. Triage a queue of reviews in seconds.
- **Reads context, not just the diff** — the review template directs the agent to read surrounding code, trace systems, and look for bugs/races/edge-cases/security/perf, not rubber-stamp the patch.
- **Posts where your team works** — inline comments and a submitted review on GitHub or Swarm.
- **Re-review is scoped** — on a second pass, the agent examines only new commits and confirms each earlier thread is genuinely resolved before updating its review.
- **Fully customizable** — the *start code review* and *re-review* prompts are editable templates, so you can tune the rigor, checklist, and tone to your team's bar. The review *procedure itself* (how your shop wants a GitHub or Perforce review done) is yours to provide — PopBot recommends and can sample one, but the standard lives with your team.

## Testing in a slot: the app under test

A build chat's slot isn't just a folder — it's a place to **run and inspect** the work:

- **Per-chat terminal.** An embedded terminal (xterm + a real PTY) pinned to the chat's workspace. Run tests, inspect logs, or fire off commands by hand while the agent works. It persists as you switch between chats.
- **Editor integration.** Every `path/to/file.ts:42` reference in the transcript is a clickable link that opens in **VS Code** or **Cursor**, resolved against the chat's workspace.
- **The app under test.** A slot can launch the **real application** so the agent can drive it rather than guess. For a web app, a CLI, or a service, this is mostly the agent's own doing — it runs your build and test commands in the slot's terminal, hits the running server, reads the output. PopBot doesn't need to know anything special about those; the agent handles them the same way you would. Game **engines** are the case that needs extra handling, because the editor is a long-lived GUI process with its own asset cache and no natural command-line "run and check" loop. So for **Unity** and **Unreal**, PopBot launches a live editor + sidecar server, places it on a second display, and exposes it to the agent over an **in-editor MCP server**. Each running editor gets its **own MCP port derived from its slot** — so an agent talks only to *its* editor, never another slot's — and PopBot connects each chat's agent to that endpoint automatically (in-memory, so nothing lands in source control). A **custom** engine slots into the same machinery: PopBot passes the slot identity through to your launch command and you wire up how the agent drives it. In every case the agent can exercise the app — click UI, read logs, screenshot, assert behavior — and PopBot manages the editor lifecycle (start the server, health-check it, start the editor, place its window, tear it down on release), budgeting concurrent instances against available RAM.

This is the difference between an agent that *thinks* its change works and one that has *seen* it work. Nothing about it is game-specific — web and other development are equal first-class uses. Game engines simply carry the extra state (a warm asset cache, an editor-as-app-under-test) that the system has to be aware of, and that same extra state is what makes them the sharpest demonstration of the tool's novel parts: warm slots, copy-on-write workspaces, and a running app the agent can drive.

## Permissions & safety

Autonomy with a hard floor:

- **Auto-allowed (silent):** reads, edits, and shell commands **inside the slot's workspace**, calls to the slot's own services (including its editor MCP), and internal agent operations. The agent just works.
- **Always gated (pauses for you):** `git push` / `p4 submit` / reset / force, anything **outside** the workspace, opening PRs or reviews, deleting outside a scratch dir, sending messages (Slack/email), touching system or agent config, and network calls to non-allowlisted hosts.
- **Everything else:** prompts you to decide.

When you approve something, you can grant it **once**, **for the session**, or **durably** (always allow this tool/target). MCP servers can be permitted the same way — allow a slot's editor MCP once and it's remembered, with the grant visible and revocable in Preferences → Permissions (PopBot enables the Unity/Unreal editor MCPs this way automatically). Grants are per-chat or global and all **revocable**. The hard-deny floor (push/submit, network, out-of-tree) lives in code and is not overridable by UI rules — so a misconfigured grant can't let an agent land to mainline on its own.

## Localization

PopBot's entire interface — menus, settings, dialogs, everything — is fully localized. The app ships in **twelve languages**: English, Spanish, French, German, Japanese, Korean, Simplified Chinese, Brazilian Portuguese, Russian, Italian, Polish, and Ukrainian — switchable any time from the language menu without restart. If you fork PopBot, each locale is a single message catalog, so adding or adjusting a language is a contained change rather than a scavenger hunt through the UI.

## Preferences

Everything is configured in-app (no editing config files):

- **Agents** — default model & reasoning effort, separately for new chats vs. code reviews.
- **Repositories** — add/edit repos via a folder-first, SCM-aware wizard: path, provider (Git/Perforce), base branch or stream, color, slot prefix, workspaces directory, slot-pool vs. ephemeral mode.
- **Runtime & slots** — pool size (how many agents run at once), pre-create/delete slots, attachment retention, base-image refresh for copy-on-write workspaces.
- **Integrations** — connect Linear, Jira, GitHub, and Helix Swarm (credentials stored locally); configurable review-poll rates per provider; test before saving.
- **Source control** — branch-name convention, default base, and the editable action templates.
- **External apps** — terminal (iTerm), editor (VS Code / Cursor), engine binaries and per-engine options (including the editor-MCP base port), optional Chrome profile for URL routing.
- **Prompt templates** — every seeded prompt (start ticket, start/Re-review, and each action) is editable, with a variable reference card.
- **Permissions** — review and revoke durable grants, including per-MCP-server allowances.
- **Notifications** — toast placement and alerting behavior.
- **Language** — switch the interface locale.

> For a panel-by-panel reference with screenshots, see the **[Configuration Guide](CONFIGURATION.md)**.

## Make it yours

Adapting PopBot is a primary intended use. It is published as a reference implementation, and its design reflects a view about how software is best built in the age of AI: a team takes a working shape, understands *why* it is shaped that way, and reshapes it around their own stack, tools, and conventions rather than adopting a tool whose decisions are fixed for them.

Its shape is general: **agents + isolated, warm, copy-on-write slots + an inbox-as-queue + an app-under-test.** That pattern applies to most teams running more than one coding agent at a time. It is **MIT-licensed** and structured to be forked — the code is organized as *providers behind small common interfaces*, so a part can be added or swapped without touching the rest. The general approach: keep the core ideas, replace the specific instances.

The seams are listed below with *how, where, and why* for each. Every one is an interface with pluggable implementations; the practical path is to pattern-match on an existing implementation and add your own.

- **Swap the app-under-test.** *Why:* the whole point is an agent that *runs and verifies* your app, and "your app" is different for everyone. *Where:* `src/shared/gameEngine.ts` (engine descriptors, MCP wiring) and `src/main/ipc/apps.ts` (launch + lifecycle). Unity and Unreal are two implementations; the **custom-engine** hook already passes the slot identity (`POPBOT_SLOT`, derived ports) through to your launch command, so wiring up your web app, CLI, or test harness is "fill in the launch command and how the agent talks to it."
- **Point the inbox elsewhere.** *Why:* the inbox-as-queue is the durable idea; the specific tracker is a detail. *Where:* `src/main/tickets/` — implement the `TicketSource` interface in `provider.ts`, normalize your tracker's data into the shared DTOs, and register it in `registry.ts` (the file header literally notes: *"adding a tracker is a single line here plus its `*Source.ts` module"*). Linear, Jira, and GitHub Issues are the worked examples. The renderer never branches on provider id, so you don't touch UI.
- **Add or swap source control.** *Why:* "isolate a change, review it, land it" is provider-agnostic; Git and Perforce are just two backends. *Where:* `src/main/scm/` — extend the `SourceControlProvider` base class (`provider.ts`), following `gitProvider.ts` / `perforceProvider.ts`. Behavior that doesn't abstract cleanly is **feature-detected via capabilities**, not `if (provider === …)`, so a very different VCS can even opt into its own client UI without callers special-casing it.
- **Swap the review surface.** *Why:* reviews should land where your team already looks. *Where:* the review providers behind `src/main/reviews/` (GitHub PRs via `git/reviews.ts`, Swarm changelists via `p4/swarmReviews.ts`). The *review procedure itself* — how your shop wants a review done — is intentionally **not** shipped in the tool; it's a per-shop skill you provide, so PopBot recommends and samples but never imposes your standard.
- **Rewire the actions and prompts.** *Why:* branch conventions, PR/review flows, and how you brief an agent are team-specific. *Where:* no code needed — the git-action templates and every seeded prompt (start-ticket, start/re-review) are **editable in Preferences**, with a variable reference card. Change the rigor, the checklist, the tone.
- **Keep the core.** *Why:* these are the ideas that make the whole thing work, and they're the parts you should be slowest to change. Warm slots, copy-on-write workspaces (`src/main/shado/`), persistent chats, the hard-coded permission floor, and the parallel-agent cockpit are the durable spine. Everything else is meant to move.

For the process boundaries, IPC, and where each subsystem lives, read the **[Architecture](ARCHITECTURE.md)** doc — the map for finding the seam you want to change. For the object model (Chat, Slot, AgentSession and their lifecycles), see **[Core Model](CORE_MODEL.md)**.

For teams running more than one agent at a time, this is a working starting point intended to be taken apart and rebuilt around a different workflow.

---

*Some integrations referenced in the original [design spec](POPBOT_DESIGN.md) (Slack, Sentry, and others) exist as connection stubs rather than complete flows; Linear, Jira, GitHub, and Helix Swarm are the fully wired inbox sources. This guide describes how the app actually behaves today.*

# PopBot — Feature & Workflow Guide

PopBot is a desktop cockpit for running **many AI coding agents in parallel**. This guide explains why it exists, the concepts it's built on, every major feature, and what a real day of work looks like end to end.

- [Why we built PopBot](#why-we-built-popbot)
- [Core concepts](#core-concepts)
  - [Agents & models](#agents--models)
  - [Slots & worktrees](#slots--worktrees)
  - [Repoless chats (for code review)](#repoless-chats-for-code-review)
  - [Base branch](#base-branch)
  - [Persistent, archivable chats](#persistent-archivable-chats)
- [Anatomy of the workspace](#anatomy-of-the-workspace)
- [End-to-end workflows](#end-to-end-workflows)
  - [A feature ticket](#a-feature-ticket)
  - [A bug ticket](#a-bug-ticket)
  - [A code review](#a-code-review)
  - [Reopening an archived chat](#reopening-an-archived-chat)
- [Integrated GitHub](#integrated-github)
- [Code review flows](#code-review-flows)
- [Testing in a slot: terminal, editor, and Unity](#testing-in-a-slot-terminal-editor-and-unity)
- [Permissions & safety](#permissions--safety)
- [Preferences](#preferences)
- [Make it yours](#make-it-yours)

---

## Why we built PopBot

A single AI coding agent is easy to run. The moment you want **more than one working at once**, three problems appear:

1. **Isolation.** Two agents editing the same checkout corrupt each other's work. You can't have three agents and one working tree.
2. **Oversight.** Agents are fast and mostly right, but "mostly" isn't good enough for `git push` or `gh pr create`. You need a human gate on the irreversible actions — without babysitting every file edit.
3. **Verification.** Code that compiles isn't code that works. For a game especially, the only real test is *running it* and clicking through. An agent that can't see the app is guessing.

PopBot was built to solve all three for a small team shipping a live game. The insight: treat each unit of work — a ticket, a bug, a PR review — as a **chat**, give each chat its own isolated **git worktree** plus (when needed) its own running copy of the app, run them **autonomously but gated**, and surface the whole fleet in one window so one person can lead a dozen agents at once.

The design was driven by a concrete set of [user stories](USER_STORIES.md): *"As an engineer, I click a ticket and an agent starts working it on a correct branch."* *"As a reviewer, I open a PR and get a real review without checking anything out."* *"As a lead, I glance at the wall and know which agents need me."* Everything below exists to serve those.

---

## Core concepts

### Agents & models

Every chat is driven by one **agent backend**:

- **Claude Code** — via the Claude Agent SDK. Models: **Claude Opus** (default) and **Claude Fable**.
- **Codex** — via the OpenAI Codex SDK. Model: **GPT / Codex**.

PopBot doesn't reimplement these agents — it **drives the real ones** through their official SDKs, which wrap the same **`claude`** and **`codex`** command-line tools you'd run in a terminal. The full power of each agent — its tools, skills, MCP servers, and subagents — is available inside every chat, and PopBot stays in lockstep with whatever version of those CLIs you have installed. If it works in terminal Claude Code, it works here.

Per chat, you choose the backend, the **model**, and the **reasoning effort** (`low` → `xhigh` / `max` — more effort means deeper thinking and more thorough tool use, at higher cost/latency). You can set sensible **defaults** in Preferences — separately for *new chats* and for *code reviews*, since a review wants different depth than a feature build — and override per chat in the composer.

Two session controls matter for long-running work:

- **Switch mid-session.** Change model or effort on an in-flight chat; PopBot reconfigures the agent without losing the thread.
- **Restart with context.** Spin up a *fresh* agent session primed with this chat's transcript (its opening turns plus the most recent ones), useful when a session gets long or wedged. The conversation history is preserved; the agent simply gets a clean runtime.

Credentials for the integrations are stored **locally on your machine**, in the app's own database — never in this repository.

### Slots & worktrees

A **slot** is the unit of parallelism. It's *built on* a **git worktree** — a second (third, fourth…) working directory attached to your repository, checked out to its own branch. Git worktrees are the starting trick: they give each agent a *real, independent checkout* of the same repo without re-cloning, so N agents can edit N branches simultaneously with zero interference.

**But a slot is more than a worktree — it's a warm, stateful workspace.** Alongside the checkout, each slot keeps its own build state that persists across uses: for a Unity project, its own **`Library` import cache**, a dedicated **sidecar server** with its own data directory, assigned **ports**, per-slot logs, and — while a chat is active — a live **Unity Editor process**. A bare `git worktree` gives you isolated *source*; a slot gives you an isolated, already-*warmed* place to build, run, and test.

#### Why slots make Unity development fast

Unity keeps a massive `Library/` folder — the imported, processed form of every asset, often several gigabytes. It is expensive to produce: a fresh checkout, or a branch switch that invalidates it, forces Unity to **reimport the project**, which can take **many minutes**. Pay that on every task and every branch switch and your agents spend more time waiting on Unity than writing code.

Slots eliminate that tax by giving each one its **own persistent `Library`**:

- **Switching a Unity agent back into its slot takes seconds, not minutes** — the import cache is already warm, so only assets that genuinely changed reimport.
- **A slot can keep Unity *running*.** A "sticky" reuse (same slot, same branch) hands the agent a live Editor almost instantly instead of a cold launch.
- **Ten agents don't thrash one import cache.** Each slot has its own warm `Library`, so parallel game work never serializes behind a single Unity reimport.

On creation, a slot's `Library` is copy-on-write cloned from a master checkout, so even the *first* warm-up is cheap — and from then on it simply stays warm. This is the difference between "ten agents fighting over one Unity import cache" and "ten warm workspaces, each ready to run instantly."

PopBot manages a **pool** of these slots:

- When a chat needs to write code, it **leases** a free slot. The slot's worktree is checked out to the chat's branch.
- While leased, that slot is the agent's entire world — it reads, edits, runs commands, and (for game projects) launches the app, all inside that one worktree.
- When the chat closes, the slot is **returned** to the pool for the next chat. Worktrees are expensive to create but cheap to reuse, so PopBot keeps them warm.

Before any branch switch, PopBot runs a **safety sequence** — it stashes uncommitted work (`git stash --include-untracked`), refuses to clobber commits the agent owns, switches branches, and restores state — so a slot handoff never silently loses work.

You configure the pool size in Preferences (how many agents can run at once), and each **repository** gets its own pool, its own worktrees directory, and its own port ranges. Slots can run in **slot-pool** mode (reused, the default) or **ephemeral** mode (a fresh worktree per chat).

> **Why this matters:** branch isolation is what makes "ten agents at once" safe instead of catastrophic. No stashing roulette, no "who touched my files," no serializing work through one tree.

### Repoless chats (for code review)

Not every chat needs a worktree. **Reviewing** a PR is read-only — you don't edit, you read the diff and the surrounding code and post comments. So review chats are **repoless**: they spawn instantly, lease no slot, and consume no worktree.

This is a deliberate, important split:

- A **build chat** (feature/bug) leases a slot, may take seconds to warm up, and holds a worktree for its lifetime.
- A **review chat** is **instant and free** — you can open five of them to triage your review queue while your build chats keep running undisturbed.

It also means your slot pool is reserved for work that actually needs isolation. Reviews never starve builds of slots.

### Base branch

When a chat *does* write code, it forks from a **base branch** — typically `develop` or `main`. PopBot:

- Defaults the base per repository (configurable), and **remembers your last choice** so the common case is one click.
- Lets you pick a different base at creation time when a task needs to branch off a feature branch or a release line.
- Derives the new branch name from your convention — e.g. `<username>/<ticket>-<slug>` — so branches are consistent and traceable back to their ticket.

The base branch also powers git actions later: "rebase onto base," "open PR against base," and drift checks all key off it.

### Persistent, archivable chats

Every chat is a **durable transcript** stored locally — prose, tool calls, diffs, permission decisions, the lot. Nothing is ephemeral.

- **Closing** a chat releases its slot (freeing a worktree for other agents) but **keeps everything**. The chat moves to the **archive**.
- **Reopening** a chat from the archive re-leases a slot, restores its branch, and the agent resumes with its **full history** — you can pick up a feature days later to address review feedback without re-explaining anything.
- The archive is searchable across name, ticket, branch, and content.

Because rollback is just "send another message" (there are no destructive history edits), a chat accumulates the complete, auditable story of how a change was made.

---

## Anatomy of the workspace

![PopBot UI anatomy](../images/anatomy.png)

| Region | What it is |
|---|---|
| **Inbox — tickets & reviews** | Linear tickets assigned to you and GitHub PRs awaiting your review, ranked. Click a row to spawn a chat seeded with its context. |
| **Slots** | The pool of git-worktree workspaces. Each pill shows whether a slot is free or leased by a chat. |
| **Chat archive** | Every past chat, searchable and reopenable with full history. |
| **Chat thumbnails** | A live, scrolling preview of every open chat — a real view of what each agent is doing right now, color-coded by status: blue = running, green = done, yellow = needs you, red = error, gray = idle. |
| **Chats** | The focused agent sessions — streaming prose, tool calls, and inline code diffs. |
| **Per-chat terminal** | An embedded terminal pinned to that chat's worktree. |
| **GitHub panel** | Working-tree status, recent commits, file diffs, and one-click commit / push / PR actions. |

Because every chat stays on the **thumbnail strip** and the **columns sit side by side**, you're never hunting for status. The color is the signal — blue = running, green = done, yellow = needs you, red = error — so a glance tells you which agents are working, which are done, and which are **waiting on you**.

But each thumbnail is also a **live preview of the conversation**, not just a status light — so at a glance you can see *what* every agent is actually working on. That's what lets you **catch useless work early**: spot an agent going down the wrong path and redirect it before it burns time and tokens, instead of discovering the dead end after it's "done." It's the difference between supervising a fleet and being surprised by it.

---

## End-to-end workflows

### A feature ticket

1. **Notification → inbox.** A Linear ticket assigned to you appears in the **Tickets** inbox (PopBot polls your assigned issues, ranked by priority and due date). The notification bell flags it.
2. **One click to start.** Click the ticket row. PopBot opens a **new-chat** dialog defaulted to your repo and base branch (remembered from last time) — confirm, or adjust the agent/model/effort.
3. **Slot allocation.** Because this chat will write code, PopBot **leases a slot**: it picks a free worktree, derives the branch name `you/eng-123-<slug>` from the ticket, and checks the worktree out to it (running the stash-safety sequence first).
4. **Ticket auto-promoted.** The Linear ticket is moved to **In Progress** automatically (idempotent, fire-and-forget) so your board reflects reality without a context switch.
5. **Agent starts.** The agent receives a seeded first message (your customizable *start-ticket* template, filled with the ticket title, description, and branch) and begins: exploring the code, making edits, running commands — all inside its slot's worktree.
6. **Verification in the slot.** For a game change, the agent **launches the app in its slot** (a Unity Editor + sidecar server on a second display) and exercises the feature — clicking through UI, reading logs, screenshotting — instead of guessing that it works.
7. **Gated finish.** When it's ready to push, the agent **pauses** (pushing is a gated action). The thumbnail turns yellow ("needs you").
8. **You review & ship.** Open the **git panel**, read the diff, and hit **Push PR** (or **Push draft**). The action sends a pre-filled instruction to the agent, which pushes the branch and opens the PR against your base branch.

Throughout, you weren't watching — you were doing the same for two other tickets. You only stepped in at the gate.

### A bug ticket

The bug flow is the feature flow with a tighter loop, and it shows off **parallelism**:

1. A bug report arrives (a Linear ticket, or you start a chat manually with the bug description).
2. Spawn a chat → it leases **its own** slot and branch. Your in-flight feature chat is completely untouched — different worktree, different branch.
3. The agent reproduces the bug **by running the app in its slot**, finds the cause, fixes it, and re-runs to confirm the repro is gone.
4. You glance at the **thumbnail strip**: feature chat green (done, awaiting your push), bug chat blue (running). Two agents, two isolated trees, zero collisions.
5. Push the fix when it pauses for approval.

### A code review

1. **Notification → Reviews.** A teammate requests your review. The PR appears in the **Reviews** inbox.
2. **Instant, repoless chat.** Click it → a **review chat** opens immediately — no slot, no checkout, no wait. It's seeded with the *start code review* template (read the surrounding code, not just the diff; trace the systems; hunt for real bugs, races, edge cases, security and perf issues).
3. **Real review.** The agent reads the PR diff **and** the code around it via the `gh` CLI, reasons about correctness, and posts **inline comments** plus a verdict (approve / request changes) on GitHub — then summarizes the red flags for you in the chat.
4. **Re-review later.** If the author pushes fixes, hit **re-review**: PopBot focuses the existing review chat and tells the agent to look **only at the new commits**, verify each prior thread is actually addressed, and update its review.

All of this happens while your build chats keep running — reviews never take a slot.

### Reopening an archived chat

Work is rarely one-and-done. The reopen flow is first-class:

1. A feature chat shipped its PR; you **closed** it to free the slot. It's now in the **archive** (transcript fully preserved).
2. Two days later, the PR gets review comments. Find the chat in the archive (search by ticket, branch, or text) and **reopen** it.
3. PopBot **re-leases a slot**, restores the chat's branch into the worktree, and the agent resumes with its **entire history** — it already knows what it built and why.
4. Paste or summarize the review feedback. The agent addresses it, re-tests in the slot, and pushes the update — no re-onboarding, no lost context.

Because the branch, the transcript, and the reasoning all persist, picking a task back up costs seconds, not a re-explanation.

---

## Integrated GitHub

GitHub is wired in deeply, through the `gh` CLI:

- **Reviews inbox.** PRs requesting your review (and your own recent PRs) surface as one-click chat sources.
- **PR status chips.** Each chat linked to a PR shows a live status chip — Open / Merged / Closed / Draft — that you can click to open the PR on GitHub.
- **The git panel.** For any build chat, see working-tree status, recent commits, and per-file diffs. Click a file to open a full unified-diff overlay.
- **One-click git actions.** Templated, editable actions send a pre-filled instruction to the agent: **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR** (address review comments), **Rebase onto base**. Each expands variables like `${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, and `${prurl}` so the agent has exactly what it needs.
- **PR creation against your base.** Pushing opens the PR against the chat's configured base branch, named by your branch convention.

Because the agent drives `gh` directly, everything it does — comments, reviews, pushes, PRs — is real GitHub activity your team sees in the normal places.

## Code review flows

Review is a distinct, optimized path (see [A code review](#a-code-review) for the click-by-click version):

- **Repoless and instant** — no slot, no checkout. Triage a queue of reviews in seconds.
- **Reads context, not just the diff** — the review template explicitly directs the agent to read surrounding code, trace systems, and look for bugs/races/edge-cases/security/perf, not rubber-stamp the patch.
- **Posts on GitHub** — inline comments and a submitted review (approve / request changes / comment), so the verdict lives where your team works.
- **Re-review is scoped** — on a second pass, the agent is told to examine only new commits and confirm each earlier thread is genuinely resolved before updating its review.
- **Fully customizable** — the *start code review* and *re-review* prompts are editable templates in Preferences, so you can tune the rigor, the checklist, and the tone to your team's bar.

## Testing in a slot: terminal, editor, and Unity

A build chat's slot isn't just a folder — it's a place to **run and inspect** the work:

- **Per-chat terminal.** An embedded terminal (xterm + a real PTY) pinned to the chat's worktree. Run tests, inspect logs, or fire off git commands by hand while the agent works. The terminal persists as you switch between chats.
- **Editor integration.** Every `path/to/file.ts:42` reference in the transcript is a clickable link that opens in **VS Code** or **Cursor**, resolved against the chat's worktree.
- **The app under test (Unity).** For game projects, a slot can launch a real **Unity Editor + sidecar server** — placed on a second display — and expose it to the agent over an in-Editor MCP. The agent can drive the running game: click UI, read logs, screenshot, and verify behavior end-to-end. PopBot manages the lifecycle (start the server, health-check it, start Unity, place its window, and tear everything down on release) and budgets concurrent instances against available RAM.

This is the difference between an agent that *thinks* its change works and one that has *seen* it work.

## Permissions & safety

Autonomy with a hard floor:

- **Auto-allowed (silent):** reads, edits, and shell commands **inside the slot's worktree**, calls to the slot's own services, and internal agent operations. The agent just works.
- **Always gated (pauses for you):** `git push` / reset / force, anything **outside** the worktree, opening PRs, deleting outside a scratch dir, sending messages (Slack/email), touching system or agent config, and network calls to non-allowlisted hosts.
- **Everything else:** prompts you to decide.

When you approve something, you can grant it **once**, **for the session**, or **durably** (always allow this tool/target). Grants are per-chat or global and are all **revocable** in Preferences → Permissions. The hard-deny floor (push, network, out-of-tree) lives in code and is not overridable by UI rules — so a misconfigured grant can't let an agent push to `main` on its own.

## Preferences

Everything is configured in-app (no editing config files):

- **Agents** — default model & reasoning effort, separately for new chats vs. code reviews.
- **Repositories** — add/edit repos: path, base branch, color, slot prefix, worktrees directory, slot-pool vs. ephemeral mode.
- **Runtime & slots** — pool size (how many agents run at once), pre-create/delete slots, attachment retention.
- **Integrations** — connect Linear and GitHub (credentials are stored locally on your machine); test before saving.
- **Source control** — branch-name convention, default base, and the editable git-action templates.
- **External apps** — terminal (iTerm), editor (VS Code / Cursor), Unity binary/subpath, optional Chrome profile for URL routing.
- **Prompt templates** — every seeded prompt (start ticket, start/Re-review, and each git action) is editable, with a variable reference card.
- **Permissions** — review and revoke durable grants.
- **Notifications** — toast placement and alerting behavior.

> For a panel-by-panel walkthrough with screenshots, see the **[Configuration Guide](CONFIGURATION.md)**.

## Make it yours

PopBot was built for one team and one game, but its shape is general: **agents + isolated slots + an inbox-as-queue + an app-under-test.** That pattern applies to almost any team trying to run more than one coding agent without losing the thread.

It's **MIT-licensed** and meant to be forked:

- **Swap the app-under-test.** The Unity integration is one implementation of "let the agent run and verify the app." Replace it with your web app, your CLI, your test harness.
- **Point the inbox elsewhere.** Linear and GitHub are the wired-in sources; the inbox model is generic — adapt it to your tracker.
- **Rewire the git actions.** Branch conventions, PR flows, and the action templates are all yours to change.
- **Keep the core.** Slots, worktrees, persistent chats, the permission floor, and the parallel-agent cockpit are the durable ideas.

If your team is reaching for more than one agent at a time, this is a working, opinionated starting point. Take it apart and rebuild it around your workflow.

---

*Some integrations referenced in the original [design spec](POPBOT_DESIGN.md) (Slack, Sentry, and others) exist as connection stubs rather than complete flows; Linear and GitHub are the fully wired inbox sources. This guide describes how the app actually behaves today.*

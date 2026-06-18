<div align="center">

![PopBot — a battle-tested multi-chat & multi-slot agentic coding tool](images/hero_banner_2.png)

**A Battle-Tested Multi-Chat and Multi-Slot Agentic Coding Tool** — run a team of AI coding agents in parallel, one per ticket, bug, or PR, each isolated in its own warm git-worktree "slot," each able to build, run, and test your app end-to-end.

[Why PopBot](#why-popbot) · [Features](#defining-features) · [How it works](#anatomy-of-the-workspace) · [A day with PopBot](#a-day-with-popbot) · [Make it yours](#make-it-yours)

</div>

---

## Why PopBot

Agentic coding is the easy part now. The hard part is **running many agents at once without chaos**: keeping their work isolated so they don't step on each other, actually *testing* what they build, reviewing it, and never letting one quietly do something dangerous.

PopBot is the orchestration layer for that. It turns your Linear tickets and GitHub review requests into **one-click agent sessions**, gives each agent a real, isolated workspace (its own git worktree — and for game projects, its own running app under test), runs them **autonomously by default**, and pulls every transcript, diff, terminal, and log into a single window. You stay the lead: you skim the columns, approve the risky moves, and ship.

It was built to drive a real production game's development with a small team. We're open-sourcing it as a reference you can **fork and reshape for your own stack and workflow**.

![The PopBot workspace — the thumbnail strip, side-by-side chat columns, and a per-chat terminal](images/screenshot1.png)

<div align="center"><em>A real PopBot session — several agents working in parallel, each in its own slot. Live thumbnails up top, focused chats in columns, a per-chat terminal below, and the git panel on the right.</em></div>

## Defining features

### Multi-chat view with live thumbnails

Every open chat stays on screen — a strip of **live thumbnails** above side-by-side **columns**. Each thumbnail is a real, updating view of that chat (not just a status dot), color-coded by state: running, done, waiting-on-you, error. At a glance you see *what every agent is doing* and who needs you — and you can **catch a wrong path early**, redirecting before it burns time and tokens. One person supervises a whole fleet from one window.

### Warm slots for Unity development

Each working chat leases a **slot** — a **persistent git worktree** plus its own warm build state, created once and reused. For Unity that means the slot keeps its own hot **`Library` import cache** (and can keep the Editor running), so switching an agent back into its slot takes **seconds, not a multi-minute reimport**. Ten agents run in true branch isolation without thrashing a single Unity cache. [How slots work →](docs/GUIDE.md#slots--worktrees)

### Worktree-aware git interface

A built-in **git panel** scoped to *each chat's own worktree*: working-tree status, recent commits, and per-file diffs for exactly that branch — you're never guessing which checkout you're acting on. One-click, templated actions (**Commit**, **Push PR**, **Make ready**, **Address CR**, **Rebase onto base**) send a pre-filled instruction to that chat's agent, with `${branch}` / `${ticket}` / `${prnum}` filled in. Review the diff, click, ship.

### End-to-end workflow

The whole loop in one place: your **inbox** (assigned Linear tickets + GitHub PRs awaiting review) → **in-progress** agent work in isolated slots → **GitHub** (commit, push, open the PR) → **code review** (instant, repoless review chats) → **archive** a finished chat → **reopen and restart** it later with full history to handle review feedback. Click a ticket and PopBot names the branch, leases a slot, moves the ticket to *In Progress*, and seeds the agent — then carries it through to a merged PR and back. [Workflow walkthroughs →](docs/GUIDE.md#end-to-end-workflows)

## Additional features

- **The real Claude Code and Codex — not a reimplementation.** Each chat drives the *actual* agent through its official SDK — the same `claude` and `codex` CLIs you run in a terminal, with all their tools, skills, and MCP servers intact. Pick the model (Opus / Fable / GPT) and reasoning effort per chat, switch mid-session, or restart a fresh session primed with the chat's history.
- **Agents that test their own work.** A slot can launch the real app — for Unity, a live Editor + sidecar server on a second display — so the agent clicks through the UI, reads logs, and verifies its changes instead of guessing.
- **Persistent, archivable chats.** Every chat is a durable transcript; close it to free its slot, and reopen it later with full history intact.
- **Per-chat terminal & clickable code.** An embedded terminal pinned to the chat's worktree, and `file.ts:42` links that open in VS Code or Cursor.
- **Autonomous, but never reckless.** Agents auto-run safe work inside their slot and pause for you on anything risky — `git push`, opening PRs, anything outside the worktree, network calls. Grants are per-chat, durable, and revocable.
- **Multi-repo.** Drive several repositories side by side, each with its own slot pool, color, and branch conventions.

## How PopBot is different

Most agentic coding tools fall into a few buckets. PopBot sits in a different spot: a **local cockpit for running many *real* agents in parallel, with warm build state and live human oversight.**

| Instead of… | …PopBot |
|---|---|
| **One agent in a terminal or IDE** — a single task in a single working tree at a time | **Many agents at once**, each isolated in its own warm slot, all visible as a live fleet you steer from one window |
| **Async cloud agents** (e.g. Devin, hosted Codex) — opaque and remote; submit a task, wait for a PR | **Local and live** — watch each agent work and catch a wrong path early, and it drives *your real app* (a Unity Editor on a second screen) for genuine end-to-end testing |
| **DIY `tmux` + `git worktree` juggling** — parallel but manual, and every fresh checkout pays Unity's multi-minute reimport tax | **Managed warm slots** — reused worktrees that keep their Unity `Library` hot, with branch/worktree lifecycle, the git panel, and code review handled for you |
| **Orchestration frameworks** (CrewAI, AutoGen, …) — toolkits for *building* agent systems | **A finished, opinionated app** wired to your Linear/GitHub inbox and review loop — human-in-the-loop by design, not a library to assemble |

And critically: PopBot doesn't replace Claude Code or Codex — it **runs them**. You get the exact agents (and your exact CLI versions) you already trust, just many at a time, with the orchestration, isolation, and oversight wrapped around them.

## Anatomy of the workspace

![PopBot UI anatomy](images/anatomy.png)

| Region | What it is |
|---|---|
| **Inbox — tickets & reviews** | Your Linear tickets and GitHub review requests, ranked. One click spawns a chat. |
| **Slots** | The pool of warm, isolated workspaces — a git worktree *plus* persistent build state (for Unity, its own hot `Library`). A chat leases one while it works and returns it on close. |
| **Chat archive** | Every past chat, searchable and reopenable with full history. |
| **Chat thumbnails** | A live strip of all open chats — color-coded by status (running / done / needs-you / error). |
| **Chats** | The focused agent sessions: prose, tool calls, and inline code diffs, streaming live. |
| **Per-chat terminal** | An embedded terminal pointed at that chat's worktree, for manual commands. |
| **GitHub panel** | Working-tree status, commits, file diffs, and one-click commit / push / PR actions. |

## A day with PopBot

**A feature ticket.** A Linear ticket lands in your inbox. Click it → PopBot opens a chat on `you/eng-123-…`, leases a slot, moves the ticket to *In Progress*, and hands the agent the full description. It writes the code, runs the app in its slot to verify, and pauses for your OK before pushing. You review the diff in the git panel and hit **Push PR**.

**A bug, in parallel.** While that's running, a bug report comes in. Spawn a second chat — its own slot, its own branch — and the two agents work simultaneously without ever touching each other's tree. The thumbnail strip shows both: one green (done), one blue (running).

**A review request.** A teammate's PR shows up in your Reviews tab. Click it → an instant **repoless** review chat opens, the agent reads the diff *and* the surrounding code, hunts for real bugs, and posts an inline review on GitHub — while your two build chats keep going.

**Pick it back up tomorrow.** Close the finished chats to free their slots. Next morning, reopen the feature chat from the archive to address review feedback — the agent resumes with the entire conversation and its worktree intact.

→ Full walkthroughs (feature, bug, and review flows, plus how slots, worktrees, and reopening work under the hood) are in the **[Feature & Workflow Guide](docs/GUIDE.md)**.

## Requirements

- **macOS** — the primary, tested platform (the second-display app-under-test workflow uses macOS Accessibility APIs). The app is built on Electron + Node and is portable to **Windows**, but Windows hasn't been tested yet.
- **Node 20+**
- The **`claude`** and/or **`codex`** CLIs (the agent backends), plus **`gh`** and **`git`**
- Credentials (Linear, GitHub) are stored **locally on your machine**, in the app's own database — never in this repository
- Optional: a Unity Editor for game projects; VS Code / Cursor; iTerm

```bash
npm install
npm run dev        # run the app in development
npm run package    # build a signed .dmg (see scripts/release.sh for signing)
```

## Make it yours

PopBot was shaped around one team driving one game. But the shape that made it powerful — agents, warm slots, an inbox-as-queue, an app-under-test, and a live fleet view — is **general**. The specifics (Unity, Linear, our branch conventions) are just defaults.

It's **MIT-licensed** and meant to be forked:

- **Swap the app-under-test.** The Unity integration is one implementation of "let the agent run and verify the app." Replace it with your web app, your CLI, your own test harness.
- **Point the inbox elsewhere.** Linear and GitHub are the wired-in sources, but the inbox-as-queue model is generic — adapt it to your tracker.
- **Rewire the git actions.** Branch conventions, PR flows, and the action templates are all yours to change in Preferences or in code.
- **Keep the core.** Warm slots, persistent chats, the live-thumbnail fleet view, and the permission floor are the durable ideas worth keeping.

If your team is reaching for more than one coding agent at a time without losing the thread, this is a working, opinionated starting point. Take it apart and rebuild it around your workflow.

## Documentation

| Doc | What's in it |
|---|---|
| **[Feature & Workflow Guide](docs/GUIDE.md)** | The complete tour — concepts, every feature, and end-to-end workflows. Start here. |
| **[Configuration Guide](docs/CONFIGURATION.md)** | Set up every Preferences panel — integrations, repos, slots, agents — with screenshots. |
| [USER_STORIES.md](docs/USER_STORIES.md) | The user stories PopBot was measured against. |
| [CORE_MODEL.md](docs/CORE_MODEL.md) | The object model — Chat, Message, Slot, AgentSession — and their lifecycles. |
| [POPBOT_DESIGN.md](docs/POPBOT_DESIGN.md) | The original design spec (historical). |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process boundaries, IPC, where each subsystem lives. |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local dev setup, scripts, conventions. |

## License

[MIT](LICENSE) © 2026 Proof of Play, Inc. Third-party components and trademarks are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — note that the `@anthropic-ai/claude-agent-sdk` runtime dependency is proprietary and used under Anthropic's terms, not the MIT grant.

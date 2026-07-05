<div align="center">

![PopBot — a battle-tested multi-chat & multi-slot agentic coding tool](images/hero_banner_2.png)

A battle-tested desktop tool for running a team of AI coding agents in parallel — one per ticket, bug, or review, each isolated in its own warm "slot," each able to build, run, and test your app end-to-end.

[Why PopBot](#why-popbot) · [Features](#defining-features) · [How it works](#anatomy-of-the-workspace) · [A day with PopBot](#a-day-with-popbot) · [Install](#install) · [Make it yours](#make-it-yours)

</div>

---

## Why PopBot

Running a single AI coding agent is straightforward. Running many at once introduces problems a single agent doesn't have: keeping their work isolated so they don't overwrite each other, actually testing what they build, reviewing it, and gating the irreversible actions so no agent takes one unsupervised.

PopBot is an orchestration layer for that. It turns tickets and review requests into one-click agent sessions, gives each agent an isolated workspace (its own working copy — and, for game projects, its own running app under test), runs them autonomously by default with a human gate on risky actions, and collects every transcript, diff, terminal, and log into a single window. The operator skims the columns, approves the gated actions, and ships.

It was built by a small team at **Proof of Play** and used daily on a real, asset-heavy production project that shipped. That's the environment it was proven in: many gigabytes of assets, real source control, real deadlines. The slot model — warm, isolated, copy-on-write workspaces — is what made running agents in parallel practical there, and it increased how much the team could get done at once. We publish and support PopBot as a reference implementation: not a finished product to consume as-is, but a shape to take and reshape for your own stack and workflow. This reflects a view about how software is best built in the age of AI — that teams running fleets of agents are better served owning and modifying the tool than adopting a fixed one. It is MIT-licensed and organized to be forked; see [Make it yours](#make-it-yours).

![The PopBot workspace — the thumbnail strip, side-by-side chat columns, and a per-chat terminal](images/screenshot1.png)

<div align="center"><em>A real PopBot session — several agents working in parallel, each in its own slot. Live thumbnails up top, focused chats in columns, a per-chat terminal below, and the source-control panel on the right.</em></div>

## Defining features

### Multi-chat view with live thumbnails

Every open chat stays on screen — a strip of **live thumbnails** above side-by-side **columns**. Each thumbnail is a real, updating view of that chat (not just a status dot), color-coded by state: running, done, waiting-on-you, error. At a glance you see *what every agent is doing* and who needs you — and you can **catch a wrong path early**, redirecting before it burns time and tokens. One person supervises a whole fleet from one window.

### Warm slots — parallel agents without the re-import tax

Each working chat leases a **slot** — a persistent working copy plus its own warm build state, created once and reused. For a game engine that means the slot keeps its own hot asset cache (Unity's `Library`, Unreal's DDC) and can keep the editor running, so switching an agent back into its slot takes **seconds, not a multi-minute reimport**. Ten agents run in true branch isolation without thrashing a single import cache. [How slots work →](docs/GUIDE.md#slots-warm-isolated-disposable-workspaces)

### Unlimited copies on one repo's disk

A slot's workspace is a **copy-on-write folder**: every slot shares one base image and stores only what it changes. So a fresh, live, full copy of a **terabyte-scale** game tree is ready in **seconds** — real editable files, not a shallow view — and unlimited copies cost the disk of a single repo. It works on **Windows, macOS, and Linux**, and it's what lets huge Perforce trees join the fleet at all. [Why this matters →](docs/GUIDE.md#copy-on-write-unlimited-copies-on-one-repos-disk)

### Git and Perforce, with review built in

Source control is a **provider** behind one interface: **Git** (worktrees, branches, PRs via `gh`) and **Perforce** (streams over shadow workspaces, changelists, **Helix Swarm** reviews) are both first-class. A source-control panel scoped to *each chat's own workspace* shows status, commits, and per-file diffs for exactly that branch. One-click, templated actions (**Commit**, **Push PR**, **Make ready**, **Address CR**, **Rebase onto base**) send a pre-filled instruction to that chat's agent, with `${branch}` / `${ticket}` / `${prnum}` filled in.

### One inbox, many sources

The whole loop in one place: your **inbox** — assigned tickets from **Linear**, **Jira**, and **GitHub Issues**, plus reviews awaiting you as **GitHub PRs** and **Swarm changelists** → **in-progress** agent work in isolated slots → **push** and open the PR / review → **archive** a finished chat → **reopen and restart** it later with full history. Click a ticket and PopBot names the branch, leases a slot, moves the ticket to *In Progress*, and seeds the agent — then carries it through to a merged change and back. [Workflow walkthroughs →](docs/GUIDE.md#end-to-end-workflows)

## Additional features

- **The real Claude Code and Codex — not a reimplementation.** Each chat drives the *actual* agent through its official SDK — the same `claude` and `codex` CLIs you run in a terminal, with all their tools, skills, and MCP servers intact. Pick the model (Opus / Fable / GPT) and reasoning effort per chat, switch mid-session, or restart a fresh session primed with the chat's history.
- **Agents that test their own work.** A slot can launch the real app — for Unity and Unreal, a live editor + sidecar server on a second display, driven by the agent over an in-editor MCP server on a **per-slot port** — so the agent clicks through the UI, reads logs, and verifies its changes instead of guessing. Custom engines are supported too.
- **Persistent, archivable chats.** Every chat is a durable transcript; close it to free its slot, and reopen it later with full history intact.
- **Per-chat terminal & clickable code.** An embedded terminal pinned to the chat's workspace, and `file.ts:42` links that open in VS Code or Cursor.
- **Autonomous, but never reckless.** Agents auto-run safe work inside their slot and pause for you on anything risky — `git push` / `p4 submit`, opening PRs, anything outside the workspace, network calls. Grants are per-chat, durable, and revocable — MCP servers included.
- **Fully localized.** The entire interface ships in eight languages (English, Spanish, French, German, Japanese, Korean, Simplified Chinese, Brazilian Portuguese), switchable any time from the language menu.
- **Multi-repo.** Drive several repositories side by side, each with its own slot pool, color, provider, and branch conventions.

## How PopBot is different

Agentic coding tools tend to fall into a few buckets. PopBot sits in a different spot: a **local cockpit for running many *real* agents in parallel, with warm build state and live human oversight.**

| Instead of… | …PopBot |
|---|---|
| **One agent in a terminal or IDE** — a single task in a single working tree at a time | **Many agents at once**, each isolated in its own warm slot, all visible as a live fleet you steer from one window |
| **Async cloud agents** — opaque and remote; submit a task, wait for a PR | **Local and live** — watch each agent work and catch a wrong path early, and it drives *your real app* (an engine editor on a second screen) for genuine end-to-end testing |
| **DIY `tmux` + worktree juggling** — parallel but manual, and every fresh checkout pays the engine's multi-minute reimport tax | **Managed warm slots** — reused, copy-on-write workspaces that keep the asset cache hot, with branch/workspace lifecycle, the SCM panel, and code review handled for you |
| **Agent-orchestration frameworks** — toolkits for *building* agent systems | **A finished, opinionated app** wired to your inbox and review loop — human-in-the-loop by design, not a library to assemble |

And critically: PopBot doesn't replace Claude Code or Codex — it **runs them**. You get the exact agents (and your exact CLI versions) you already trust, just many at a time, with the orchestration, isolation, and oversight wrapped around them.

## Anatomy of the workspace

![PopBot UI anatomy](images/anatomy.png)

| Region | What it is |
|---|---|
| **Inbox — tickets & reviews** | Assigned tickets (Linear / Jira / GitHub Issues) and reviews awaiting you (GitHub PRs / Swarm changelists), ranked. One click spawns a chat. |
| **Slots** | The pool of warm, isolated workspaces — a copy-on-write working copy *plus* persistent build state (for a game engine, its own hot asset cache). A chat leases one while it works and returns it on close. |
| **Chat archive** | Every past chat, searchable and reopenable with full history. |
| **Chat thumbnails** | A live strip of all open chats — color-coded by status (running / done / needs-you / error). |
| **Chats** | The focused agent sessions: prose, tool calls, and inline code diffs, streaming live. |
| **Per-chat terminal** | An embedded terminal pointed at that chat's workspace, for manual commands. |
| **SCM panel** | Working-tree / changelist status, commits, file diffs, and one-click commit / push / PR / review actions. |

## A day with PopBot

**A feature ticket.** A ticket lands in your inbox. Click it → PopBot opens a chat on `you/eng-123-…`, leases a slot, moves the ticket to *In Progress*, and hands the agent the full description. It writes the code, runs the app in its slot to verify, and pauses for your OK before pushing. You review the diff in the SCM panel and hit **Push PR**.

**A bug, in parallel.** While that's running, a bug report comes in. Spawn a second chat — its own slot, its own branch — and the two agents work simultaneously without ever touching each other's tree. The thumbnail strip shows both: one green (done), one blue (running).

**A review request.** A teammate's PR (or Swarm changelist) shows up in your Reviews tab. Click it → an instant **repoless** review chat opens, the agent reads the diff *and* the surrounding code, hunts for real bugs, and posts an inline review on GitHub or Swarm — while your two build chats keep going.

**Pick it back up tomorrow.** Close the finished chats to free their slots. Next morning, reopen the feature chat from the archive to address review feedback — the agent resumes with the entire conversation and its workspace intact.

→ Full walkthroughs (feature, bug, and review flows, plus how slots, copy-on-write workspaces, and reopening work under the hood) are in the **[Feature & Workflow Guide](docs/GUIDE.md)**.

## Install

Signed, prebuilt installers are available at **[popbot.app](https://popbot.app)**:

- **macOS** — signed & notarized `.dmg` (Apple silicon)
- **Windows** — signed `.exe` installer
- **Linux** — `.deb` package

The app auto-updates from its release channel. To run your own build instead, see [Build from source](#build-from-source).

## Build from source

```bash
npm install
npm run dev        # run the app in development
npm run package    # build a signed installer for your platform
```

**Requirements**

- **macOS, Windows, or Linux.** macOS is the most-exercised platform (the second-display app-under-test workflow leans on macOS Accessibility APIs); Windows and Linux are supported and shipped — see [WINDOWS.md](docs/WINDOWS.md) for the Windows/WSL setup notes.
- **Node 20+** (Node 20 / 22 avoid a native-module recompile; see the Windows notes).
- The **`claude`** and/or **`codex`** CLIs (the agent backends), plus **`git`** and, for GitHub flows, **`gh`**. For Perforce, the **`p4`** CLI.
- Credentials (Linear, Jira, GitHub, Helix Swarm) are stored **locally on your machine**, in the app's own database — never in this repository.
- Optional: a Unity or Unreal editor for game projects; VS Code / Cursor; iTerm.

## Make it yours

PopBot is published as a reference implementation, meant to be forked and adapted rather than adopted as-is. Its shape is general — **agents + isolated, warm, copy-on-write slots + an inbox-as-queue + an app-under-test** — and the code is organized as *providers behind small common interfaces*, so a team can swap one part without touching the rest. It is **MIT-licensed**. The general approach is to keep the core ideas and replace the specific instances:

- **Swap the app-under-test.** Unity and Unreal are two implementations of "let the agent run and verify the app." The custom-engine hook already passes slot identity through to your launch command — point it at your web app, CLI, or test harness. *(`src/shared/gameEngine.ts`, `src/main/ipc/apps.ts`)*
- **Point the inbox elsewhere.** Linear, Jira, and GitHub Issues are worked examples; add a tracker by implementing one interface and registering it. *(`src/main/tickets/`)*
- **Add or swap source control.** Extend the provider base class alongside Git and Perforce; callers branch on *capabilities*, never on provider id. *(`src/main/scm/`)*
- **Rewire the actions and prompts.** Branch conventions, PR/review flows, and every seeded prompt are editable templates in Preferences — no code required.
- **Keep the core.** Warm slots, copy-on-write workspaces, persistent chats, the hard-coded permission floor, and the parallel-agent cockpit are the durable spine.

The **[Feature & Workflow Guide](docs/GUIDE.md)** explains the reasoning behind each seam; the **[Architecture](docs/ARCHITECTURE.md)** doc maps where to find it in the code.

## Documentation

| Doc | What's in it |
|---|---|
| **[Feature & Workflow Guide](docs/GUIDE.md)** | The complete tour — the ideas, how each piece works, and end-to-end workflows. Start here. |
| **[Configuration Guide](docs/CONFIGURATION.md)** | Set up every Preferences panel — integrations, repos, slots, agents — with screenshots. |
| [USER_STORIES.md](docs/USER_STORIES.md) | The user stories PopBot was measured against. |
| [CORE_MODEL.md](docs/CORE_MODEL.md) | The object model — Chat, Message, Slot, AgentSession — and their lifecycles. |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process boundaries, IPC, where each subsystem lives. |
| [WINDOWS.md](docs/WINDOWS.md) | Windows / WSL setup notes. |
| [POPBOT_DESIGN.md](docs/POPBOT_DESIGN.md) | The original design spec (historical). |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local dev setup, scripts, conventions. |

## License

[MIT](LICENSE) © 2026 Proof of Play, Inc. Third-party components and trademarks are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — note that the `@anthropic-ai/claude-agent-sdk` runtime dependency is proprietary and used under Anthropic's terms, not the MIT grant.

# 0004. Autonomy policy lives in `canUseTool`, not the prompt

> **Status:** accepted
> **Date:** 2026-05-01

## Context

PopBot defaults to autonomous mode: agents auto-approve safe tool calls and only pause when truly stuck or about to take a risky action. We need a place to enforce "don't push to main, don't delete branches, don't `gh pr create` without me, don't touch anything outside the slot's worktree."

Two natural places to put that logic:

1. In the system prompt / per-chat instructions ("you are forbidden from doing X").
2. In code — the SDK's `canUseTool` callback, evaluated programmatically before the tool actually runs.

## Decision

Policy lives **in `canUseTool`**, in the main process, as a hard veto. The agent's prompt never carries safety-critical rules.

## Consequences

- The model cannot talk itself into ignoring a rule. Every tool call passes through `popbotPolicy.evaluate(tool, args, chat)`; deny is final.
- The deny-list is hard-coded and never overridable by chat config. (Per-chat config can only narrow autonomy, never widen the deny-list.)
- Allow-list is mode-dependent: in `Interactive` mode, every tool prompts; in `Autonomous` mode, safe tools auto-approve and risky tools always pause for the user.
- The prompt stays purely behavioral ("here's the task, here's the context"), which is what models are good at responding to.
- Adding a new "always pause" rule is a code change with tests, not a prompt-engineering exercise.

## Alternatives considered

- **Prompt-only enforcement** — the failure mode is well-documented across the industry: the model is helpful and will rationalize past instructions when the task seems to require it. Unacceptable for tools like `git push`, `rm -rf`, `gh pr create`.
- **Both prompt and `canUseTool`** — fine, and we may add gentle prompt nudges later, but the prompt is **never the only line of defense**. `canUseTool` is the source of truth.

## Always-pause set (initial)

- `git push`, `git reset --hard`, `git checkout --`, force-anything, branch deletion
- Anything outside the slot's worktree path
- Network calls to non-allowlisted hosts
- `rm -rf` outside `tmp/` or the slot dir
- `gh pr create` and any GitHub publish action
- Slack / email / external messaging
- Modifying `~/.claude`, `.mcp.json`, system config

## Auto-approve set in autonomous mode (initial)

- Read / Edit / Write / Grep / Glob inside the slot's worktree
- Bash inside worktree, with the deny-list applied
- MCP calls to the slot's own MCP server
- Skill / sub-agent invocations
- TodoWrite, internal SDK ops

# 0002. Use the Claude Agent SDK, not the `claude` CLI

> **Status:** accepted
> **Date:** 2026-05-01

## Context

PopBot needs to host multiple Claude Code agent sessions concurrently. Each session needs:

- Per-session working directory (the slot's worktree).
- Per-session `mcpServers` map (the slot's Unity MCP URL).
- A typed event stream (text deltas, tool_use start/end, tool_result, permission_request, message_done, usage).
- A hard-veto hook on every tool call (the autonomy policy boundary).
- Inheritance of skills, memory, sub-agents, hooks from the user's Claude config.

Two ways to integrate: subprocess-scrape the `claude` CLI, or use `@anthropic-ai/claude-agent-sdk` programmatically.

## Decision

Use **`@anthropic-ai/claude-agent-sdk`** as the v1 integration. Wrap it behind an `AgentBackend` interface so a Codex backend can adapt to the same shape later (Phase 4).

## Consequences

- We get structured `permission_request` events; the policy engine plugs in via `canUseTool` cleanly. No fragile stdout parsing.
- Skills, memory, sub-agents, MCP, and hooks just work — the SDK reads `~/.claude/` and `.mcp.json` automatically when we point `cwd` at the slot's worktree.
- Per-slot MCP injection is one field in the spawn options.
- We're locked to the SDK's Node API surface; SDK upgrades are our responsibility to track.
- The CLI is still useful for the user to invoke directly outside PopBot; we're not displacing it.
- The `AgentBackend` interface is defined day-one even though only one impl exists, so the Codex adapter is a discrete future task, not a refactor.

## Alternatives considered

- **Subprocess-scrape the `claude` CLI** — every advanced feature (typed permission requests, structured tool events, programmatic interrupts) becomes string parsing. We'd fight the CLI for the rest of the project's life.
- **HTTP API directly** — re-implements the agent loop, tool routing, MCP integration, skills, and memory. Months of work; not the value we add.

# Architecture Decision Records

Each significant architectural decision gets one short markdown file capturing **what**, **why**, and **what we considered instead**.

## Convention

Filename: `NNNN-kebab-case-title.md`, where `NNNN` is a zero-padded sequence number. Sequence is allocation-order, not priority-order.

Each ADR uses the following shape:

```markdown
# NNNN. Title

> **Status:** proposed | accepted | superseded by ADR-XXXX
> **Date:** YYYY-MM-DD

## Context
What's going on. The forces in tension that demanded a decision.

## Decision
The choice we made. One sentence; details below if needed.

## Consequences
What this commits us to. The good, the awkward, the future-blocking.

## Alternatives considered
What else we looked at and why it lost.
```

When a decision is reversed, **don't delete the ADR.** Mark the old one `superseded by ADR-XXXX` and write a new one. The history is the value.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-tech-stack.md) | Electron + Vite + React + TS + Tailwind | accepted |
| [0002](0002-claude-agent-sdk.md) | Use Claude Agent SDK, not the CLI | accepted |
| [0003](0003-slot-as-durable-unit.md) | Collapse Library/process/worktree pools into one "slot" | accepted |
| [0004](0004-canusetool-policy-boundary.md) | Autonomy policy lives in `canUseTool`, not the prompt | accepted |
| [0005](0005-gui-unity-on-screen-2.md) | GUI Unity on screen 2 is the v1 default; headless is Phase 4 | accepted |

# 0003. Collapse Library/process/worktree pools into one "slot"

> **Status:** accepted
> **Date:** 2026-05-01

## Context

Early sketches had three separate pools: a worktree pool (cheap), a Unity Library pool (expensive — ~8 GB each, slow to import on first launch), and a Unity process pool (so we could keep hot Editors warm). They'd be mixed and matched: a worktree could borrow any free Library via symlink, then any free Editor process.

That sounded flexible. In practice it created three independent lifecycles with three independent failure modes (orphaned symlinks, process pinned to wrong Library, Library "drift" from edits in the borrowed worktree) plus a complicated lease coordination layer.

`git worktree add` on AutoRPG measured at ~23 seconds (LFS smudge over 62k files), so worktrees aren't actually cheap. And we never want to "swap" a Library between worktrees during normal operation — it's expensive and dangerous.

## Decision

**One concept: the slot.** A slot owns a persistent git worktree, its own Library, optionally its own running Unity Editor, and optionally its own running sidecar server. Slots are **created rarely** (Phase 2: usually 2-3, configurable), **reused continuously** via branch checkout, and live under `~/Library/Application Support/PopBot/slots/slot-N/`.

## Consequences

- Per-slot directory has clear ownership: worktree, Library, server-data, ports, logs, slot.json — all in one tree, all reset together.
- Lease policy is simple: prefer a slot already on the requested branch with a hot Unity (sticky hit, ~50 ms); else cold-start that slot's Unity (15-30 s); else `git checkout` in an LRU free slot (5-15 s); else queue or evict.
- Branch uniqueness across worktrees is the one git constraint we have to handle: two test chats on the same branch use detached HEAD or a temp branch.
- Disk cost is real: ~14 GB per slot (~8 GB Library + ~5.5 GB Assets + scratch). 4 slots = ~55 GB. Surface this in prefs and provide "reset slot" to reclaim.
- No symlinks. No cross-pool coordination. No background "library steward" process.
- We give up the (theoretical) ability to swap a hot Editor onto a different worktree for free. We never actually wanted that.

## Alternatives considered

- **Three-pool design** (described above). Rejected — combinatorial failure modes for no measured benefit.
- **One global Library, multiple worktrees pointing into it via symlink** — fights Unity. Unity assumes Library matches Assets; concurrent workers corrupt it.
- **Ephemeral worktrees per chat, shared Library cache.** Slot creation cost (~1-3 min cold) makes per-chat creation unworkable for the many-quick-chats workflow. Slot reuse via checkout is the everyday hot path.

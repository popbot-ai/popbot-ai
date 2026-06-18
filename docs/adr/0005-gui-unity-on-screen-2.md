# 0005. GUI Unity Editor on screen 2 is the v1 default; headless is Phase 4

> **Status:** accepted
> **Date:** 2026-05-01

## Context

For agents to drive the game, Unity has to be running. Two options for v1:

1. **Headless `-batchmode`** — Unity runs without a window, agent drives via the in-Editor MCP only. Cleanest from a UX standpoint (no flashing windows), but requires that AutoRPG actually starts and reaches Play mode under `-batchmode`. That's an open question — some Unity projects work, some hit IL2CPP/audio/rendering subsystem assumptions that fail without a window.
2. **Windowed Editor on a configured display** — real Unity window, placed on the user's second monitor by a native macOS helper, optionally minimized. Visually present (you can watch the agent play); definitely works because the path matches everyday human use.

## Decision

**Default to GUI Editor on screen 2** for v1. Use a small Swift helper (`native/popbot-windowmover/`) to position the window after launch. Treat `-batchmode` as a Phase 4 opt-in after a separate validation script proves it works on AutoRPG.

## Consequences

- Zero risk that the test harness diverges from human-played behavior — the agent's Unity is exactly the user's Unity.
- The user can watch agents work, which is debugging gold during the early weeks.
- A native helper (~50-100 LOC Swift) is a real piece of infra to build, ship in `Contents/Resources/`, and ask the user to grant Accessibility permission for. Onboarding cost: one-time grant + a "Right-click Unity in Dock → Options → Assign To: Desktop X" hint.
- Multiple Editor windows on screen 2 will jostle for position. Per-slot configurable rect handles it.
- Headless lands later — same architecture, only the launch flag and the helper invocation differ. No rewrite.

## Alternatives considered

- **Headless first** — nice but speculative. If `-batchmode` doesn't work on AutoRPG (open question #1 in the design doc), Phase 2 stalls behind a multi-day rabbit hole. Defer until we can validate cheaply.
- **Off-screen window** — possible but fragile. macOS doesn't promise to keep an off-screen window rendering deterministically.
- **Virtual display via macOS APIs** — over-engineered for v1. Re-evaluate if multi-instance Unity on a single monitor becomes the bottleneck.

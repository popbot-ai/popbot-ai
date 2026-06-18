# Development

## Prerequisites

- macOS (only supported platform for v1)
- Node 20 LTS or newer (`.nvmrc` will pin once scaffold lands)
- pnpm (preferred) or npm
- Xcode Command Line Tools (`xcode-select --install`) — needed for the native Swift helper and any node-gyp builds
- A clone of [`autorpg`](../../autorpg) at `~/pop/autorpg` for end-to-end testing

## First-time setup

> Pending the Electron scaffold (Phase 2). This section will fill in once `package.json` lands.

```bash
# placeholder — coming soon
pnpm install
pnpm dev
```

## Scripts (planned)

| Command | Purpose |
|---|---|
| `pnpm dev` | Vite dev server + Electron main with reload |
| `pnpm build` | Production renderer + main bundles |
| `pnpm package` | electron-builder → `release/` (.dmg) |
| `pnpm typecheck` | tsc --noEmit across main, preload, renderer, shared |
| `pnpm lint` | ESLint + Prettier check |
| `pnpm test` | Vitest unit tests |

## Repo conventions

- **TypeScript everywhere.** No `.js` outside config files. Strict mode on.
- **No raw IPC in components.** Renderer talks to main via the typed `window.popbot.*` bridge defined in `src/preload/`.
- **Renderer is pure view.** No fs, no child_process, no node modules with native bindings. If a component needs persistence or a system call, expose it through main + IPC.
- **One file per React component**, named in `PascalCase.tsx`. Hooks live alongside the component when private, or in `renderer/hooks/` when shared.
- **Tailwind first, scoped CSS second.** The ported `design/prototype/styles.css` becomes a Tailwind layer + a small set of CSS custom properties for the dark theme tokens (`--bg-1`, `--fg-2`, etc.).

## Working with the design prototype

The original prototype lives at [`../design/prototype/`](../design/prototype/) and is **frozen reference**, not a build target. See [`design/README.md`](../design/README.md) for how to view it.

When porting a component:

1. Open the matching `*.jsx` next to your `.tsx` for visual reference.
2. Strip the `useStateA`/`useEffectA` aliases (a hack the prototype used to avoid global collisions).
3. Replace `INITIAL_CHATS` and other module-level fixtures with imports from `renderer/fixtures/` or, eventually, IPC calls.
4. Stay close to the prototype's visual + interaction behavior — see [memory: stick close to the design](../).

## Commit style

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Body ≤ 72 cols. Lead with **why**, not **what**.
- One PR per logical change. Don't bundle scaffold + features.

## Working with related repos

PopBot drives the AutoRPG Unity project + sidecar server. Several Phase 0 prereqs land in that repo, not this one:

- `POPBOT_MCP_PORT` env override on the in-Editor MCP
- `./run_local.sh --port` and `--data-dir` flags
- `/health` endpoint extensions

When you're working on those, `cd ~/pop/autorpg` and follow that repo's conventions.

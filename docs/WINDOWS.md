# Running PopBot on Windows

PopBot is built on Electron + Node and runs on Windows, but a few setup
steps differ from macOS — mostly around the two native modules
(`better-sqlite3`, `node-pty`) and one Electron quirk. This doc captures
the working setup.

## Prerequisites

- **Node 20 LTS or newer.** Node 24 works for *running* the app, but it's
  so new that `better-sqlite3` has no matching prebuilt binary, so a plain
  `npm install` tries to compile it from source against Node's ABI and can
  fail (see "Native modules" below). Node 20 / 22 avoid that compile.
- **Git for Windows** (`git`) and **GitHub CLI** (`gh`) on `PATH`.
- The **`claude`** CLI on `PATH` (a `claude.exe` — PopBot discovers it via
  `where.exe`). `codex` is optional.
- **Visual Studio Build Tools 2022** with the *Desktop development with
  C++* workload — only needed if a native module has to compile from
  source (e.g. `node-pty`'s winpty).

## First-time setup

The native modules must be built for **Electron's** ABI, not your system
Node's. The reliable sequence:

```bash
# 1. Install JS deps without running native build scripts (avoids the
#    Node-ABI source build of better-sqlite3 that rolls back the install).
npm install --ignore-scripts

# 2. Download the Electron binary that step 1 skipped.
node node_modules/electron/install.js

# 3. Build the native modules against Electron's ABI.
npx electron-rebuild -f -w better-sqlite3,node-pty

# 4. Run it.
npm run dev
```

If you used `--ignore-scripts`, step 2 is required — otherwise
electron-vite fails with `Error: Electron uninstall`.

## Two gotchas you may hit

### `node-pty` build: `'GetCommitHash.bat' is not recognized`

`node-pty` bundles **winpty**, whose build runs `cd shared &&
GetCommitHash.bat`. If your environment sets
**`NoDefaultCurrentDirectoryInExePath=1`** (a security hardening flag),
cmd.exe refuses to run the `.bat` from the current directory and the build
fails. Clear it for the build:

```powershell
$env:NoDefaultCurrentDirectoryInExePath = $null
npx electron-rebuild -f -w node-pty
```

### `Cannot read properties of undefined (reading 'setName')` on launch

This means Electron started as **plain Node** instead of as Electron, so
`electron.app` is `undefined`. It happens when `ELECTRON_RUN_AS_NODE` is
present in the environment — and on Windows, Electron treats the *mere
presence* of that variable (even empty) as "run as Node". This bites when
you launch from a terminal embedded in another Electron app (VS Code,
Claude Code), which exports `ELECTRON_RUN_AS_NODE=1`.

`npm run dev` / `npm run start` go through `scripts/electron-vite.mjs`,
which **deletes** the variable before starting Electron, so this is
handled. If you invoke `electron-vite` directly, make sure
`ELECTRON_RUN_AS_NODE` is unset (not just empty).

## Packaging

```bash
npm run package:win    # NSIS installer + zip → release/
```

Windows builds are currently **unsigned**, so SmartScreen warns on first
launch. Set `CSC_LINK` (path to a `.pfx`) and `CSC_KEY_PASSWORD` to sign.

## Feature parity notes

- **Agents, chats, git worktrees, the embedded terminal, and the Git
  panel** all work on Windows.
- **External app launchers** (the per-slot icon row): "Open terminal"
  (Windows Terminal / cmd), "Open editor" (VS Code / Cursor), and "Open
  git client" (GitHub Desktop) are wired up. **Unity** launch/focus and
  the per-slot "running app" detection are macOS-only for now (they rely
  on `ps`/`lsof`/AppleScript) and no-op on Windows.
- The macOS-specific bits — Dock menu, login-shell `PATH` patching,
  Chrome-profile URL routing — are guarded and simply skipped on Windows.

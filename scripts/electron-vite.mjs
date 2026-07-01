#!/usr/bin/env node
/**
 * Cross-platform launcher for electron-vite that GUARANTEES
 * `ELECTRON_RUN_AS_NODE` is removed from the environment before Electron
 * starts.
 *
 * Why this exists: Electron treats the mere *presence* of
 * `ELECTRON_RUN_AS_NODE` — even set to an empty string — as "run this
 * binary as plain Node, not as Electron". On Windows that means
 * `cross-env ELECTRON_RUN_AS_NODE= electron-vite dev` is NOT enough:
 * cross-env sets the variable to "" (still present), so Electron boots
 * as Node and `electron.app` comes back `undefined` ("Cannot read
 * properties of undefined (reading 'setName')").
 *
 * This bites whenever the launching shell already exports the variable —
 * e.g. a terminal embedded inside another Electron app (VS Code, Claude
 * Code). Deleting the key outright is the only reliable fix, and a tiny
 * Node shim is the only way to `delete` an env var portably across
 * PowerShell, cmd, and POSIX shells.
 *
 * Usage (from package.json scripts): node scripts/electron-vite.mjs <args>
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

delete process.env.ELECTRON_RUN_AS_NODE;

const require = createRequire(import.meta.url);
// Resolve electron-vite's CLI entry from node_modules so we don't depend
// on PATH / .bin shims (which differ between platforms). The `bin/`
// subpath isn't in the package's `exports`, so resolve via its
// package.json (which every package exposes) and join the bin path.
const pkg = require('electron-vite/package.json');
const pkgRoot = dirname(require.resolve('electron-vite/package.json'));
const cliPath = join(pkgRoot, pkg.bin['electron-vite']);

const isWindows = process.platform === 'win32';

// On POSIX, run the dev stack (electron-vite → vite → Electron) in its OWN
// session via `detached` (setsid) so it has NO controlling terminal. Electron's
// main process spawns child shells at runtime — notably the claude/codex PATH
// probes (`$SHELL -ilc 'command -v …'`), which the renderer polls for the
// agent-status indicator. An interactive shell runs terminal job-control
// (tcsetpgrp), which delivers SIGTTOU to its entire process group; if the dev
// stack shared our group that signal would SUSPEND `npm run dev` ("[1]+
// Stopped", needing repeated `fg`). With no controlling terminal those shells
// can't job-control us, so the launch can't be suspended. Signals are forwarded
// below so Ctrl+C still tears everything down.
// (Not on Windows: `detached` there spawns a separate console window.)
const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  detached: !isWindows,
});

// Ctrl+C / kill reach this foreground launcher, not the detached child's
// session — forward them to the child's process group so the whole stack stops.
if (!isWindows) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* child already gone */
      }
    });
  }
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('[electron-vite launcher]', err);
  process.exit(1);
});

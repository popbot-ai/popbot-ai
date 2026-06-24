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

const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('[electron-vite launcher]', err);
  process.exit(1);
});

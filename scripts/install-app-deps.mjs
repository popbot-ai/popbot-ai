#!/usr/bin/env node
/**
 * postinstall shim: runs `electron-builder install-app-deps` (which
 * rebuilds the native modules — better-sqlite3, node-pty — for Electron's
 * ABI) with `ELECTRON_RUN_AS_NODE` REMOVED from the environment.
 *
 * Why a shim instead of `cross-env ELECTRON_RUN_AS_NODE= …`: Electron
 * treats the mere *presence* of `ELECTRON_RUN_AS_NODE` (even empty) as
 * "run as plain Node", and cross-env sets it to "" without deleting it.
 * When `npm install` runs inside a terminal embedded in another Electron
 * app (VS Code, Claude Code) that exports the var, the empty-but-present
 * value can make electron-builder's tooling misbehave. Deleting the key
 * is the only reliable fix — same approach as scripts/electron-vite.mjs.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

delete process.env.ELECTRON_RUN_AS_NODE;

const require = createRequire(import.meta.url);
const pkg = require('electron-builder/package.json');
const pkgRoot = dirname(require.resolve('electron-builder/package.json'));
// electron-builder exposes a dedicated `install-app-deps` bin entry.
const cliPath = join(pkgRoot, pkg.bin['install-app-deps']);

const child = spawn(process.execPath, [cliPath], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('[install-app-deps]', err);
  process.exit(1);
});

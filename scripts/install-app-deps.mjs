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
 *
 * Why the `electron-builder install-app-deps` SUBCOMMAND and not the
 * `install-app-deps` bin entry: that bin is a one-line shim that does
 * `require("./out/cli/install-app-deps")`, but the required module only
 * runs its main() under `if (require.main === module)`. Loaded through
 * the shim it is NOT require.main, so it does nothing and exits 0 —
 * silently. That is the whole failure: a fresh `npm install` looks
 * clean while better-sqlite3 / node-pty are left built against whatever
 * Node happened to run npm, never rebuilt for Electron's ABI. Verified
 * against electron-builder 26.15.3, whose own module prints "please use
 * as subcommand: electron-builder install-app-deps" when run directly.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

delete process.env.ELECTRON_RUN_AS_NODE;

const require = createRequire(import.meta.url);
const pkg = require('electron-builder/package.json');
const pkgRoot = dirname(require.resolve('electron-builder/package.json'));
const cliPath = join(pkgRoot, pkg.bin['electron-builder']);

const child = spawn(process.execPath, [cliPath, 'install-app-deps'], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else if (code) process.exit(code);
  else verify();
});
child.on('error', (err) => {
  console.error('[install-app-deps]', err);
  process.exit(1);
});

/**
 * Prove the rebuild actually landed by loading each native module under
 * Electron's own ABI (ELECTRON_RUN_AS_NODE runs Electron's embedded Node,
 * so a module built for the wrong NODE_MODULE_VERSION throws here exactly
 * as it would at app start).
 *
 * This exists because the failure being guarded against is SILENT: the
 * rebuild step reporting success while having done nothing is precisely
 * how the app ends up unable to open its database at runtime. A loud
 * failure at install time is worth far more than a clean-looking install.
 */
function verify() {
  const modules = ['better-sqlite3', 'node-pty', '@parcel/watcher'];
  let electronBin;
  try {
    electronBin = require('electron');
  } catch {
    // Electron isn't resolvable (odd install order / CI stub). Nothing to
    // verify against — don't fail the install over the checker itself.
    console.warn('[install-app-deps] electron not resolvable; skipped native-module check');
    return;
  }
  const check = spawn(
    electronBin,
    ['-e', `for (const m of ${JSON.stringify(modules)}) require(m);`],
    { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  check.on('exit', (code) => {
    if (!code) {
      console.log(`[install-app-deps] verified for Electron: ${modules.join(', ')}`);
      return;
    }
    console.error(
      '\n[install-app-deps] native modules did NOT load under Electron.\n' +
      '  They are built for the wrong ABI, so the app will fail to open its database.\n' +
      '  Try: rm -rf node_modules && npm install\n',
    );
    process.exit(1);
  });
  check.on('error', (err) => {
    console.warn('[install-app-deps] could not run native-module check:', err.message);
  });
}

// Bundle the host daemon into one file: dist-host/popbot-host.cjs. It runs
// under plain Node on any box with the `claude` / `codex` CLIs — no
// node_modules, no Electron. The agent SDKs are bundled in (they are
// ESM-only, as in the main build); Electron-only modules are left out.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

await build({
  entryPoints: [resolve(root, 'src/host/index.ts')],
  outfile: resolve(root, 'dist-host/popbot-host.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  // The agent SDKs locate their files with `import.meta.url`, which a CJS
  // bundle does not have: point it at this file.
  banner: { js: '#!/usr/bin/env node\nconst __hostImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  alias: { '@shared': resolve(root, 'src/shared') },
  external: ['electron', 'better-sqlite3', 'node-pty'],
  define: {
    __POPBOT_HOST_VERSION__: JSON.stringify(pkg.version),
    'import.meta.url': '__hostImportMetaUrl',
  },
  logLevel: 'info',
});

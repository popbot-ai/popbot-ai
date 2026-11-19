// Shrink PopBot's database offline: drop the old Codex event log, rebuild
// search over the conversation only, trim old tool output, then VACUUM.
// The running app does the same work a slice at a time
// (src/main/persistence/janitor.ts) but cannot shrink the file.
//
//   npm run db:compact [-- /path/to/popbot.db]
//
// Quit PopBot first. Needs free disk about the size of the result.
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultDb = process.platform === 'darwin'
  ? join(homedir(), 'Library/Application Support/PopBot/popbot.db')
  : process.platform === 'win32'
    ? join(process.env.APPDATA ?? '', 'PopBot/popbot.db')
    : join(homedir(), '.config/PopBot/popbot.db');
const dbPath = resolve(process.argv[2] ?? defaultDb);

// Refuse while anything else has it open (the app, a dev build).
if (process.platform !== 'win32') {
  let holders = '';
  try { holders = execFileSync('lsof', ['-t', dbPath], { encoding: 'utf8' }).trim(); } catch { /* none */ }
  if (holders) {
    console.error(`${dbPath} is open in process ${holders.split('\n').join(', ')}. Quit PopBot first.`);
    process.exit(1);
  }
}

const out = join(tmpdir(), `popbot-compact-db-${process.pid}.cjs`);
await build({
  entryPoints: [join(root, 'scripts/compact-db-main.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  alias: { '@shared': join(root, 'src/shared') },
  // db.ts imports electron for initDb only; migrate() doesn't touch it.
  external: ['better-sqlite3', 'electron'],
  nodePaths: [join(root, 'node_modules')],
  logLevel: 'warning',
});
const electron = join(root, 'node_modules/.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const r = spawnSync(electron, [out, dbPath], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(root, 'node_modules') },
});
process.exit(r.status ?? 1);

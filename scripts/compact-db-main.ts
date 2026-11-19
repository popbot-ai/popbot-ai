/**
 * The offline compactor's body (see compact-db.mjs, which bundles this
 * and runs it under Electron's Node — better-sqlite3 is built for it).
 * PopBot must be quit: this rewrites the whole file.
 */
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { migrate } from '../src/main/persistence/db';
import { FTS_REBUILD_CONVERSATION_SQL } from '../src/main/persistence/fts';
import { janitorSlice, markIndexClean } from '../src/main/persistence/janitor';

const path = process.argv[2];
const gb = (p: string): string => {
  let n = 0;
  for (const f of [p, `${p}-wal`]) {
    try { n += statSync(f).size; } catch { /* none */ }
  }
  return `${(n / 1e9).toFixed(2)} GB`;
};
const step = (what: string, fn: () => void): void => {
  const t = Date.now();
  process.stdout.write(`${what}… `);
  fn();
  console.log(`${((Date.now() - t) / 1000).toFixed(1)} s`);
};

console.log(`${path}: ${gb(path)}`);
const conn = new Database(path, { fileMustExist: true });
conn.pragma('busy_timeout = 1000');
step('Bringing the schema up to date (indexes on a large database take a while)', () => migrate(conn));
step('Dropping the Codex event log', () => conn.exec('DROP TABLE IF EXISTS codex_thread_events'));
step('Rebuilding search over the conversation only', () => {
  conn.transaction(() => {
    conn.exec(FTS_REBUILD_CONVERSATION_SQL);
    markIndexClean(conn);
  })();
});
step('Trimming old tool output', () => {
  while (janitorSlice(conn, 60_000)) { /* until done */ }
});
step('Rewriting the file (VACUUM)', () => {
  conn.pragma('wal_checkpoint(TRUNCATE)');
  conn.exec('VACUUM');
  conn.pragma('wal_checkpoint(TRUNCATE)');
});
conn.close();
console.log(`${path}: ${gb(path)}`);

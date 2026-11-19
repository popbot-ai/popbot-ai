/**
 * The janitor's thread (janitor.ts): a worker with its own connection to
 * the database, so none of its work is done on the main thread. It works
 * in short transactions — SLICE_MS of work, then GAP_MS free — because
 * SQLite has one writer: a write from the main thread that arrives during
 * a slice waits for it. A pass starts FIRST_PASS_AFTER_MS after launch and
 * again every PASS_EVERY_MS, and ends when there is nothing left to do.
 *
 * Started and stopped by janitorSchedule.ts; what it has to say goes back
 * to the main thread for the log.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { janitorSlice } from './janitor';

const SLICE_MS = 20;
const GAP_MS = 100;
const FIRST_PASS_AFTER_MS = 30_000;
const PASS_EVERY_MS = 10 * 60_000;

const { dbPath, firstPassAfterMs } = workerData as { dbPath: string; firstPassAfterMs?: number };
const conn = new Database(dbPath, { fileMustExist: true });
conn.pragma('busy_timeout = 5000');

const log = (tag: string, fields: Record<string, unknown>): void => {
  parentPort?.postMessage({ type: 'log', tag, fields });
};

let timer: ReturnType<typeof setTimeout> | null = null;
const schedule = (ms: number, fn: () => void): void => {
  timer = setTimeout(fn, ms);
};

function pass(): void {
  const startedAt = Date.now();
  let slices = 0;
  let longest = 0;
  let failures = 0;
  const step = (): void => {
    let more = false;
    const t = Date.now();
    try {
      more = janitorSlice(conn, SLICE_MS);
    } catch (err) {
      // Rolled back; try that slice again shortly rather than give up
      // the pass (a busy database, say).
      log('janitor.failed', { error: err instanceof Error ? err.message : String(err) });
      failures += 1;
      if (failures <= 20) return schedule(GAP_MS * 10, step);
    }
    longest = Math.max(longest, Date.now() - t);
    slices += 1;
    if (more) return schedule(GAP_MS, step);
    if (slices > 1) log('janitor.pass', { slices, ms: Date.now() - startedAt, longestSliceMs: longest });
    schedule(PASS_EVERY_MS, pass);
  };
  step();
}

parentPort?.on('message', (msg) => {
  if (msg !== 'stop') return;
  if (timer) clearTimeout(timer);
  conn.close();
  parentPort?.close();
});

schedule(firstPassAfterMs ?? FIRST_PASS_AFTER_MS, pass);

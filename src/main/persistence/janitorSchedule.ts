/**
 * Starts the janitor (janitor.ts) on its own worker thread
 * (janitorWorker.ts) and stops it on quit. Nothing of its work runs here
 * on the main thread; its log lines come back to be written.
 */
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { dlog } from '../diagLog';
import { db, isDbOpen } from './db';

let worker: Worker | null = null;

export function startJanitor(): void {
  if (worker || !isDbOpen()) return;
  try {
    worker = new Worker(join(__dirname, 'janitorWorker.js'), { workerData: { dbPath: db().name } });
  } catch (err) {
    dlog('janitor.worker-failed', { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  worker.on('message', (msg: { type?: string; tag?: string; fields?: Record<string, unknown> }) => {
    if (msg?.type === 'log' && msg.tag) dlog(msg.tag, msg.fields ?? {});
  });
  worker.on('error', (err) => dlog('janitor.worker-error', { error: err.message }));
  worker.on('exit', (code) => {
    if (code !== 0) dlog('janitor.worker-exit', { code });
    worker = null;
  });
  worker.unref();
}

/** Ask it to finish its slice and close its connection; end it outright
 *  if it hasn't within a second. */
export async function stopJanitor(): Promise<void> {
  const w = worker;
  worker = null;
  if (!w) return;
  const exited = new Promise<void>((resolve) => w.once('exit', () => resolve()));
  w.postMessage('stop');
  const timedOut = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 1_000))]);
  if (timedOut) await w.terminate();
}

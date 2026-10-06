/**
 * File transfers between machines, as PopBot runs them for agents (the
 * popbot tools transfer_file, accept_file_transfer, decline_file_transfer,
 * get_file_transfer, cancel_file_transfer).
 *
 * A file is never pushed onto a machine unannounced: a transfer starts as
 * an OFFER to a chat, and moves only once that chat's agent accepts it. An
 * offer nobody answers lapses after OFFER_TTL_MS. The messages either way
 * (offer, arrival, decline, failure) are sent by the tools; this module
 * keeps the state.
 *
 * Where a file goes is nobody's choice: always `~/popbot/sent_files/` on
 * the receiving chat's machine, under the file's own name — or
 * `name (2).ext`, `name (3).ext`… when one of that name is already there, so
 * nothing is ever overwritten and nothing lands outside that folder.
 *
 * A transfer can take far longer than one tool call may wait, so it runs
 * here, in the desktop, and callers check back by id.
 */
import { randomUUID } from 'node:crypto';
import type { HostRecord } from '@shared/persistence';
import { listHosts } from '../persistence/hosts';
import { dlog } from '../diagLog';
import { hostEndpoint, localEndpoint, runTransfer, type Endpoint, type TransferProgress } from './transfer';

export const SENT_FILES_DIR = '~/popbot/sent_files';
const LOCAL_NAMES = new Set(['', 'local', 'this computer', 'here']);
/** An offer nobody accepts lapses after this. */
export const OFFER_TTL_MS = 60 * 60_000;
/** Finished transfers are remembered this long, for a late check. */
const KEEP_FINISHED_MS = 24 * 60 * 60_000;

export type TransferPhase = 'offered' | 'declined' | 'expired' | TransferProgress['phase'];

export interface FileTransferInfo {
  id: string;
  from: string;
  fromPath: string;
  to: string;
  /** The chat that offered it, and the one it is offered to. */
  fromChatId: string | null;
  toChatId: string;
  /** Where it lands, once known. */
  destPath: string | null;
  phase: TransferPhase;
  size: number;
  done: number;
  attempt: number;
  offeredAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  sha256: string | null;
  error: string | null;
}

interface Job {
  info: FileTransferInfo;
  controller: AbortController;
  /** Settles once the transfer ends, however it ends. */
  finished: Promise<void>;
  settle: () => void;
  expiry: ReturnType<typeof setTimeout> | null;
}

const jobs = new Map<string, Job>();

const FINAL: ReadonlySet<TransferPhase> = new Set(['done', 'failed', 'cancelled', 'declined', 'expired']);

/** A machine by name: this computer, or a host from Preferences ▸ Hosts. */
export function machine(ref: string | null | undefined): { endpoint: Endpoint; label: string } | { error: string } {
  const want = (ref ?? '').trim().toLowerCase();
  if (LOCAL_NAMES.has(want)) return { endpoint: localEndpoint(), label: 'this computer' };
  const host: HostRecord | undefined = listHosts().find((h) => h.id.toLowerCase() === want || h.name.toLowerCase() === want);
  if (!host) {
    const known = ['this computer', ...listHosts().map((h) => h.name)].join(', ');
    return { error: `no machine "${ref}" (known: ${known})` };
  }
  return { endpoint: hostEndpoint(host), label: host.name };
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? 'file';
}

/** The first free name for the file in the destination's sent_files. */
async function freeDestination(to: Endpoint, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${SENT_FILES_DIR}/${n === 1 ? name : `${stem} (${n})${ext}`}`;
    const st = await to.stat(candidate);
    if (!st.exists) return candidate;
  }
  throw new Error(`${SENT_FILES_DIR} on ${to.label} already has 999 files named like ${name}`);
}

function prune(): void {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [id, job] of jobs) {
    if (job.info.finishedAt && job.info.finishedAt < cutoff) jobs.delete(id);
  }
}

function finish(job: Job, phase: TransferPhase, error: string | null): void {
  if (job.expiry) clearTimeout(job.expiry);
  Object.assign(job.info, { phase, error, finishedAt: Date.now() });
  job.settle();
}

/**
 * Offer `fromPath` on one machine to a chat on another. Nothing moves until
 * that chat accepts (acceptFileTransfer). `onExpire` runs if it lapses.
 */
export async function offerFileTransfer(
  input: { from: string; fromPath: string; to: string; fromChatId: string | null; toChatId: string },
  onExpire: (info: FileTransferInfo) => void,
): Promise<FileTransferInfo> {
  prune();
  const from = machine(input.from);
  if ('error' in from) throw new Error(from.error);
  const to = machine(input.to);
  if ('error' in to) throw new Error(to.error);
  if (from.label === to.label) {
    throw new Error(`that chat runs on ${to.label} too, where the file already is — tell its agent the path instead`);
  }
  const src = await from.endpoint.stat(input.fromPath);
  if (!src.exists) throw new Error(`${from.label} has no ${src.path}`);
  if (!src.isFile) throw new Error(`${src.path} on ${from.label} is not a file (send a folder as an archive)`);

  let settle: () => void = () => undefined;
  const finished = new Promise<void>((r) => { settle = r; });
  const info: FileTransferInfo = {
    id: `xfer_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    from: from.label,
    fromPath: src.path,
    to: to.label,
    fromChatId: input.fromChatId,
    toChatId: input.toChatId,
    destPath: null,
    phase: 'offered',
    size: src.size,
    done: 0,
    attempt: 0,
    offeredAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    sha256: null,
    error: null,
  };
  const job: Job = { info, controller: new AbortController(), finished, settle, expiry: null };
  job.expiry = setTimeout(() => {
    if (job.info.phase !== 'offered') return;
    finish(job, 'expired', null);
    dlog('transfer.expired', { id: info.id });
    onExpire({ ...job.info });
  }, OFFER_TTL_MS);
  job.expiry.unref?.();
  jobs.set(info.id, job);
  dlog('transfer.offered', { id: info.id, from: info.from, fromPath: info.fromPath, to: info.to, toChat: info.toChatId, size: info.size });
  return { ...info };
}

/** The receiving chat takes it: the file starts moving, into its
 *  machine's sent_files. */
export async function acceptFileTransfer(id: string, byChatId: string | null): Promise<FileTransferInfo> {
  const job = jobs.get(id);
  if (!job) throw new Error(`no transfer ${id}`);
  if (job.info.toChatId !== byChatId) throw new Error('that file was offered to another chat; only it can accept');
  if (job.info.phase !== 'offered') throw new Error(`that transfer is ${job.info.phase}, not waiting to be accepted`);
  const from = machine(job.info.from);
  const to = machine(job.info.to);
  if ('error' in from) throw new Error(from.error);
  if ('error' in to) throw new Error(to.error);
  const dest = await freeDestination(to.endpoint, fileName(job.info.fromPath));
  if (job.expiry) clearTimeout(job.expiry);
  const { info, controller } = job;
  Object.assign(info, { phase: 'starting', startedAt: Date.now() });
  dlog('transfer.accepted', { id, dest });
  void runTransfer(
    { from: from.endpoint, fromPath: info.fromPath, to: to.endpoint, toPath: dest, overwrite: false },
    (p) => {
      if (FINAL.has(info.phase)) return;
      info.phase = p.phase;
      info.done = p.done;
      info.size = p.size || info.size;
      info.attempt = p.attempt;
      info.destPath = p.destPath ?? info.destPath;
      info.error = p.error ?? null;
    },
    controller.signal,
  ).then(
    (landed) => {
      Object.assign(info, { done: landed.size, destPath: landed.path, sha256: landed.sha256 });
      finish(job, 'done', null);
      dlog('transfer.done', { id, to: info.to, destPath: landed.path, size: landed.size, attempts: info.attempt, ms: info.finishedAt! - (info.startedAt ?? info.offeredAt) });
    },
    (err: unknown) => {
      const cancelled = controller.signal.aborted;
      finish(job, cancelled ? 'cancelled' : 'failed', cancelled ? null : err instanceof Error ? err.message : String(err));
      dlog('transfer.failed', { id, cancelled, error: info.error });
    },
  );
  return { ...info };
}

/** The receiving chat says no. */
export function declineFileTransfer(id: string, byChatId: string | null): FileTransferInfo {
  const job = jobs.get(id);
  if (!job) throw new Error(`no transfer ${id}`);
  if (job.info.toChatId !== byChatId) throw new Error('that file was offered to another chat; only it can decline');
  if (job.info.phase !== 'offered') throw new Error(`that transfer is ${job.info.phase}, not waiting to be accepted`);
  finish(job, 'declined', null);
  dlog('transfer.declined', { id });
  return { ...job.info };
}

/** Where a transfer stands — waiting up to `waitMs` for it to end. An
 *  offer still waiting to be answered returns at once. */
export async function getFileTransfer(id: string, waitMs = 0): Promise<FileTransferInfo | null> {
  const job = jobs.get(id);
  if (!job) return null;
  if (waitMs > 0 && job.info.phase !== 'offered' && !FINAL.has(job.info.phase)) {
    await Promise.race([job.finished, new Promise((r) => setTimeout(r, waitMs))]);
  }
  return { ...job.info };
}

/** Settles when the transfer has ended, however it ended. */
export async function whenFinished(id: string): Promise<FileTransferInfo | null> {
  const job = jobs.get(id);
  if (!job) return null;
  await job.finished;
  return { ...job.info };
}

/** Stop it — offered or moving. Either end may. */
export function cancelFileTransfer(id: string, byChatId: string | null): FileTransferInfo {
  const job = jobs.get(id);
  if (!job) throw new Error(`no transfer ${id}`);
  if (byChatId !== job.info.fromChatId && byChatId !== job.info.toChatId) throw new Error('only the chats at either end can cancel it');
  if (FINAL.has(job.info.phase)) throw new Error(`that transfer is already ${job.info.phase}`);
  if (job.info.phase === 'offered') finish(job, 'cancelled', null);
  else job.controller.abort();
  return { ...job.info };
}

export function listFileTransfers(): FileTransferInfo[] {
  prune();
  return [...jobs.values()].map((j) => ({ ...j.info })).sort((a, b) => b.offeredAt - a.offeredAt);
}

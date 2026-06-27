/**
 * Perforce per-slot client lifecycle for the shado-backed slot system:
 * create/flush/delete the slot's client workspace, revert-all (park to a
 * clean base), and shelve/unshelve — Perforce's analog of git stash for
 * close→reopen continuity.
 *
 * The slot's files physically exist via the shado differencing clone, so
 * the client is established with `flush` (0-byte have-list update) to the
 * base changelist, never a transfer — see the shado+P4 design.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampP4ParallelThreads, type PerforceSettings } from '@shared/persistence';
import type { P4Shelf } from '@shared/perforce';
import { getSetting } from '../persistence/settings';
import { emitP4Progress } from './progress';
import {
  envFor,
  p4bin,
  p4exec,
  parseZtag,
  writeP4Config,
  type P4Context,
  type P4ExecResult,
} from './exec';

/**
 * Per-slot metadata the provider needs when it only has the slot path
 * (checkout/park/refresh). Stored as a sidecar at the slot mount root
 * alongside the `.p4config` so a worktree path is self-describing.
 */
export interface SlotMeta {
  depotPath: string;
  baseChangelist: number;
  /** The chat's named pending changelist (the git-branch analog). The agent's
   *  edits are opened into it; submit submits it. */
  changelist?: number;
  /** Its description — the chat's branch/changelist name. */
  changelistName?: string;
}

const SLOT_META_FILE = '.popbot-p4.json';

export function writeSlotMeta(wt: string, meta: SlotMeta): void {
  try {
    writeFileSync(join(wt, SLOT_META_FILE), JSON.stringify(meta));
  } catch {
    /* best-effort — the provider falls back to a repo lookup if absent */
  }
}

export function readSlotMeta(wt: string): SlotMeta | null {
  const file = join(wt, SLOT_META_FILE);
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as SlotMeta;
    return j.depotPath ? j : null;
  } catch {
    return null;
  }
}

/** Trim a trailing slash and any `/...` from a depot path → `//depot/X`. */
function normDepot(depotPath: string): string {
  return depotPath.replace(/\/?\.\.\.$/, '').replace(/\/+$/, '');
}

/**
 * The changelist the warm source folder is synced to — what the frozen base
 * is built at, so every slot can `p4 flush @baseChangelist` (0-byte) against
 * it. Prefer the folder's actual `#have` (run p4 in the folder so it resolves
 * the existing workspace client); fall back to the depot head if the folder
 * isn't a recognized workspace. Returns 0 only when neither is available.
 */
export async function captureSyncedChangelist(
  ctx: P4Context,
  warmFolder: string,
  depotPath: string,
): Promise<number> {
  const have = await p4exec(ctx, ['-ztag', 'changes', '-m1', '...#have'], {
    cwd: warmFolder,
    tolerant: true,
  }).catch(() => null);
  const haveCl = have ? Number(parseZtag(have.stdout)[0]?.change ?? 0) : 0;
  if (haveCl > 0) return haveCl;

  const head = await p4exec(
    ctx,
    ['-ztag', 'changes', '-m1', '-s', 'submitted', `${normDepot(depotPath)}/...`],
    { tolerant: true },
  ).catch(() => null);
  return head ? Number(parseZtag(head.stdout)[0]?.change ?? 0) : 0;
}

export interface EnsureClientOpts {
  /** Connection (port/user) with `client` = the slot client name. */
  ctx: P4Context;
  /** Slot mount = the client Root. */
  root: string;
  /** Depot path mapped, e.g. `//depot/PopBotGame`. */
  depotPath: string;
  /** Changelist the shado base was synced to. */
  baseChangelist: number;
  /** Lock the client to this host so P4V lists it (and it can't be used
   *  from another machine). */
  host?: string;
}

/**
 * Create/update the per-slot client mapping `depotPath` into the slot
 * mount, then flush its have-list to the base changelist. Idempotent —
 * re-running just rewrites the spec and re-flushes (0-byte). The view
 * mirrors the depot under the client root (`//depot/X/... //c/depot/X/...`)
 * to match the p4 path convention used by the review module.
 */
export async function ensureClient(opts: EnsureClientOpts): Promise<void> {
  const { ctx, root, depotPath, baseChangelist, host } = opts;
  if (!ctx.client) throw new Error('ensureClient: ctx.client required');
  const dp = normDepot(depotPath);
  const sub = dp.replace(/^\/+/, ''); // depot/PopBotGame
  // Drop files the watcher opened but that are byte-identical at submit, so
  // auto-edits don't create no-op revisions (Preferences → Source control →
  // Perforce; default on).
  const revertUnchanged = getSetting<PerforceSettings>('perforce')?.revertUnchanged !== false;
  const spec =
    `Client: ${ctx.client}\n` +
    `Owner: ${ctx.user}\n` +
    (host ? `Host: ${host}\n` : '') +
    `Root: ${root}\n` +
    `LineEnd: local\n` +
    (revertUnchanged ? 'SubmitOptions: revertunchanged\n' : '') +
    `View:\n\t${dp}/... //${ctx.client}/${sub}/...\n`;
  await p4exec(ctx, ['client', '-i'], { input: spec });
  // A silent flush failure would leave the slot's have-list wrong (it would
  // believe it holds the base when it doesn't) — surface it during setup.
  const flush = await flushTo(ctx, dp, baseChangelist);
  if (flush.code !== 0) {
    throw new Error(
      `p4 flush of ${dp}/...@${baseChangelist} failed: ${flush.stderr.trim() || flush.stdout.trim()}`,
    );
  }
  // Persist the connection + THIS client name so readP4Config (and the
  // review ops it feeds) resolve the very client we just created.
  writeP4Config(root, ctx);
}

/** Flush the slot client's have-list to a changelist (0-byte transfer).
 *  Returns the raw result so callers can decide whether a failure is fatal
 *  (slot setup) or best-effort (park/refresh re-flush on next allocation). */
export async function flushTo(ctx: P4Context, depotPath: string, change: number): Promise<P4ExecResult> {
  const dp = normDepot(depotPath);
  return p4exec(ctx, ['flush', `${dp}/...@${change}`], { tolerant: true });
}

/** Sync the slot to the latest submitted changelist. After flushing the
 *  have-list to the frozen base, this transfers ONLY the base→head delta (the
 *  warm-slot payoff), so a new chat starts from the latest depot state. */
export function syncLatest(ctx: P4Context, wt: string, depotPath: string): Promise<P4ExecResult> {
  const dp = normDepot(depotPath);
  const threads = clampP4ParallelThreads(getSetting<PerforceSettings>('perforce')?.parallelThreads);
  const args = ['sync', `${dp}/...`];
  if (threads > 1) args.push(`--parallel=threads=${threads}`); // parallel transfer of the delta

  // SCALE: the base→head delta can be large (a long-frozen base, or a busy
  // depot) and slow — minutes on a real game tree. So we SPAWN rather than
  // buffer, counting synced files from stdout (p4 prints one line per file)
  // and streaming a live meter. The watcher's `p4 add` path reuses the same
  // P4OpenProgress banner. We don't pre-count (a `sync -n` is itself a full
  // round-trip); a running "N files" with a spinner is the honest meter here.
  return new Promise<P4ExecResult>((resolve) => {
    const child = spawn(p4bin(), args, { cwd: wt, env: envFor(ctx), windowsHide: true });
    let synced = 0;
    let pending = '';
    let stderr = '';
    let lastEmit = 0;
    const flush = (force: boolean): void => {
      const now = Date.now();
      if (!force && now - lastEmit < 250) return; // throttle the IPC, not the work
      lastEmit = now;
      emitP4Progress(`Syncing to latest — ${synced.toLocaleString()} files…`);
    };
    child.stdout?.on('data', (d: Buffer) => {
      pending += d.toString();
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        pending = pending.slice(nl + 1);
        synced++;
      }
      flush(false);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const done = (code: number): void => {
      emitP4Progress(''); // clear the banner
      resolve({ stdout: '', stderr, code });
    };
    child.on('close', (code) => done(code ?? 0));
    child.on('error', (e) => {
      stderr += String(e);
      done(1);
    });
  });
}

/** Revert every opened file in the slot — park to a clean base. */
export async function revertAll(ctx: P4Context, wt: string): Promise<void> {
  if (!ctx.client) return;
  await p4exec(ctx, ['revert', `//${ctx.client}/...`], { cwd: wt, tolerant: true });
}

/** Delete the slot's client spec (teardown). Does not touch files on disk
 *  (the shado clone owns those). */
export async function deleteClient(ctx: P4Context): Promise<void> {
  if (!ctx.client) return;
  await p4exec(ctx, ['client', '-d', '-f', ctx.client], { tolerant: true });
}

/**
 * Shelve the slot's currently-opened files under `description` (the stash
 * analog). Moves them into a new numbered changelist and shelves it;
 * leaves the files still opened (caller reverts to park clean). Returns
 * the shelved changelist number, or null when nothing is opened.
 */
export async function shelveWork(ctx: P4Context, wt: string, description: string): Promise<string | null> {
  const created = await p4exec(ctx, ['change', '-i'], {
    cwd: wt,
    tolerant: true,
    input: `Change: new\nDescription:\n\t${description}\n`,
  });
  const cl = /Change (\d+) created/.exec(created.stdout)?.[1];
  if (!cl) return null;
  await p4exec(ctx, ['reopen', '-c', cl, `//${ctx.client}/...`], { cwd: wt, tolerant: true });
  const shelved = await p4exec(ctx, ['shelve', '-c', cl], { cwd: wt, tolerant: true });
  if (!/shelved/i.test(shelved.stdout + shelved.stderr)) {
    // Nothing was opened → drop the empty change so we don't leak it.
    await p4exec(ctx, ['change', '-d', cl], { cwd: wt, tolerant: true });
    return null;
  }
  return cl;
}

/** Shelved changelists owned by the user — the P4 panel's shelf section. */
export async function listShelves(ctx: P4Context, max = 50): Promise<P4Shelf[]> {
  const { stdout } = await p4exec(
    ctx,
    ['-ztag', 'changes', '-s', 'shelved', '-u', ctx.user, '-L', '-m', String(max)],
    { tolerant: true },
  );
  const out: P4Shelf[] = [];
  for (const rec of parseZtag(stdout)) {
    if (!rec.change) continue;
    out.push({
      change: rec.change,
      description: (rec.desc ?? '').trim().split('\n')[0] ?? '',
      time: rec.time ? Number(rec.time) * 1000 : 0,
    });
  }
  return out;
}

/** Most recent shelved changelist whose description starts with `prefix`,
 *  or null. The "ref" callers pass to {@link unshelvePop}. */
export async function findLatestShelf(ctx: P4Context, prefix: string): Promise<string | null> {
  const { stdout } = await p4exec(
    ctx,
    ['-ztag', 'changes', '-s', 'shelved', '-L', '-u', ctx.user, '-m', '50'],
    { tolerant: true },
  );
  let best: number | null = null;
  for (const rec of parseZtag(stdout)) {
    const desc = (rec.desc ?? '').trim();
    if (!rec.change || !desc.startsWith(prefix)) continue;
    const n = Number(rec.change);
    if (best == null || n > best) best = n;
  }
  return best == null ? null : String(best);
}

/**
 * Open filesystem changes (from the slot watcher) in Perforce with targeted
 * `p4 edit/add/delete` — the bridge that makes p4 track an agent's free
 * edits like git, WITHOUT a reconcile. For changed-present files we run
 * BOTH `edit` and `add`: `edit` opens the ones already in the depot, `add`
 * opens the ones that aren't, and each is a tolerated no-op for the other
 * category — so we never have to probe per file. Batched via `p4 -x -`.
 */
export async function openChanges(
  ctx: P4Context,
  wt: string,
  changes: { path: string; kind: 'modify' | 'add' | 'delete' }[],
  changelist?: number,
): Promise<void> {
  const present = changes.filter((c) => c.kind !== 'delete').map((c) => `//${c.path}`);
  const removed = changes.filter((c) => c.kind === 'delete').map((c) => `//${c.path}`);
  // Open into the chat's named changelist when there is one (else the default).
  const clArgs = changelist ? ['-c', String(changelist)] : [];
  const total = present.length + removed.length;
  if (total === 0) return;

  // SCALE: a game export can be tens of thousands of files. Chunk so no single
  // `p4` call / stdin is unbounded, AND run the chunks as PARALLEL p4 processes
  // (bounded pool) so the server-bound opens overlap. Progress is streamed so
  // the panel isn't frozen.
  const CHUNK = 4000;
  const POOL = Math.max(2, Math.min(16, clampP4ParallelThreads(getSetting<PerforceSettings>('perforce')?.parallelThreads)));
  const open1 = (action: string, batch: string[]): Promise<P4ExecResult> =>
    p4exec(ctx, ['-x', '-', action, ...clArgs], {
      cwd: wt,
      input: batch.join('\n') + '\n',
      tolerant: true,
      maxBuffer: 64 * 1024 * 1024,
    });

  let done = 0;
  const showProgress = total > CHUNK; // only worth it for big sets
  const tick = (n: number): void => {
    done += n;
    if (showProgress) emitP4Progress(`Opening ${done.toLocaleString()} / ${total.toLocaleString()} files…`);
  };
  // Each task is one chunk. Present files run edit+add (p4 sorts depot vs new);
  // removed run delete. Tasks are independent → safe to run concurrently.
  const tasks: Array<() => Promise<void>> = [];
  for (let i = 0; i < present.length; i += CHUNK) {
    const batch = present.slice(i, i + CHUNK);
    tasks.push(async () => {
      await open1('edit', batch);
      await open1('add', batch);
      tick(batch.length);
    });
  }
  for (let i = 0; i < removed.length; i += CHUNK) {
    const batch = removed.slice(i, i + CHUNK);
    tasks.push(async () => {
      await open1('delete', batch);
      tick(batch.length);
    });
  }

  // Bounded-concurrency pool: POOL workers pull tasks until drained.
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(POOL, tasks.length) }, async () => {
        while (next < tasks.length) await tasks[next++]();
      }),
    );
  } finally {
    if (showProgress) emitP4Progress(''); // clear the panel banner
  }
}

/** Create a named pending changelist (the chat's branch analog); returns its
 *  number, or 0 on failure. */
export async function createChangelist(ctx: P4Context, description: string): Promise<number> {
  const desc = (description.trim() || 'popbot work').replace(/\n/g, '\n\t');
  const res = await p4exec(ctx, ['change', '-i'], {
    input: `Change: new\n\nDescription:\n\t${desc}\n`,
    tolerant: true,
  });
  return Number(/Change (\d+) created/.exec(res.stdout)?.[1] ?? 0);
}

/** Delete an (empty) pending changelist — best-effort. */
export async function deleteChangelist(ctx: P4Context, cl: number): Promise<void> {
  if (!cl) return;
  await p4exec(ctx, ['change', '-d', String(cl)], { tolerant: true });
}

/** Restore a shelved change into the slot, then drop the shelf + its
 *  (now redundant) changelist. */
export async function unshelvePop(ctx: P4Context, wt: string, change: string): Promise<void> {
  const un = await p4exec(ctx, ['unshelve', '-s', change], { cwd: wt, tolerant: true });
  // Only drop the shelf once the work is safely restored — otherwise an
  // unshelve failure (conflict, locked file) would destroy the only copy.
  if (un.code !== 0) {
    throw new Error(`p4 unshelve -s ${change} failed: ${un.stderr.trim() || un.stdout.trim()}`);
  }
  await p4exec(ctx, ['shelve', '-d', '-c', change], { cwd: wt, tolerant: true });
  await p4exec(ctx, ['change', '-d', change], { cwd: wt, tolerant: true });
}

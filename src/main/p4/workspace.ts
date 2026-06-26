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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PerforceSettings } from '@shared/persistence';
import type { P4Shelf } from '@shared/perforce';
import { getSetting } from '../persistence/settings';
import { p4exec, parseZtag, writeP4Config, type P4Context, type P4ExecResult } from './exec';

/**
 * Per-slot metadata the provider needs when it only has the slot path
 * (checkout/park/refresh). Stored as a sidecar at the slot mount root
 * alongside the `.p4config` so a worktree path is self-describing.
 */
export interface SlotMeta {
  depotPath: string;
  baseChangelist: number;
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
): Promise<void> {
  const present = changes.filter((c) => c.kind !== 'delete').map((c) => `//${c.path}`);
  const removed = changes.filter((c) => c.kind === 'delete').map((c) => `//${c.path}`);
  const run = (action: string, files: string[]): Promise<unknown> =>
    files.length
      ? p4exec(ctx, ['-x', '-', action], { cwd: wt, input: files.join('\n') + '\n', tolerant: true })
      : Promise.resolve();
  if (present.length) {
    await run('edit', present);
    await run('add', present);
  }
  if (removed.length) await run('delete', removed);
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

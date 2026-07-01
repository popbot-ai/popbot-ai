/**
 * Perforce working-copy operations for the source-control panel — status,
 * per-file diff, submit, revert, and the files in a submitted change.
 * Mirrors `../git/files` 1:1 so {@link PerforceProvider} is thin
 * delegation.
 *
 * "WIP" in Perforce = files open in the slot client's pending/default
 * changelist (`p4 opened`). The slot was flushed to the base changelist
 * (0-byte), so opened files are exactly the agent's edits.
 *
 * PATH CONVENTION: every path key is the depot path with the leading `//`
 * stripped (e.g. `depot/PopBotGame/ASSETS/x`). Under the `p4-init` client
 * view — `//depot/X/... //client/depot/X/...` — that string is ALSO the
 * worktree-relative local path, so one key serves display, the local file
 * (`join(wt, path)`), and the depot spec (`'//' + path`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitCommitSummary, GitFileChange, GitFileStatus, GitScope } from '@shared/git';
import { clampP4ParallelThreads, type PerforceSettings } from '@shared/persistence';
import { isP4AuthError } from '@shared/perforce';
import { getSetting } from '../persistence/settings';
import { p4exec, p4execRaw, parseZtag, type P4Context } from './exec';

/** depot path (`//depot/...`) → our key (`depot/...`). */
function depotToKey(depotFile: string): string {
  return depotFile.replace(/^\/+/, '');
}

function actionToStatus(action: string): GitFileStatus {
  if (action === 'delete' || action === 'move/delete' || action === 'purge') return 'deleted';
  if (action === 'move/add') return 'renamed';
  if (action === 'add' || action === 'import' || action === 'branch') return 'added';
  return 'modified'; // edit, integrate, …
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(buf.length, 8192)).includes(0);
}
function bufToText(buf: Buffer | null): { text: string; isBinary: boolean } {
  if (buf == null) return { text: '', isBinary: false };
  if (looksBinary(buf)) return { text: '', isBinary: true };
  return { text: buf.toString('utf8'), isBinary: false };
}

// ---- Recent-changes cache ----
//
// `p4 changes` over the whole client view (an aggregate include list) is a
// server round-trip that can be slow, so it must NOT be awaited inside the
// per-status path — doing so hung the app on startup. Instead the submitted-CL
// list is cached per view-scope and refreshed in the BACKGROUND: status serves
// whatever's cached instantly, a stale entry triggers a fire-and-forget refresh
// (effectively periodic), and a commit queues an immediate refresh.

interface RecentEntry {
  commits: GitCommitSummary[];
  fetchedAt: number;
  inFlight?: Promise<void>;
}
const recentCache = new Map<string, RecentEntry>();
const RECENT_TTL_MS = 90_000; // serve cached; refresh in bg at most this often

/** REPO-LEVEL depot scope to list changes against. The team's recent CLs are
 *  identical for every chat/slot of a repo, so this keys the cache so the fetch
 *  happens ONCE PER REPO. Prefer the main workspace client's full view (the
 *  aggregate include list), else the repo's depot path — both are repo-stable.
 *  Returns null when neither is known; we deliberately do NOT fall back to the
 *  per-slot client (that would key the cache per chat and fetch N times). */
function changesScopeFor(viewClient?: string, depotPath?: string): string | null {
  if (viewClient) return `//${viewClient}/...`;
  if (depotPath) return `${depotPath.replace(/\/+$/, '')}/...`;
  return null;
}

/** Cache key for a scope, namespaced by the connection identity so different
 *  Perforce servers/users with an identically-named client/depot don't collide. */
function recentCacheKey(ctx: P4Context, scope: string): string {
  return `${ctx.port}\t${ctx.user}\t${scope}`;
}

function parseChanges(stdout: string): GitCommitSummary[] {
  const out: GitCommitSummary[] = [];
  for (const rec of parseZtag(stdout)) {
    if (!rec.change) continue;
    out.push({
      sha: rec.change,
      shortSha: rec.change,
      author: rec.user ?? '',
      date: rec.time ? Number(rec.time) * 1000 : 0,
      subject: (rec.desc ?? '').split('\n')[0]?.trim() ?? '',
    });
  }
  return out;
}

/** Background refresh of the recent-changes cache for `scope`. Coalesces
 *  concurrent refreshes; never rejects. */
function refreshRecentChanges(ctx: P4Context, scope: string): Promise<void> {
  const key = recentCacheKey(ctx, scope);
  const cur = recentCache.get(key);
  if (cur?.inFlight) return cur.inFlight;
  const p = (async () => {
    const r = await p4exec(ctx, ['-ztag', 'changes', '-m', '20', '-s', 'submitted', '-t', scope], {
      tolerant: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    // Overwrite only on a usable result; on error keep the old commits but stamp
    // the time so we back off rather than hammer a failing/slow server.
    const commits = r.code === 0 ? parseChanges(r.stdout) : recentCache.get(key)?.commits ?? [];
    recentCache.set(key, { commits, fetchedAt: Date.now() });
  })()
    .catch(() => {})
    .finally(() => {
      const e = recentCache.get(key);
      if (e) e.inFlight = undefined;
    });
  recentCache.set(key, { commits: cur?.commits ?? [], fetchedAt: cur?.fetchedAt ?? 0, inFlight: p });
  return p;
}

/** Cached recent changes for `scope`; returns immediately and kicks off a
 *  background refresh when the entry is missing or stale. Never blocks. */
function recentChangesCached(ctx: P4Context, scope: string | null): GitCommitSummary[] {
  if (!scope) return [];
  const e = recentCache.get(recentCacheKey(ctx, scope));
  if (!e || (!e.inFlight && Date.now() - e.fetchedAt > RECENT_TTL_MS)) {
    void refreshRecentChanges(ctx, scope);
  }
  return e?.commits ?? [];
}

/** Queue a (non-blocking) recent-changes refresh — call after a commit so the
 *  panel reflects the new CL without waiting for the TTL. */
export function queueRecentChangesRefresh(ctx: P4Context, viewClient?: string, depotPath?: string): void {
  const scope = changesScopeFor(viewClient, depotPath);
  if (scope) void refreshRecentChanges(ctx, scope);
}

/** Files open in the slot's pending changelist + recent submitted changes. */
export async function listStatus(
  ctx: P4Context,
  wt: string,
  viewClient?: string,
  depotPath?: string,
): Promise<{
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  recentCommits: GitCommitSummary[];
  client?: string;
  changeNumber?: string;
}> {
  // Only `p4 opened` is awaited here — it's fast and slot-local. "Recent
  // changes" hits the server across the whole view (slow on a big aggregate
  // include list), so it's served from a background-refreshed cache and never
  // blocks status (awaiting it inline was hanging the app on startup).
  const changesScope = changesScopeFor(viewClient, depotPath);
  const openedR = await p4exec(ctx, ['-ztag', 'opened'], { cwd: wt, tolerant: true });

  // `tolerant` swallows a failed `p4 opened`, which on an expired/missing login
  // ticket would otherwise render as an empty "no open files" workspace and
  // hide the real cause. Surface the auth error so the panel shows the login
  // prompt instead.
  if (openedR.code !== 0 && isP4AuthError(`${openedR.stderr}\n${openedR.stdout}`)) {
    throw new Error(openedR.stderr.trim() || openedR.stdout.trim() || 'Perforce login required');
  }

  const files: GitFileChange[] = [];
  // Capture the chat's numbered pending changelist from the opened files (some
  // files may sit in 'default'; the named CL is the one the panel header shows).
  let changeNumber: string | undefined;
  const opened = parseZtag(openedR.stdout).filter((r) => r.depotFile);
  // A move surfaces as a PAIR of opened files — move/delete (old path) and
  // move/add (new path) — each carrying `movedFile` (its partner). Fold the
  // pair into a single 'renamed' row on the new path (with oldPath) and hide
  // the standalone delete, so the viewer shows a move, not a delete+add.
  const moveAddKeys = new Set(
    opened.filter((r) => r.action === 'move/add').map((r) => depotToKey(r.depotFile!)),
  );
  for (const rec of opened) {
    const key = depotToKey(rec.depotFile!);
    if (rec.change && rec.change !== 'default') changeNumber = rec.change;
    const action = rec.action ?? 'edit';
    // Its partner move/add row carries this path as oldPath — don't list twice.
    if (action === 'move/delete' && rec.movedFile && moveAddKeys.has(depotToKey(rec.movedFile))) {
      continue;
    }
    const oldPath = action === 'move/add' && rec.movedFile ? depotToKey(rec.movedFile) : undefined;
    files.push({ path: key, status: actionToStatus(action), oldPath });
  }

  // Served from the cache (instant); a stale entry refreshes in the background.
  const recentCommits = recentChangesCached(ctx, changesScope);

  // Perforce has no branch/ahead/behind; surface the client name as the
  // "branch" label for the panel header, and also as `client` so the panel can
  // show the P4 workspace name explicitly.
  return { branch: ctx.client ?? null, ahead: 0, behind: 0, files, recentCommits, client: ctx.client, changeNumber };
}

function readWorking(wt: string, path: string): Buffer | null {
  const full = join(wt, path);
  if (!existsSync(full)) return null;
  return readFileSync(full);
}

/** Before/after for one file. WIP = depot have-rev vs the working file;
 *  a submitted change = the file's revision in that change vs the prior. */
export async function fileDiff(
  ctx: P4Context,
  wt: string,
  scope: GitScope,
  path: string,
): Promise<{ oldText: string; newText: string; isBinary: boolean; path: string }> {
  const depot = `//${path}`;
  let oldBuf: Buffer | null;
  let newBuf: Buffer | null;

  if (scope.kind === 'wip') {
    // A moved/renamed file has no have-revision at the NEW path — its "before"
    // lives at the old depot path. Resolve the move source (fstat movedFile) so
    // the diff shows the rename delta instead of a whole-file add.
    const moved = await p4exec(ctx, ['-ztag', 'fstat', '-T', 'movedFile', depot], {
      cwd: wt,
      tolerant: true,
    });
    const src = parseZtag(moved.stdout)[0]?.movedFile;
    const oldSpec = src ? `//${depotToKey(src)}#have` : `${depot}#have`;
    oldBuf = await p4execRaw(ctx, ['print', '-q', oldSpec], { cwd: wt });
    newBuf = readWorking(wt, path);
  } else {
    // Two newest revisions up to this change → diff the change against its
    // predecessor for this file.
    const log = await p4exec(ctx, ['-ztag', 'filelog', '-m', '2', `${depot}@${scope.sha}`], {
      cwd: wt,
      tolerant: true,
    });
    const revs = parseZtag(log.stdout)[0] ?? {};
    const curRev = revs.rev0;
    const prevRev = revs.rev1;
    newBuf = curRev ? await p4execRaw(ctx, ['print', '-q', `${depot}#${curRev}`], { cwd: wt }) : null;
    oldBuf = prevRev ? await p4execRaw(ctx, ['print', '-q', `${depot}#${prevRev}`], { cwd: wt }) : null;
  }

  const oldSide = bufToText(oldBuf);
  const newSide = bufToText(newBuf);
  return {
    oldText: oldSide.text,
    newText: newSide.text,
    isBinary: oldSide.isBinary || newSide.isBinary,
    path,
  };
}

/** Submit exactly the given (already-opened) paths as one numbered change.
 *  Returns the change number as the "sha". */
export async function submitFiles(
  ctx: P4Context,
  wt: string,
  message: string,
  paths: string[],
): Promise<{ sha: string }> {
  if (paths.length === 0) throw new Error('Nothing to submit');
  if (!message.trim()) throw new Error('Submit description required');
  const specs = paths.map((p) => `//${p}`);
  // Parallel transfer — the lever for large game assets (Preferences →
  // Source control → Perforce). 1 = off. Unchanged opened files are dropped
  // by the client's SubmitOptions=revertunchanged (set in ensureClient).
  const threads = clampP4ParallelThreads(getSetting<PerforceSettings>('perforce')?.parallelThreads);
  const args = ['submit', '-d', message];
  if (threads > 1) args.push(`--parallel=threads=${threads},batch=8,min=1`);
  args.push(...specs);
  const res = await p4exec(ctx, args, { cwd: wt, tolerant: true });
  // revertunchanged can leave nothing to submit (the watcher opened only
  // byte-identical files) — a benign no-op, not a failure.
  if (/No files to submit/i.test(res.stdout + res.stderr)) return { sha: '' };
  if (res.code !== 0) {
    throw new Error(`p4 submit failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  // p4 prints "Change N submitted." (possibly after renumber lines).
  const m = /Change (\d+) submitted/.exec(res.stdout);
  return { sha: m?.[1] ?? '' };
}

/** Submit the chat's named pending changelist (which already holds the
 *  watcher-opened files), setting its description to `message` first so the
 *  commit message wins over the working name. */
export async function submitChangelist(
  ctx: P4Context,
  wt: string,
  cl: number,
  message: string,
): Promise<{ sha: string }> {
  if (!message.trim()) throw new Error('Submit description required');
  // Read-modify-write the changelist spec to set the description.
  const got = await p4exec(ctx, ['change', '-o', String(cl)], { cwd: wt, tolerant: true });
  const desc = message.trim().replace(/\n/g, '\n\t');
  const spec = got.stdout.replace(/^Description:\n(?:\t.*\n?)*/m, `Description:\n\t${desc}\n`);
  await p4exec(ctx, ['change', '-i'], { input: spec, cwd: wt, tolerant: true });
  const threads = clampP4ParallelThreads(getSetting<PerforceSettings>('perforce')?.parallelThreads);
  const args = ['submit', '-c', String(cl)];
  if (threads > 1) args.push(`--parallel=threads=${threads},batch=8,min=1`);
  const res = await p4exec(ctx, args, { cwd: wt, tolerant: true });
  if (/No files to submit/i.test(res.stdout + res.stderr)) return { sha: '' };
  if (res.code !== 0) {
    throw new Error(`p4 submit failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return { sha: /Change (\d+) submitted/.exec(res.stdout)?.[1] ?? '' };
}

/** Discard local changes for the given paths (revert opened files). */
export async function revertFiles(ctx: P4Context, wt: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const specs = paths.map((p) => `//${p}`);
  await p4exec(ctx, ['revert', ...specs], { cwd: wt, tolerant: true });
}

/** Files touched by a submitted change. */
export async function filesInChange(ctx: P4Context, wt: string, change: string): Promise<GitFileChange[]> {
  const { stdout } = await p4exec(ctx, ['-ztag', 'describe', '-s', change], { cwd: wt, tolerant: true });
  const rec = parseZtag(stdout)[0];
  if (!rec) return [];
  const out: GitFileChange[] = [];
  for (let i = 0; rec[`depotFile${i}`]; i++) {
    out.push({
      path: depotToKey(rec[`depotFile${i}`]),
      status: actionToStatus(rec[`action${i}`] ?? 'edit'),
    });
  }
  return out;
}

/** Branch-name username — the P4 user. */
export async function deriveUsername(ctx: P4Context): Promise<string> {
  if (ctx.user) return ctx.user.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const { stdout } = await p4exec(ctx, ['-ztag', 'info'], { tolerant: true });
  const rec = parseZtag(stdout)[0] ?? {};
  return (rec.userName ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

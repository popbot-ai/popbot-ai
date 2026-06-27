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

/** Files open in the slot's pending changelist + recent submitted changes. */
export async function listStatus(
  ctx: P4Context,
  wt: string,
): Promise<{
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  recentCommits: GitCommitSummary[];
}> {
  const [openedR, changesR] = await Promise.all([
    p4exec(ctx, ['-ztag', 'opened'], { cwd: wt, tolerant: true }),
    p4exec(ctx, ['-ztag', 'changes', '-m', '20', '-s', 'submitted', '-t', './...'], {
      cwd: wt,
      tolerant: true,
    }),
  ]);

  const files: GitFileChange[] = [];
  for (const rec of parseZtag(openedR.stdout)) {
    const depotFile = rec.depotFile;
    if (!depotFile) continue;
    files.push({ path: depotToKey(depotFile), status: actionToStatus(rec.action ?? 'edit') });
  }

  const recentCommits: GitCommitSummary[] = [];
  for (const rec of parseZtag(changesR.stdout)) {
    if (!rec.change) continue;
    recentCommits.push({
      sha: rec.change,
      shortSha: rec.change,
      author: rec.user ?? '',
      date: rec.time ? Number(rec.time) * 1000 : 0,
      subject: (rec.desc ?? '').split('\n')[0]?.trim() ?? '',
    });
  }

  // Perforce has no branch/ahead/behind; surface the client name as the
  // "branch" label for the panel header.
  return { branch: ctx.client ?? null, ahead: 0, behind: 0, files, recentCommits };
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
    oldBuf = await p4execRaw(ctx, ['print', '-q', `${depot}#have`], { cwd: wt });
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

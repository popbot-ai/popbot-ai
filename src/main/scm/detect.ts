/**
 * Detect which source-control system backs a folder, so the "Add
 * repository" flow can infer git vs Perforce instead of asking the user.
 *
 *   - git: a `.git` entry in the folder (definitive, instant).
 *   - perforce: a `.p4config` walking up (a configured P4 workspace names
 *     its connection there), else confirmed by asking p4 whether the folder
 *     maps into a depot (`p4 fstat -m1 ./...`, using the ambient
 *     `.p4config`/env connection). `-m1` stops at the first file, so it's
 *     fast even on a huge tree.
 *   - neither → null (the UI falls back to a manual picker).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { p4bin } from '../p4/exec';
import type { P4WorkspaceInfo } from '@shared/ipc';

const execFileP = promisify(execFile);

function hasGit(folder: string): boolean {
  return existsSync(join(folder, '.git'));
}

/** A `.p4config` in the folder or any ancestor → a configured P4 workspace. */
function hasP4Config(folder: string): boolean {
  let dir = folder;
  for (;;) {
    if (existsSync(join(dir, '.p4config'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Normalize a path for root comparison (trim, unify slashes, drop trailing
 *  slash, lowercase — Windows roots are case-insensitive). */
function pathKey(p: string): string {
  return p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/** A local `p4 set <NAME>` value (env/registry, no server hit). */
async function p4Set(name: string): Promise<string> {
  try {
    const { stdout } = await execFileP(p4bin(), ['set', name], { windowsHide: true, timeout: 4000 });
    return new RegExp(`^${name}=(\\S+)`, 'm').exec(stdout)?.[1] ?? '';
  } catch {
    return '';
  }
}
const p4User = (): Promise<string> => p4Set('P4USER');
const p4Port = (): Promise<string> => p4Set('P4PORT');

type ClientMatch = { kind: 'found'; client: string } | { kind: 'none' } | { kind: 'unknown' };

/**
 * The user's Perforce client whose Root is the folder (or an ancestor of it) —
 * the workspace that maps it. The robust signal: it does NOT need a
 * `.p4config` or the folder to sit under the *current* client; we ask the
 * server for the user's clients and match the folder against their Root. A
 * warm tree synced by some other client is still recognized.
 */
async function p4ClientForFolder(folder: string): Promise<ClientMatch> {
  try {
    const user = await p4User();
    const args = ['-ztag', 'clients', ...(user ? ['-u', user] : [])];
    const { stdout } = await execFileP(p4bin(), args, {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const want = pathKey(folder);
    let client = '';
    for (const line of stdout.split(/\r?\n/)) {
      const cm = /^\.\.\.\s+client\s+(.+?)\s*$/.exec(line);
      if (cm) {
        client = cm[1];
        continue;
      }
      const rm = /^\.\.\.\s+Root\s+(.+?)\s*$/.exec(line);
      if (rm) {
        const root = pathKey(rm[1]);
        if (root && (root === want || want.startsWith(root + '/'))) return { kind: 'found', client };
      }
    }
    return { kind: 'none' };
  } catch (err) {
    // ENOENT = no p4 binary. A connect/timeout error also leaves us unable to
    // tell (treated as unknown so the `.p4config` fallback can still apply).
    const code = (err as NodeJS.ErrnoException)?.code;
    const msg = (err as Error)?.message ?? '';
    if (code === 'ENOENT' || /connect|P4PORT|timed out|TIMEDOUT/i.test(msg)) return { kind: 'unknown' };
    return { kind: 'none' };
  }
}

async function p4WorkspaceMapsFolder(folder: string): Promise<'yes' | 'no' | 'unknown'> {
  const m = await p4ClientForFolder(folder);
  return m.kind === 'found' ? 'yes' : m.kind === 'unknown' ? 'unknown' : 'no';
}

/**
 * Fallback: ask p4 whether the folder maps into a depot via the *current*
 * client (`p4 fstat -m1 ./...`). Only succeeds when the folder is under the
 * ambient client's root; the workspace-root scan above is the primary path.
 */
async function p4MapsDepot(folder: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const { stdout } = await execFileP(p4bin(), ['-ztag', 'fstat', '-m', '1', './...'], {
      cwd: folder,
      env: { ...process.env, P4CONFIG: process.env.P4CONFIG || '.p4config' },
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 1024 * 1024,
    });
    return /(^|\n)\.\.\.\sdepotFile\s/.test(stdout) ? 'yes' : 'no';
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'unknown' : 'no';
  }
}

/** Best-effort SCM detection for a picked folder. */
export async function detectScm(folder: string): Promise<'git' | 'perforce' | null> {
  if (!folder || !existsSync(folder)) return null;
  if (hasGit(folder)) return 'git';
  // Primary: is the folder the root of (or inside) one of the user's P4
  // client workspaces? Then fall back to the current-client fstat, and
  // finally a bare `.p4config` when p4 couldn't be reached at all.
  const ws = await p4WorkspaceMapsFolder(folder);
  if (ws === 'yes') return 'perforce';
  const fstat = await p4MapsDepot(folder);
  if (fstat === 'yes') return 'perforce';
  if ((ws === 'unknown' || fstat === 'unknown') && hasP4Config(folder)) return 'perforce';
  return null;
}

/**
 * Pull the connection + depot mapping + synced changelist from the P4 client
 * workspace rooted at `folder`, so the Add-Repository connect step can present
 * it read-only instead of asking the user to retype. Null when no client maps
 * the folder (the flow falls back to manual entry).
 */
export async function p4WorkspaceInfo(folder: string): Promise<P4WorkspaceInfo | null> {
  if (!folder || !existsSync(folder)) return null;
  const match = await p4ClientForFolder(folder);
  if (match.kind !== 'found') return null;
  const client = match.client;
  try {
    const { stdout: spec } = await execFileP(p4bin(), ['-ztag', 'client', '-o', client], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const owner = /^\.\.\.\s+Owner\s+(\S+)/m.exec(spec)?.[1] ?? (await p4User());
    // Depot side of the first view mapping → //depot/PopBotGame (drop /...).
    const viewLine = /^\.\.\.\s+View0\s+(.+?)\s*$/m.exec(spec)?.[1] ?? '';
    const depotSide = viewLine.trim().split(/\s+/)[0]?.replace(/^"|"$/g, '') ?? '';
    const depotPath = depotSide.replace(/\/\.\.\.$/, '').replace(/\/+$/, '');
    const port = await p4Port();
    let baseChangelist = 0;
    try {
      const { stdout: have } = await execFileP(
        p4bin(),
        ['-ztag', '-c', client, 'changes', '-m', '1', `//${client}/...#have`],
        { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
      );
      baseChangelist = Number(/^\.\.\.\s+change\s+(\d+)/m.exec(have)?.[1] ?? 0);
    } catch {
      /* leave 0 — the build step still captures/falls back */
    }
    return { client, port, user: owner, depotPath, baseChangelist };
  } catch {
    return null;
  }
}

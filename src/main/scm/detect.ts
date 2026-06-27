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

/** The connected P4USER from env/registry (local `p4 set`, no server hit). */
async function p4User(): Promise<string> {
  try {
    const { stdout } = await execFileP(p4bin(), ['set', 'P4USER'], { windowsHide: true, timeout: 4000 });
    return /^P4USER=(\S+)/m.exec(stdout)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * Discover whether the folder is the root of (or inside) one of the user's
 * Perforce client workspaces. This is the robust signal — it does NOT need
 * the folder to carry a `.p4config` or to sit under the *current* client; we
 * ask the server for the user's clients and match the folder against their
 * Root. A warm tree synced by some other client is still recognized.
 *   - 'yes'     → a client Root is the folder (or an ancestor of it);
 *   - 'no'      → clients listed, none map the folder;
 *   - 'unknown' → couldn't ask (no p4 binary / server unreachable).
 */
async function p4WorkspaceMapsFolder(folder: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const user = await p4User();
    const args = ['-ztag', 'clients', ...(user ? ['-u', user] : [])];
    const { stdout } = await execFileP(p4bin(), args, {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const want = pathKey(folder);
    for (const m of stdout.matchAll(/^\.\.\.\s+Root\s+(.+?)\s*$/gm)) {
      const root = pathKey(m[1]);
      if (root && (root === want || want.startsWith(root + '/'))) return 'yes';
    }
    return 'no';
  } catch (err) {
    // ENOENT = no p4 binary. A connect/timeout error also leaves us unable to
    // tell (treated as unknown so the `.p4config` fallback can still apply).
    const code = (err as NodeJS.ErrnoException)?.code;
    const msg = (err as Error)?.message ?? '';
    if (code === 'ENOENT' || /connect|P4PORT|timed out|TIMEDOUT/i.test(msg)) return 'unknown';
    return 'no';
  }
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

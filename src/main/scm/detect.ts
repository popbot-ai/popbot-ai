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

/**
 * Ask p4 whether the folder maps into a depot, using whatever connection the
 * ambient `.p4config`/env provides.
 *   - 'yes'     → a depot file resolves under the folder;
 *   - 'no'      → p4 ran and it does NOT map into a depot;
 *   - 'unknown' → the p4 binary isn't available, so we can't tell.
 */
async function p4MapsDepot(folder: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const { stdout } = await execFileP('p4', ['-ztag', 'fstat', '-m', '1', './...'], {
      cwd: folder,
      env: { ...process.env, P4CONFIG: process.env.P4CONFIG || '.p4config' },
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 1024 * 1024,
    });
    return /(^|\n)\.\.\.\sdepotFile\s/.test(stdout) ? 'yes' : 'no';
  } catch (err) {
    // ENOENT = no p4 binary → can't determine. A non-zero exit ("file(s) not
    // under client root", unauthed, …) is a genuine negative.
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'unknown' : 'no';
  }
}

/** Best-effort SCM detection for a picked folder. */
export async function detectScm(folder: string): Promise<'git' | 'perforce' | null> {
  if (!folder || !existsSync(folder)) return null;
  if (hasGit(folder)) return 'git';
  // `.p4config` only supplies connection info — it does NOT prove the folder
  // maps into a depot. Confirm with p4; only fall back to the config's mere
  // presence when p4 itself is unavailable to ask.
  const p4 = await p4MapsDepot(folder);
  if (p4 === 'yes') return 'perforce';
  if (p4 === 'unknown' && hasP4Config(folder)) return 'perforce';
  return null;
}

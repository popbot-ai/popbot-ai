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
import type { SourceControlProviderId } from '@shared/sourceControl';

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

/** Ask p4 whether the folder maps into a depot, using whatever connection
 *  the ambient `.p4config`/env provides. Fail-soft → false. */
async function isP4Workspace(folder: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP('p4', ['-ztag', 'fstat', '-m', '1', './...'], {
      cwd: folder,
      env: { ...process.env, P4CONFIG: process.env.P4CONFIG || '.p4config' },
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 1024 * 1024,
    });
    return /(^|\n)\.\.\.\sdepotFile\s/.test(stdout);
  } catch {
    return false; // p4 missing / not authed / not a workspace
  }
}

/** Best-effort SCM detection for a picked folder. */
export async function detectScm(folder: string): Promise<SourceControlProviderId | null> {
  if (!folder || !existsSync(folder)) return null;
  if (hasGit(folder)) return 'git';
  if (hasP4Config(folder)) return 'perforce';
  if (await isP4Workspace(folder)) return 'perforce';
  return null;
}

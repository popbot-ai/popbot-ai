/**
 * Perforce / large-project base-build orchestration.
 *
 * A "base" is a frozen, read-only shado VHDX created from an already-warm
 * source folder (a p4-synced game tree, with its derived/intermediate state).
 * Slots are copy-on-write differencing children of it (see ./slots.ts).
 *
 * Building the base is a one-time, PRIVILEGED step (`shado create` needs an
 * elevated shell). This module:
 *   - measures the source folder + the repo drive's free space,
 *   - gates on free disk (block when free < folderSize × 1.05 — the user's
 *     rule; the source folder is left in place, so the base is purely
 *     additive disk),
 *   - launches `shado create` through a UAC prompt (manual-elevation path;
 *     the standing elevated service is future work), and
 *   - reports the resulting on-disk sizes via `shado du`.
 */
import { execFile } from 'node:child_process';
import { readdir, stat, statfs, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shadoExePath, shadoHomeForRepo, runShado } from './client';

/** Free-space headroom over the source folder before a build is allowed. */
export const BASE_DISK_MARGIN = 1.05;

export interface BasePreflight {
  /** Total bytes of the source (warm) folder. */
  folderBytes: number;
  fileCount: number;
  /** Free bytes on the drive the base will live on (the repo's drive). */
  freeBytes: number;
  /** Minimum free bytes required to proceed (folderBytes × margin). */
  neededBytes: number;
  /** VHDX max size to request via `--size-gb` (expandable; a ceiling). */
  sizeGb: number;
  /** False → the wizard must block the build. */
  ok: boolean;
}

export interface BaseBuildResult {
  ok: boolean;
  /** shado's combined stdout/stderr (or the failure reason). */
  log: string;
}

/** Recursively sum file sizes under `dir`. Best-effort: unreadable entries
 *  (permissions, races, reparse points) are skipped, never fatal. Iterative
 *  to avoid blowing the stack on deep game trees. */
async function measureFolder(dir: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0;
  let count = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue; // don't follow links (cycles / double-count)
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        try {
          bytes += (await stat(p)).size;
          count += 1;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  return { bytes, count };
}

/** Measure the source folder + the repo drive's free space and decide
 *  whether a base build is allowed. The base lives under SHADO_HOME on the
 *  repo's drive (same-drive invariant), so free space is checked there. */
export async function basePreflight(repoPath: string): Promise<BasePreflight> {
  const { bytes, count } = await measureFolder(repoPath);
  let freeBytes = 0;
  try {
    const s = await statfs(repoPath);
    freeBytes = Number(s.bavail) * Number(s.bsize);
  } catch {
    freeBytes = 0;
  }
  const neededBytes = Math.ceil(bytes * BASE_DISK_MARGIN);
  // Expandable VHDX ceiling: the base only holds the folder (slot writes land
  // in their own children), so source × 1.3 + 4 GB headroom, min 16 GB.
  const sizeGb = Math.max(16, Math.ceil((bytes / 1024 ** 3) * 1.3) + 4);
  return {
    folderBytes: bytes,
    fileCount: count,
    freeBytes,
    neededBytes,
    sizeGb,
    ok: freeBytes >= neededBytes,
  };
}

/**
 * Build a frozen base from `repoPath` via an elevated `shado create`.
 *
 * `shado create` requires admin, but PopBot runs non-elevated — so we launch
 * it through a UAC prompt: a temp .bat sets SHADO_HOME (pinning the base to
 * the repo's drive) and runs shado with output redirected to a log, then
 * `Start-Process -Verb RunAs -Wait` elevates it. We read the log + the
 * elevated process's exit code back out. Windows-only (the whole shado/VHDX
 * path is); never throws.
 */
export async function buildBase(opts: {
  repoPath: string;
  baseName: string;
  sizeGb: number;
}): Promise<BaseBuildResult> {
  if (process.platform !== 'win32') {
    return { ok: false, log: 'Base build is only supported on Windows.' };
  }
  const home = shadoHomeForRepo(opts.repoPath);
  const shado = shadoExePath();
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`;
  const log = join(tmpdir(), `shado-base-${stamp}.log`);
  const bat = join(tmpdir(), `shado-base-${stamp}.bat`);

  const batBody =
    '@echo off\r\n' +
    `set "SHADO_HOME=${home}"\r\n` +
    `"${shado}" create "${opts.repoPath}" --name ${opts.baseName} --size-gb ${opts.sizeGb} > "${log}" 2>&1\r\n` +
    'exit /b %ERRORLEVEL%\r\n';

  try {
    await writeFile(bat, batBody, 'utf8');
  } catch (err) {
    return { ok: false, log: `Could not stage build script: ${(err as Error).message}` };
  }

  // PowerShell runs non-elevated and fires the UAC prompt for the .bat.
  // -PassThru + -Wait lets us read the elevated process's real exit code.
  const psCmd =
    `$ErrorActionPreference='Stop'; ` +
    `try { $p = Start-Process -FilePath '${bat}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
    `catch { Write-Error $_; exit 1223 }`; // 1223 = ERROR_CANCELLED (UAC declined)

  const exitCode: number = await new Promise((resolvePromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCmd],
      { windowsHide: true },
      (err) => {
        const code = (err as (NodeJS.ErrnoException & { code?: number }) | null)?.code;
        resolvePromise(typeof code === 'number' ? code : err ? 1 : 0);
      },
    );
  });

  let log_ = '';
  try {
    log_ = await readFile(log, 'utf8');
  } catch {
    /* shado may have failed before writing */
  }
  void rm(bat, { force: true }).catch(() => {});
  void rm(log, { force: true }).catch(() => {});

  if (exitCode === 1223) {
    return { ok: false, log: 'Elevation was cancelled (the base build needs administrator rights).' };
  }
  if (exitCode !== 0) {
    return { ok: false, log: log_.trim() || `shado create failed (exit ${exitCode}).` };
  }
  return { ok: true, log: log_.trim() };
}

export interface BaseDu {
  baseMb: number;
  /** Raw `shado du` text for display. */
  raw: string;
}

/** Post-build size report via `shado du --name <base>`. */
export async function baseDiskUsage(repoPath: string, baseName: string): Promise<BaseDu> {
  const r = await runShado(['du', '--name', baseName], {
    env: { SHADO_HOME: shadoHomeForRepo(repoPath) },
  });
  const text = r.stdout || r.stderr || '';
  const m = /base\s*=\s*(\d+)\s*MB/i.exec(text);
  return { baseMb: m ? Number(m[1]) : 0, raw: text.trim() };
}

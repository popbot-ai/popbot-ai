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
import { shadoExePath, shadoHomeForRepo, popbotRootForRepo, runShado } from './client';

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

/** A coarse progress line for the renderer (e.g. "Measuring… 12,000 files").
 *  Long operations stream these so the wizard never shows a dead spinner. */
export type ProgressFn = (message: string) => void;

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Recursively sum file sizes under `dir`. Best-effort: unreadable entries
 *  (permissions, races, reparse points) are skipped, never fatal. Iterative
 *  to avoid blowing the stack on deep game trees. Emits a running count so a
 *  multi-minute walk of a 1 TB tree shows real progress. */
async function measureFolder(
  dir: string,
  onProgress?: ProgressFn,
): Promise<{ bytes: number; count: number }> {
  let bytes = 0;
  let count = 0;
  let ticked = 0;
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
          if (onProgress && count - ticked >= 2000) {
            ticked = count;
            onProgress(`Measuring… ${count.toLocaleString()} files, ${gb(bytes)}`);
          }
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
export async function basePreflight(repoPath: string, onProgress?: ProgressFn): Promise<BasePreflight> {
  const { bytes, count } = await measureFolder(repoPath, onProgress);
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
export async function buildBase(
  opts: {
    repoPath: string;
    repoId: string;
    baseName: string;
    sizeGb: number;
    slotPrefix: string;
    slotCount: number;
  },
  onProgress?: ProgressFn,
): Promise<BaseBuildResult> {
  if (process.platform !== 'win32') {
    return { ok: false, log: 'Base build is only supported on Windows.' };
  }
  const home = shadoHomeForRepo(opts.repoPath, opts.repoId);
  const worktreesDir = join(popbotRootForRepo(opts.repoPath), 'workspaces', opts.repoId);
  const shado = shadoExePath();
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`;
  const log = join(tmpdir(), `shado-base-${stamp}.log`);
  const bat = join(tmpdir(), `shado-base-${stamp}.bat`);

  // One elevated session: freeze the base, then mount every slot clone. This
  // is the ONLY privileged step — slot-init afterwards (p4 client + flush) is
  // unprivileged because the clones already exist. `if errorlevel 1` bails the
  // batch on the first failure so a partial mount doesn't look successful.
  let batBody =
    '@echo off\r\n' +
    `set "SHADO_HOME=${home}"\r\n` +
    // --count 0 + --no-main: just the frozen base, no auto "main"/slot clones —
    // we mount the real slots (<prefix>-N) ourselves below, so shado's default
    // main + slot "1" would just be unused shadows taking disk.
    `"${shado}" create "${opts.repoPath}" --name ${opts.baseName} --count 0 --no-main --size-gb ${opts.sizeGb} > "${log}" 2>&1\r\n` +
    'if errorlevel 1 exit /b %errorlevel%\r\n';
  for (let k = 1; k <= opts.slotCount; k += 1) {
    const slot = `${opts.slotPrefix}-${k}`;
    const mount = join(worktreesDir, slot);
    batBody +=
      `"${shado}" clone create --name ${opts.baseName} --slot ${slot} --mount "${mount}" >> "${log}" 2>&1\r\n` +
      'if errorlevel 1 exit /b %errorlevel%\r\n';
  }
  batBody += 'exit /b 0\r\n';

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

  // Stream progress while the elevated build runs: an elapsed timer plus the
  // tail of shado's log (whatever it has flushed). Honest even if shado
  // buffers — the user always sees the build is alive, not a frozen spinner.
  const startedMs = Date.now();
  let tail = '';
  const timer = setInterval(() => {
    if (!onProgress) return;
    const secs = Math.floor((Date.now() - startedMs) / 1000);
    const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    readFile(log, 'utf8')
      .then((txt) => {
        const lines = txt.split(/\r?\n/).filter((l) => l.trim());
        tail = lines.length ? lines[lines.length - 1].slice(0, 120) : tail;
        onProgress(`Building base — ${elapsed}${tail ? `  ·  ${tail}` : ''}`);
      })
      .catch(() => onProgress(`Building base — ${elapsed}`));
  }, 1000);

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
  clearInterval(timer);

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

/**
 * Re-mount a repo's shado clones after a reboot. Windows drops VHDX mounts on
 * restart, so the slot folders go empty until re-attached — a privileged op,
 * same UAC path as {@link buildBase}. Runs one idempotent `shado remount
 * --name <base>` (a no-op for already-mounted clones). Windows-only; never
 * throws.
 */
export async function remountSlots(
  opts: { repoPath: string; repoId: string; baseName: string },
  onProgress?: ProgressFn,
): Promise<BaseBuildResult> {
  if (process.platform !== 'win32') {
    return { ok: false, log: 'Remount is only supported on Windows.' };
  }
  const home = shadoHomeForRepo(opts.repoPath, opts.repoId);
  const shado = shadoExePath();
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`;
  const log = join(tmpdir(), `shado-remount-${stamp}.log`);
  const bat = join(tmpdir(), `shado-remount-${stamp}.bat`);
  const batBody =
    '@echo off\r\n' +
    `set "SHADO_HOME=${home}"\r\n` +
    `"${shado}" remount --name ${opts.baseName} > "${log}" 2>&1\r\n` +
    'exit /b %errorlevel%\r\n';
  try {
    await writeFile(bat, batBody, 'utf8');
  } catch (err) {
    return { ok: false, log: `Could not stage remount script: ${(err as Error).message}` };
  }
  const psCmd =
    `$ErrorActionPreference='Stop'; ` +
    `try { $p = Start-Process -FilePath '${bat}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
    `catch { Write-Error $_; exit 1223 }`; // 1223 = ERROR_CANCELLED (UAC declined)
  onProgress?.('Remounting workspace slots…');
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
    return { ok: false, log: 'Elevation was cancelled (remounting slots needs administrator rights).' };
  }
  if (exitCode !== 0) {
    return { ok: false, log: log_.trim() || `shado remount failed (exit ${exitCode}).` };
  }
  return { ok: true, log: log_.trim() };
}

/**
 * Tear down a repo's entire shado project — remove every clone, destroy the
 * frozen base, clear the registry — to reclaim disk when the repo is deleted.
 * `--no-export` so the original p4/git folder (left in place) isn't overwritten
 * with stale base contents. Privileged, same UAC path as {@link buildBase}.
 * Windows-only; never throws.
 */
export async function destroyBase(
  opts: { repoPath: string; repoId: string; baseName: string },
  onProgress?: ProgressFn,
): Promise<BaseBuildResult> {
  if (process.platform !== 'win32') {
    return { ok: false, log: 'Base teardown is only supported on Windows.' };
  }
  const home = shadoHomeForRepo(opts.repoPath, opts.repoId);
  const shado = shadoExePath();
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`;
  const log = join(tmpdir(), `shado-destroy-${stamp}.log`);
  const bat = join(tmpdir(), `shado-destroy-${stamp}.bat`);
  const batBody =
    '@echo off\r\n' +
    `set "SHADO_HOME=${home}"\r\n` +
    `"${shado}" restore --name ${opts.baseName} --no-export --force > "${log}" 2>&1\r\n` +
    'exit /b %errorlevel%\r\n';
  try {
    await writeFile(bat, batBody, 'utf8');
  } catch (err) {
    return { ok: false, log: `Could not stage teardown script: ${(err as Error).message}` };
  }
  const psCmd =
    `$ErrorActionPreference='Stop'; ` +
    `try { $p = Start-Process -FilePath '${bat}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
    `catch { Write-Error $_; exit 1223 }`; // 1223 = ERROR_CANCELLED (UAC declined)
  onProgress?.('Removing workspace base + slots…');
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
    return { ok: false, log: 'Elevation was cancelled (removing the base needs administrator rights).' };
  }
  if (exitCode !== 0) {
    return { ok: false, log: log_.trim() || `shado restore failed (exit ${exitCode}).` };
  }
  return { ok: true, log: log_.trim() };
}

/**
 * Grow a repo's slot pool: create + mount the clones for slots
 * `fromCount+1..toCount` off the frozen base, in ONE elevated batch (clone
 * create is privileged — same UAC path as {@link buildBase}). The per-slot
 * VCS init (p4 client / git checkout) runs unprivileged afterwards because the
 * clones now exist. Windows-only; never throws. No-op when toCount<=fromCount.
 */
export async function growSlotClones(
  opts: {
    repoPath: string;
    repoId: string;
    baseName: string;
    slotPrefix: string;
    fromCount: number;
    toCount: number;
  },
  onProgress?: ProgressFn,
): Promise<BaseBuildResult> {
  if (process.platform !== 'win32') {
    return { ok: false, log: 'Slot resize is only supported on Windows.' };
  }
  if (opts.toCount <= opts.fromCount) return { ok: true, log: '' };
  const home = shadoHomeForRepo(opts.repoPath, opts.repoId);
  const worktreesDir = join(popbotRootForRepo(opts.repoPath), 'workspaces', opts.repoId);
  const shado = shadoExePath();
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`;
  const log = join(tmpdir(), `shado-grow-${stamp}.log`);
  const bat = join(tmpdir(), `shado-grow-${stamp}.bat`);
  let batBody = '@echo off\r\n' + `set "SHADO_HOME=${home}"\r\n`;
  for (let k = opts.fromCount + 1; k <= opts.toCount; k += 1) {
    const slot = `${opts.slotPrefix}-${k}`;
    const mount = join(worktreesDir, slot);
    // No `exit /b` on error: a clone that already exists (re-running expand, or
    // the wizard where the base build already mounted them) must NOT abort the
    // batch. A genuinely-missing clone is caught later when its per-slot init
    // tries to use it.
    batBody += `"${shado}" clone create --name ${opts.baseName} --slot ${slot} --mount "${mount}" >> "${log}" 2>&1\r\n`;
  }
  batBody += 'exit /b 0\r\n';
  try {
    await writeFile(bat, batBody, 'utf8');
  } catch (err) {
    return { ok: false, log: `Could not stage resize script: ${(err as Error).message}` };
  }
  const psCmd =
    `$ErrorActionPreference='Stop'; ` +
    `try { $p = Start-Process -FilePath '${bat}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
    `catch { Write-Error $_; exit 1223 }`; // 1223 = ERROR_CANCELLED (UAC declined)
  onProgress?.(`Creating slots ${opts.fromCount + 1}–${opts.toCount}…`);
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
    return { ok: false, log: 'Elevation was cancelled (adding slots needs administrator rights).' };
  }
  if (exitCode !== 0) {
    return { ok: false, log: log_.trim() || `shado clone create failed (exit ${exitCode}).` };
  }
  return { ok: true, log: log_.trim() };
}

/** Post-build size report via `shado du --name <base>`. */
export async function baseDiskUsage(repoPath: string, repoId: string, baseName: string): Promise<BaseDu> {
  const r = await runShado(['du', '--name', baseName], {
    env: { SHADO_HOME: shadoHomeForRepo(repoPath, repoId) },
  });
  const text = r.stdout || r.stderr || '';
  const m = /base\s*=\s*(\d+)\s*MB/i.exec(text);
  return { baseMb: m ? Number(m[1]) : 0, raw: text.trim() };
}

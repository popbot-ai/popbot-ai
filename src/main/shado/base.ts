/**
 * Perforce / large-project base-build orchestration.
 *
 * A "base" is a frozen, read-only shado VHDX created from an already-warm
 * source folder (a p4-synced game tree, with its derived/intermediate state).
 * Slots are copy-on-write differencing children of it (see ./slots.ts).
 *
 * Building the base is a one-time step. On Windows `shado create` needs admin,
 * so it runs through a UAC prompt; on macOS (APFS clonefile) and Linux
 * (XFS/btrfs reflink) the backend is unprivileged, so the same flow runs shado
 * directly — no elevation, no temp .bat (see the macOS/Linux section at the
 * bottom of this file). This module:
 *   - measures the source folder + the repo drive's free space,
 *   - gates on free disk (block when free < folderSize × 1.05 — the user's
 *     rule; the source folder is left in place, so the base is purely
 *     additive disk),
 *   - launches `shado create` (elevated on Windows, direct on macOS/Linux), and
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

/** shado base/slot names are interpolated UNQUOTED into elevated .bat commands,
 *  so they must not carry shell metacharacters (spaces, &, |, >, quotes, …). */
const SAFE_SHADO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Returns an error string for an unsafe name, or null when it's safe. */
function badShadoName(name: string, kind: string): string | null {
  return SAFE_SHADO_NAME.test(name) ? null : `Invalid ${kind}: ${name}`;
}

/** Measure the source folder + the repo drive's free space and decide
 *  whether a base build is allowed. The base lives under SHADO_HOME on the
 *  repo's drive (same-drive invariant), so free space is checked there. */
export async function basePreflight(repoPath: string, onProgress?: ProgressFn): Promise<BasePreflight> {
  // A missing/unreadable repo path measures as 0 bytes / 0 free, which would
  // otherwise satisfy `ok = free >= needed` (0 >= 0) and report a clean
  // preflight for a path that can't be built. Bail explicitly.
  try {
    if (!(await stat(repoPath)).isDirectory()) throw new Error('not a directory');
  } catch {
    return { folderBytes: 0, fileCount: 0, freeBytes: 0, neededBytes: 0, sizeGb: 0, ok: false };
  }
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
  if (process.platform === 'linux') {
    return buildBaseUnix(opts, onProgress);
  }
  // These names go UNQUOTED into an ELEVATED .bat — validate before building it.
  const nameErr = badShadoName(opts.baseName, 'base name') ?? badShadoName(opts.slotPrefix, 'slot prefix');
  if (nameErr) return { ok: false, log: nameErr };
  if (!Number.isInteger(opts.sizeGb) || opts.sizeGb <= 0 || opts.sizeGb > 1_000_000) {
    return { ok: false, log: `Invalid size: ${opts.sizeGb}` };
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
  const psBat = bat.replace(/'/g, "''"); // escape for the PS single-quoted path
  const psCmd =
    `$ErrorActionPreference='Stop'; ` +
    `try { $p = Start-Process -FilePath '${psBat}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
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
  if (process.platform === 'linux') {
    return remountSlotsUnix(opts, onProgress);
  }
  const nameErr = badShadoName(opts.baseName, 'base name');
  if (nameErr) return { ok: false, log: nameErr };
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
  const psBat = bat.replace(/'/g, "''"); // escape for the PS single-quoted path
  const psCmd =
    `$ErrorActionPreference='Stop'; ` +
    `try { $p = Start-Process -FilePath '${psBat}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
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
  if (process.platform === 'linux') {
    return destroyBaseUnix(opts, onProgress);
  }
  const nameErr = badShadoName(opts.baseName, 'base name');
  if (nameErr) return { ok: false, log: nameErr };
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
  const psBat = bat.replace(/'/g, "''"); // escape for the PS single-quoted path
  const psCmd =
    `$ErrorActionPreference='Stop'; ` +
    `try { $p = Start-Process -FilePath '${psBat}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
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
    // Already gone (a prior partial delete) → nothing to tear down, treat as ok.
    if (/no project/i.test(log_)) return { ok: true, log: log_.trim() };
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
  if (process.platform === 'linux') {
    return growSlotClonesUnix(opts, onProgress);
  }
  if (opts.toCount <= opts.fromCount) return { ok: true, log: '' };
  const nameErr = badShadoName(opts.baseName, 'base name') ?? badShadoName(opts.slotPrefix, 'slot prefix');
  if (nameErr) return { ok: false, log: nameErr };
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
  const psBat = bat.replace(/'/g, "''"); // escape for the PS single-quoted path
  const psCmd =
    `$ErrorActionPreference='Stop'; ` +
    `try { $p = Start-Process -FilePath '${psBat}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
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

/**
 * Re-mount the clones of MANY repos in ONE elevated batch (one UAC) — the
 * startup reconcile after a reboot dropped the VHDX mounts. Each repo gets its
 * own SHADO_HOME + `shado remount`. Idempotent (no-op for already-mounted
 * clones). Windows-only; never throws.
 */
export async function remountReposElevated(
  repos: Array<{ repoPath: string; repoId: string; baseName: string }>,
  onProgress?: ProgressFn,
): Promise<BaseBuildResult> {
  if (repos.length === 0) return { ok: true, log: '' };
  if (process.platform === 'linux') return remountReposUnix(repos, onProgress);
  const shado = shadoExePath();
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`;
  const log = join(tmpdir(), `shado-remount-all-${stamp}.log`);
  const bat = join(tmpdir(), `shado-remount-all-${stamp}.bat`);
  let batBody = '@echo off\r\n';
  for (const r of repos) {
    const nameErr = badShadoName(r.baseName, 'base name');
    if (nameErr) return { ok: false, log: nameErr };
    const home = shadoHomeForRepo(r.repoPath, r.repoId);
    batBody += `set "SHADO_HOME=${home}"\r\n`;
    batBody += `"${shado}" remount --name ${r.baseName} >> "${log}" 2>&1\r\n`;
  }
  batBody += 'exit /b 0\r\n';
  try {
    await writeFile(bat, batBody, 'utf8');
  } catch (err) {
    return { ok: false, log: `Could not stage remount script: ${(err as Error).message}` };
  }
  const psCmd =
    `$ErrorActionPreference='Stop'; ` +
    `try { $p = Start-Process -FilePath '${bat}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } ` +
    `catch { Write-Error $_; exit 1223 }`;
  onProgress?.('Restoring workspace slots…');
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
    /* nothing written */
  }
  void rm(bat, { force: true }).catch(() => {});
  void rm(log, { force: true }).catch(() => {});
  if (exitCode === 1223) return { ok: false, log: 'Elevation was cancelled (restoring slots needs administrator rights).' };
  if (exitCode !== 0) return { ok: false, log: log_.trim() || `shado remount failed (exit ${exitCode}).` };
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

// ============================ macOS / Linux ============================
//
// shado is unprivileged on macOS (APFS clonefile) and Linux (XFS/btrfs reflink)
// — a shadow is an ordinary user-space clone — so these mirror the Windows flows
// above WITHOUT the UAC/.bat dance: each runs shado directly with SHADO_HOME
// pinned to the repo's shado dir. Same {ok, log} contract; never throws.
// Selected by the `process.platform !== 'win32'` branches in the functions above.

/** Run shado with SHADO_HOME pinned to `home` (the repo's shado dir). */
function shadoAt(home: string, args: string[]) {
  return runShado(args, { env: { SHADO_HOME: home } });
}

/** Join shado results' stdout/stderr into one trimmed log blob. */
function shadoLog(...results: Array<{ stdout: string; stderr: string }>): string {
  return results
    .flatMap((r) => [r.stdout, r.stderr])
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** {@link buildBase} for macOS/Linux: freeze the base, then mount every slot
 *  clone — direct shado calls, no elevation. */
async function buildBaseUnix(
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
  const nameErr =
    badShadoName(opts.baseName, 'base name') ?? badShadoName(opts.slotPrefix, 'slot prefix');
  if (nameErr) return { ok: false, log: nameErr };
  const home = shadoHomeForRepo(opts.repoPath, opts.repoId);
  const worktreesDir = join(popbotRootForRepo(opts.repoPath), 'workspaces', opts.repoId);
  const results: Array<{ stdout: string; stderr: string; ok: boolean; code: number }> = [];

  // Freeze the base from the warm folder — the long step (a reflink clone of the
  // whole tree, or a full copy on a non-COW filesystem). Stream an elapsed timer
  // so the wizard never shows a dead spinner. No --size-gb: that ceiling is
  // advisory only to the image-based Windows backend; reflink/clonefile ignore it.
  const startedMs = Date.now();
  const timer = onProgress
    ? setInterval(() => {
        const secs = Math.floor((Date.now() - startedMs) / 1000);
        const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
        onProgress?.(`Building base — ${elapsed}`);
      }, 1000)
    : undefined;
  const create = await shadoAt(home, [
    'create', opts.repoPath, '--name', opts.baseName, '--count', '0', '--no-main',
  ]);
  if (timer) clearInterval(timer);
  results.push(create);
  if (!create.ok) {
    return { ok: false, log: shadoLog(...results) || `shado create failed (exit ${create.code}).` };
  }

  // Mount each slot clone off the frozen base. Reflink/clonefile clones are
  // instant, so a per-slot line is enough. Bail on the first failure (mirrors
  // the Windows batch's `if errorlevel 1 exit`).
  for (let k = 1; k <= opts.slotCount; k += 1) {
    const slot = `${opts.slotPrefix}-${k}`;
    const mount = join(worktreesDir, slot);
    onProgress?.(`Creating slot ${k} of ${opts.slotCount}…`);
    const clone = await shadoAt(home, [
      'clone', 'create', '--name', opts.baseName, '--slot', slot, '--mount', mount,
    ]);
    results.push(clone);
    if (!clone.ok) {
      return {
        ok: false,
        log: shadoLog(...results) || `shado clone create failed (exit ${clone.code}).`,
      };
    }
  }
  return { ok: true, log: shadoLog(...results) };
}

/** {@link remountSlots} for macOS/Linux: nothing to do. A reflink/clonefile
 *  shadow is a plain directory, not a kernel mount, so it persists across a
 *  reboot intact — unlike a Windows VHDX, whose mount is dropped on restart and
 *  must be re-attached. The startup reconcile can call this unconditionally. */
async function remountSlotsUnix(
  _opts: { repoPath: string; repoId: string; baseName: string },
  _onProgress?: ProgressFn,
): Promise<BaseBuildResult> {
  return { ok: true, log: '' };
}

/** {@link destroyBase} for macOS/Linux: tear down the whole shado project. */
async function destroyBaseUnix(
  opts: { repoPath: string; repoId: string; baseName: string },
  onProgress?: ProgressFn,
): Promise<BaseBuildResult> {
  const nameErr = badShadoName(opts.baseName, 'base name');
  if (nameErr) return { ok: false, log: nameErr };
  const home = shadoHomeForRepo(opts.repoPath, opts.repoId);
  onProgress?.('Removing workspace base + slots…');
  const r = await shadoAt(home, ['restore', '--name', opts.baseName, '--no-export', '--force']);
  const log = shadoLog(r);
  if (!r.ok) {
    // Already gone (a prior partial delete) → nothing to tear down, treat as ok.
    if (/no project/i.test(log)) return { ok: true, log };
    return { ok: false, log: log || `shado restore failed (exit ${r.code}).` };
  }
  return { ok: true, log };
}

/** {@link growSlotClones} for macOS/Linux: create+mount slots fromCount+1..toCount. */
async function growSlotClonesUnix(
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
  if (opts.toCount <= opts.fromCount) return { ok: true, log: '' };
  const nameErr =
    badShadoName(opts.baseName, 'base name') ?? badShadoName(opts.slotPrefix, 'slot prefix');
  if (nameErr) return { ok: false, log: nameErr };
  const home = shadoHomeForRepo(opts.repoPath, opts.repoId);
  const worktreesDir = join(popbotRootForRepo(opts.repoPath), 'workspaces', opts.repoId);
  const results: Array<{ stdout: string; stderr: string; ok: boolean; code: number }> = [];
  onProgress?.(`Creating slots ${opts.fromCount + 1}–${opts.toCount}…`);
  for (let k = opts.fromCount + 1; k <= opts.toCount; k += 1) {
    const slot = `${opts.slotPrefix}-${k}`;
    const mount = join(worktreesDir, slot);
    // Tolerate an already-existing clone (re-running expand) — mirror the
    // Windows batch, which omits `exit /b` here. But a REAL failure
    // (ENOSPC / permission / bad path) must abort: unlike a benign
    // already-exists, a missing clone would only surface much later in the
    // per-slot VCS init, so fail the grow now.
    const clone = await shadoAt(home, [
      'clone', 'create', '--name', opts.baseName, '--slot', slot, '--mount', mount,
    ]);
    results.push(clone);
    if (!clone.ok && !/already exists/i.test(shadoLog(clone))) {
      return {
        ok: false,
        log: shadoLog(...results) || `shado clone create failed (exit ${clone.code}).`,
      };
    }
  }
  return { ok: true, log: shadoLog(...results) };
}

/** {@link remountReposElevated} for macOS/Linux: nothing to do — reflink/
 *  clonefile clones are plain directories that persist across a reboot (see
 *  {@link remountSlotsUnix}). */
async function remountReposUnix(
  _repos: Array<{ repoPath: string; repoId: string; baseName: string }>,
  _onProgress?: ProgressFn,
): Promise<BaseBuildResult> {
  return { ok: true, log: '' };
}

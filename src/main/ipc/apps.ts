/**
 * Per-slot external-app launcher. Powers the icon row on each chat
 * column (terminal, editor, git client, unity).
 *
 * Strategy: every action shells out to macOS `open -a <App> <path>`,
 * which has the right "focus existing window if possible, else launch
 * new" behavior built in. Falls back to URL schemes (`vscode://`,
 * `cursor://`) when those are more reliable.
 */
import { ipcMain } from 'electron';
import { existsSync, readdirSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { IpcChannel } from '@shared/ipc';
import {
  type GameEngineId,
  type GameEngineConfig,
  type GameEnginesSettings,
  engineMeta,
} from '@shared/gameEngine';
import { getSetting } from '../persistence/settings';
import { getChat } from '../persistence/chats';
import { applyPerforceAgentCwd } from '../git/chatPaths';

const execFileP = promisify(execFile);

interface AppsSettings {
  /** macOS app name for terminal launches. Default 'iTerm'. */
  terminalApp?: string;
  /** 'vscode' | 'cursor' — the editor handler to use for "Open editor". */
  editorApp?: string;
  /** macOS app name for git client. Default 'GitHub Desktop'. */
  gitApp?: string;
  /** Per-engine launch config (Unity / Unreal / Custom). Independently
   *  enable-able — see @shared/gameEngine. */
  engines?: GameEnginesSettings;
  /** @deprecated pre-multi-engine Unity binary path. Still read as a fallback
   *  for `engines.unity.binary` so an existing config isn't dropped. */
  unityBinary?: string;
  /** @deprecated pre-multi-engine Unity project subpath. Fallback for
   *  `engines.unity.projectSubpath`. */
  unityProjectSubpath?: string;
}

/** Result of a per-slot app/engine launch. `reason: 'not-configured'` tells
 *  the renderer to deep-link the user to Preferences → Integrations instead of
 *  showing an error alert. */
type LaunchResult = { ok: true } | { ok: false; error: string; reason?: 'not-configured' };

/** Resolve an engine's effective config from settings, folding the legacy
 *  top-level Unity fields into `engines.unity` so old configs keep working. */
function resolveEngineCfg(cfg: AppsSettings, id: GameEngineId): GameEngineConfig {
  const e = cfg.engines?.[id] ?? {};
  if (id === 'unity') {
    return {
      enabled: e.enabled ?? true,
      binary: e.binary ?? cfg.unityBinary,
      projectSubpath: e.projectSubpath ?? cfg.unityProjectSubpath,
    };
  }
  return e;
}

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

async function openApp(appName: string, path: string): Promise<void> {
  // `open -a "<App>" <path>` activates an existing instance pointed
  // at <path> when supported, else launches a fresh one.
  await execFileP('open', ['-a', appName, path]);
}

/**
 * Is `bin` resolvable on the Windows PATH? Uses `where.exe`, which exits
 * 0 (and prints the resolved path) when found, non-zero otherwise. We
 * probe before spawning because the actual launch is detached + shelled
 * (`shell: true`), so a missing binary never produces a synchronous throw
 * nor a child `'error'` event — the shell just exits non-zero out of band.
 * Without this probe every launch would report success even when nothing
 * opened. `where` accepts the bare command name and matches `.exe`/`.cmd`
 * PATHEXT entries (so `code` resolves `code.cmd`, `wt` resolves `wt.exe`).
 */
async function windowsHasCommand(bin: string): Promise<boolean> {
  try {
    await execFileP('where', [bin]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows launcher for the per-slot icon row. macOS routes everything
 * through `open -a`; Windows has no single equivalent, so we map each
 * app kind to its native invocation:
 *
 *   - editor:   the editor's CLI shim (`code` / `cursor`), which opens
 *     (or focuses) the folder. Spawned via the shell because they're
 *     `.cmd` files on PATH.
 *   - terminal: Windows Terminal (`wt.exe -d <path>`) when available,
 *     else a `cmd.exe` window rooted at the worktree.
 *   - git:      GitHub Desktop via its `github` CLI shim if present.
 *
 * Each branch PROBES the target binary with `where.exe` first (see
 * `windowsHasCommand`) and returns `{ ok: false, error }` when it's
 * missing, so the renderer can surface a real "not installed" message
 * instead of a silent no-op. The detached spawn that follows can't
 * report failure on its own — that's exactly why the probe exists.
 */
async function openAppWindows(
  kind: 'terminal' | 'editor' | 'git',
  cfg: AppsSettings,
  worktreePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const spawnDetached = (file: string, args: string[]): void => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', shell: true });
    // Missing binaries are caught by the `where` probe above; this only
    // guards against late spawn errors so they don't crash the process.
    child.once('error', () => { /* best-effort: already probed */ });
    child.unref();
  };
  try {
    switch (kind) {
      case 'editor': {
        const editor = (cfg.editorApp || 'vscode').toLowerCase();
        const bin = editor === 'cursor' ? 'cursor' : 'code';
        if (!(await windowsHasCommand(bin))) {
          const name = editor === 'cursor' ? 'Cursor' : 'VS Code';
          return {
            ok: false,
            error: `${name} command (\`${bin}\`) not found on PATH. Install ${name} and enable its shell command.`,
          };
        }
        spawnDetached(bin, [`"${worktreePath}"`]);
        return { ok: true };
      }
      case 'terminal': {
        // Prefer Windows Terminal; fall back to a plain cmd window
        // rooted at the worktree when `wt` isn't installed. `cmd.exe`
        // always exists, so the fallback never needs a probe.
        if (await windowsHasCommand('wt')) {
          spawnDetached('cmd', ['/c', 'start', 'wt', '-d', `"${worktreePath}"`]);
        } else {
          spawnDetached('cmd', ['/c', 'start', 'cmd', '/k', 'cd', '/d', `"${worktreePath}"`]);
        }
        return { ok: true };
      }
      case 'git': {
        // GitHub Desktop installs a `github` CLI shim that opens the
        // repo at <path>.
        if (!(await windowsHasCommand('github'))) {
          return {
            ok: false,
            error: 'GitHub Desktop (`github` command) not found on PATH. Install GitHub Desktop to use this action.',
          };
        }
        spawnDetached('github', [`"${worktreePath}"`]);
        return { ok: true };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Open a new iTerm window in `cwd` with a custom tab title. Uses
 * iTerm's AppleScript dictionary so we can set both `name` and the
 * starting directory in one shot — `open -a iTerm <path>` lets you
 * pick the cwd but not the title.
 */
async function openITermWithTitle(cwd: string, title: string): Promise<void> {
  // Escape single-quotes for safe interpolation into the AppleScript.
  const esc = (s: string) => s.replace(/'/g, "'\\''");
  const script = `
    tell application "iTerm"
      activate
      set newWindow to (create window with default profile)
      tell current session of newWindow
        write text "cd '${esc(cwd)}' && clear"
        set name to "${esc(title)}"
      end tell
    end tell
  `;
  await execFileP('osascript', ['-e', script]);
}

/** Unity Hub's editor install root, per platform (null = unsupported). */
function unityHubRoot(): string | null {
  if (isMac) return '/Applications/Unity/Hub/Editor';
  if (isWindows) return 'C:\\Program Files\\Unity\\Hub\\Editor';
  return join(homedir(), 'Unity', 'Hub', 'Editor'); // Linux Hub default
}

/** Epic Games install root (holds `UE_5.x` version dirs), per platform. */
function unrealInstallRoot(): string | null {
  if (isMac) return '/Users/Shared/Epic Games';
  if (isWindows) return 'C:\\Program Files\\Epic Games';
  return null; // Linux Unreal is a manual build — no standard install path
}

/**
 * Find the PID of a running Unity instance with the given project path
 * (was passed `-projectPath <projectPath>` at launch). Returns null
 * when none is found.
 */
interface RunningUnityProject { projectPath: string; pid: number }

/**
 * Scan all running Unity processes once and return their `-projectPath`
 * args. Result is cached briefly so the periodic poll from the
 * renderer + per-slot lookups inside a single tick share one `ps`.
 */
const PS_CACHE_MS = 1500;
let psCache: { ts: number; projects: RunningUnityProject[] } | null = null;

async function listRunningUnityProjects(): Promise<RunningUnityProject[]> {
  // Unity detection relies on `ps` (Unix). No Windows equivalent wired
  // up yet — return empty rather than spawning a missing binary on the
  // renderer's 2s poll.
  if (!isMac) return [];
  const now = Date.now();
  if (psCache && now - psCache.ts < PS_CACHE_MS) return psCache.projects;
  const out: RunningUnityProject[] = [];
  try {
    const { stdout } = await execFileP('ps', ['-ax', '-o', 'pid=,command=']);
    for (const line of stdout.split('\n')) {
      if (!line.includes('Unity.app')) continue;
      const m = /^\s*(\d+)\s+/.exec(line);
      if (!m) continue;
      // -projectPath supports both quoted and bare paths (`open` quotes,
      // `spawn` doesn't). Parse both.
      const pp =
        /-projectPath\s+"([^"]+)"/.exec(line)?.[1] ??
        /-projectPath\s+(\S+)/.exec(line)?.[1];
      if (!pp) continue;
      out.push({ projectPath: pp, pid: Number(m[1]) });
    }
  } catch { /* leave list empty */ }
  psCache = { ts: now, projects: out };
  return out;
}

async function findUnityPidForProject(projectPath: string): Promise<number | null> {
  const list = await listRunningUnityProjects();
  return list.find((p) => p.projectPath === projectPath)?.pid ?? null;
}

interface GitSettingsLite { worktreesDir?: string }

/**
 * Resolve the slot worktrees root the same way `chats.ts` does, so the
 * "is this path a slot?" check matches what the launcher uses. Falls
 * back to the conventional `~/popbot/worktrees` when git isn't set up
 * yet — better to optimistically detect than to silently bail.
 */
function getWorktreesRoot(): string {
  const s = getSetting<GitSettingsLite>('git');
  return s?.worktreesDir || join(homedir(), 'popbot', 'worktrees');
}

interface RunningAppsByKind {
  terminal: string[];
  editor: string[];
  git: string[];
  unity: string[];
  unreal: string[];
  custom: string[];
}

/**
 * Run `lsof -p <pids> -d cwd -Fpn` and return a map pid → cwd.
 * Skips the call entirely when `pids` is empty (otherwise lsof would
 * dump every process on the box).
 */
async function lsofCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  try {
    const { stdout } = await execFileP('lsof', ['-p', pids.join(','), '-d', 'cwd', '-Fpn']);
    let curPid = 0;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) curPid = Number(line.slice(1));
      else if (line.startsWith('n') && curPid) out.set(curPid, line.slice(1));
    }
  } catch {
    /* leave map empty */
  }
  return out;
}

async function pgrepX(name: string): Promise<number[]> {
  try {
    const { stdout } = await execFileP('pgrep', ['-x', name]);
    return stdout.split('\n').filter(Boolean).map(Number);
  } catch {
    // pgrep exits non-zero when no matches — that's fine.
    return [];
  }
}

const APPS_CACHE_MS = 1500;
let appsCache: { ts: number; result: RunningAppsByKind } | null = null;

/**
 * Per-slot running detection. Returns slot basenames (e.g. 'slot-3')
 * grouped by app kind.
 *
 * Signal source:
 *  - terminal: shell processes (zsh/bash/fish) whose cwd lives under
 *    a slot worktree. Misses cases where the user has cd'd elsewhere.
 *  - editor:   not implemented — VSCode renderer cwd is `/`, neither
 *              extension hosts nor tsserver hold workspace files open
 *              that we could lsof, and VSCode exposes no AppleScript
 *              dictionary. Empty for now.
 *  - git:      disabled — GitHub Desktop doesn't work with worktrees,
 *              so the icon itself is hidden in the renderer.
 *  - unity:    `-projectPath` arg from `ps` (already used by the
 *              launcher's "focus existing instance" path).
 *
 * Result is cached briefly to coalesce simultaneous renderer ticks.
 */
async function listRunningAppsForSlots(): Promise<RunningAppsByKind> {
  // Detection uses `pgrep`/`lsof`/`ps` (Unix). On Windows we have no
  // per-slot running signal yet, so short-circuit to empty instead of
  // firing missing-binary spawns every poll tick.
  if (!isMac) return { terminal: [], editor: [], git: [], unity: [], unreal: [], custom: [] };
  const now = Date.now();
  if (appsCache && now - appsCache.ts < APPS_CACHE_MS) return appsCache.result;

  const root = getWorktreesRoot();
  const slotPrefix = `${root}/slot-`;
  const terminal = new Set<string>();
  const unity = new Set<string>();

  // Terminal: scan shell cwds.
  const shellPids = (await Promise.all([pgrepX('zsh'), pgrepX('bash'), pgrepX('fish')])).flat();
  const cwds = await lsofCwds(shellPids);
  for (const cwd of cwds.values()) {
    if (!cwd.startsWith(slotPrefix)) continue;
    // cwd looks like /<root>/slot-3/some/sub/dir → grab 'slot-3'.
    const tail = cwd.slice(root.length + 1);
    const slot = tail.split('/')[0];
    if (slot?.startsWith('slot-')) terminal.add(slot);
  }

  // Unity: reuse the ps-based scanner.
  const projects = await listRunningUnityProjects();
  for (const p of projects) {
    if (!p.projectPath.startsWith(slotPrefix)) continue;
    const tail = p.projectPath.slice(root.length + 1);
    const slot = tail.split('/')[0];
    if (slot?.startsWith('slot-')) unity.add(slot);
  }

  const result: RunningAppsByKind = {
    terminal: [...terminal],
    editor: [],
    git: [],
    unity: [...unity],
    // Unreal/custom per-slot running detection isn't wired up yet (the button
    // still launches/focuses fine; it just won't show a "running" ring).
    unreal: [],
    custom: [],
  };
  appsCache = { ts: now, result };
  return result;
}

/**
 * Bring a process to the foreground by PID. Uses System Events because
 * `open -a` activates an app by name (and we'd lose the per-window
 * disambiguation when several Unity instances run at once).
 */
async function focusPid(pid: number): Promise<void> {
  const script = `
    tell application "System Events"
      set targetProc to first process whose unix id is ${pid}
      set frontmost of targetProc to true
    end tell
  `;
  await execFileP('osascript', ['-e', script]);
}

/**
 * Find a Unity window whose title contains `projectPath`, raise it,
 * and bring its process to the foreground. Returns true on success,
 * false when no matching window exists.
 *
 * Why this over PID-based focus: Unity now puts the full project
 * path in each editor window's title bar, so we can disambiguate
 * concurrent slot instances by string match. PID-based focus alone
 * (`set frontmost of pid` via System Events) tends to raise whichever
 * Unity window the OS most-recently activated within that process
 * group, which on multi-instance setups is usually the wrong slot.
 * AXRaise on the specific window forces the right one to the front.
 *
 * Caller is expected to fall back to a fresh launch if this returns
 * false — Unity hasn't been spawned for this project yet.
 */
async function focusUnityWindowByProjectPath(projectPath: string): Promise<boolean> {
  // Escape for inclusion in an AppleScript string literal: backslash
  // first, then double-quote. AppleScript uses C-style escapes inside
  // `"..."`.
  const escaped = projectPath
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`);
  const script = `
    tell application "System Events"
      set targetPath to "${escaped}"
      set unityProcs to (every process whose name is "Unity")
      repeat with p in unityProcs
        try
          set ws to windows of p
        on error
          set ws to {}
        end try
        repeat with w in ws
          try
            if (name of w) contains targetPath then
              set frontmost of p to true
              perform action "AXRaise" of w
              return "ok"
            end if
          end try
        end repeat
      end repeat
      return "none"
    end tell
  `;
  try {
    const { stdout } = await execFileP('osascript', ['-e', script]);
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

interface EngineVersion { version: string; binary: string }

/**
 * List Unity Editor versions installed via Unity Hub. Each entry is the
 * version dir (e.g. '6.3.0f1') + the absolute path of its Unity binary,
 * resolved per platform (Unity.app on macOS, Unity.exe on Windows). Filters
 * out anything whose binary is missing.
 */
function listUnityVersions(): EngineVersion[] {
  const root = unityHubRoot();
  if (!root || !existsSync(root)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: EngineVersion[] = [];
  for (const v of entries) {
    if (v.startsWith('.')) continue;
    const binary = isWindows
      ? join(root, v, 'Editor', 'Unity.exe')
      : isMac
        ? `${root}/${v}/Unity.app/Contents/MacOS/Unity`
        : join(root, v, 'Editor', 'Unity');
    if (existsSync(binary)) out.push({ version: v, binary });
  }
  // Newest-looking first (lexicographic is close enough for a single
  // major-version family, the common case).
  out.sort((a, b) => b.version.localeCompare(a.version));
  return out;
}

/**
 * List Unreal Engine versions installed via the Epic Games Launcher. Version
 * dirs are named `UE_5.4`, `UE_5.3`, …; the label strips the `UE_` prefix.
 * The editor binary is UnrealEditor(.exe/.app) under Engine/Binaries.
 */
function listUnrealVersions(): EngineVersion[] {
  const root = unrealInstallRoot();
  if (!root || !existsSync(root)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: EngineVersion[] = [];
  for (const d of entries) {
    if (!d.startsWith('UE_')) continue;
    const binary = isWindows
      ? join(root, d, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe')
      : `${root}/${d}/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor`;
    if (existsSync(binary)) out.push({ version: d.replace(/^UE_/, ''), binary });
  }
  out.sort((a, b) => b.version.localeCompare(a.version));
  return out;
}

/** Auto-detected editor installs for an engine. Custom has none. */
function listEngineVersions(id: GameEngineId): EngineVersion[] {
  if (id === 'unity') return listUnityVersions();
  if (id === 'unreal') return listUnrealVersions();
  return [];
}

/** Locate the single `.uproject` in an Unreal project dir. */
function findUproject(dir: string): string | null {
  try {
    const f = readdirSync(dir).find((n) => n.toLowerCase().endsWith('.uproject'));
    return f ? join(dir, f) : null;
  } catch {
    return null;
  }
}

/** Which engine, if any, a SINGLE directory is the project root of. Unreal
 *  wins (a `.uproject` is definitive); Unity is `ProjectSettings/
 *  ProjectVersion.txt` (or the `Assets/` + `ProjectSettings/` pair). */
function dirEngineMarker(dir: string): GameEngineId | null {
  if (!existsSync(dir)) return null;
  if (findUproject(dir)) return 'unreal';
  if (existsSync(join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) return 'unity';
  if (existsSync(join(dir, 'Assets')) && existsSync(join(dir, 'ProjectSettings'))) return 'unity';
  return null;
}

/** Heavy/irrelevant dirs skipped when scanning a worktree for a project. */
const SCAN_IGNORE_DIRS = new Set([
  '.git', '.vs', '.shado', 'node_modules', 'library', 'intermediate', 'saved',
  'deriveddatacache', 'binaries', 'build', 'logs',
]);

/** Depth + total-dir bounds for the worktree scan. The project can be nested
 *  a few levels deep (e.g. Perforce's `depot/PopBotGame/UnrealGame/`), so we
 *  descend a bit, but prune heavy dirs and cap total visits so a big game tree
 *  can't stall detection. */
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_DIRS = 500;

/**
 * Detect the game engine a chat's worktree belongs to. The worktree either IS
 * the project (root has the marker) or HAS one nested inside (a child folder,
 * possibly a few levels down — e.g. `depot/PopBotGame/UnrealGame/`). Returns
 * the engine + the project's subpath (`''` = root) so the launcher can open it
 * with no manual config. Breadth-first so the SHALLOWEST project wins; Unreal
 * beats Unity within any single directory. Null when neither is found.
 */
function detectEngineForWorktree(worktreePath: string): { engine: GameEngineId; projectSubpath: string } | null {
  if (!worktreePath || !existsSync(worktreePath)) return null;
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: worktreePath, rel: '', depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const { dir, rel, depth } = queue.shift()!;
    if (++visited > MAX_SCAN_DIRS) break;
    const marker = dirEngineMarker(dir);
    if (marker) return { engine: marker, projectSubpath: rel };
    if (depth >= MAX_SCAN_DEPTH) continue;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || SCAN_IGNORE_DIRS.has(e.name.toLowerCase())) continue;
        queue.push({ dir: join(dir, e.name), rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 });
      }
    } catch {
      /* unreadable dir — skip */
    }
  }
  return null;
}

/**
 * The project directory to launch for `id` in `worktreePath`. Prefers the
 * user's configured subpath when it actually looks like this engine; otherwise
 * auto-detects (worktree root or a child project folder). Falls back to the
 * configured/root path so the launcher can surface a clear error.
 */
function resolveEngineProjectDir(worktreePath: string, id: GameEngineId, cfg: AppsSettings): string {
  const sub = (resolveEngineCfg(cfg, id).projectSubpath ?? '').trim();
  const configured = sub ? join(worktreePath, sub) : worktreePath;
  if (dirEngineMarker(configured) === id) return configured;
  const det = detectEngineForWorktree(worktreePath);
  if (det && det.engine === id) {
    return det.projectSubpath ? join(worktreePath, det.projectSubpath) : worktreePath;
  }
  return configured;
}

/** Spawn a detached editor process; resolve on successful spawn. */
async function spawnDetachedEditor(binary: string, args: string[], label: string): Promise<LaunchResult> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      // Detached — outlives popbot. Resolve as soon as spawn succeeds.
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${label} launch failed: ${(err as Error).message}` };
  }
}

/**
 * Launch (or focus) a game engine's editor for a slot's project.
 *   - unity : direct `-projectPath` launch; on macOS focuses an already-running
 *             instance for this project first (window-title, then PID).
 *   - unreal: opens the project's `.uproject`; Unreal itself focuses an already-
 *             open instance of the same project.
 *   - custom: runs the configured shell command (posix vs Windows variant) in
 *             the project directory.
 */
async function launchEngine(id: GameEngineId, cfg: AppsSettings, worktreePath: string): Promise<LaunchResult> {
  const ec = resolveEngineCfg(cfg, id);
  // Unity/Unreal auto-locate the project (root or a child folder); Custom runs
  // in the configured subpath (or the worktree root).
  const proj =
    id === 'custom'
      ? ((ec.projectSubpath ?? '').trim() ? join(worktreePath, (ec.projectSubpath ?? '').trim()) : worktreePath)
      : resolveEngineProjectDir(worktreePath, id, cfg);
  if (!existsSync(proj)) {
    return { ok: false, error: `Project path not found: ${proj}` };
  }
  const label = engineMeta(id).label;

  if (id === 'custom') {
    const command = (isWindows ? ec.runWindows : ec.runPosix)?.trim();
    if (!command) {
      return {
        ok: false,
        error: `${label} run command not set. Open Preferences → Integrations to configure it.`,
        reason: 'not-configured',
      };
    }
    try {
      const child = isWindows
        ? spawn('cmd', ['/c', command], { cwd: proj, detached: true, stdio: 'ignore' })
        : spawn('bash', ['-lc', command], { cwd: proj, detached: true, stdio: 'ignore' });
      child.once('error', () => { /* best-effort: detached */ });
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `${label} launch failed: ${(err as Error).message}` };
    }
  }

  // unity | unreal — need a configured (or detected) editor binary.
  if (!ec.binary) {
    return {
      ok: false,
      error: `${label} editor not configured. Open Preferences → Integrations to set it up.`,
      reason: 'not-configured',
    };
  }
  if (!existsSync(ec.binary)) {
    return { ok: false, error: `${label} binary not found: ${ec.binary}` };
  }

  if (id === 'unity') {
    // Single-instance per project: focus an already-running one (macOS only —
    // relies on AppleScript/ps), else spawn. -noprojectBrowser skips the
    // picker; -logFile is per-slot so slots don't fight for the default log.
    if (await focusUnityWindowByProjectPath(proj)) return { ok: true };
    const existingPid = await findUnityPidForProject(proj);
    if (existingPid) {
      try { await focusPid(existingPid); } catch { /* best-effort */ }
      return { ok: true };
    }
    const logPath = join(tmpdir(), `unity-${basename(worktreePath)}.log`);
    return spawnDetachedEditor(ec.binary, ['-projectPath', proj, '-noprojectBrowser', '-logFile', logPath], label);
  }

  // unreal — open the .uproject; Unreal focuses an existing instance itself.
  const uproject = findUproject(proj);
  if (!uproject) {
    return { ok: false, error: `No .uproject found in ${proj}` };
  }
  return spawnDetachedEditor(ec.binary, [uproject], label);
}

const ENGINE_KINDS: readonly GameEngineId[] = ['unity', 'unreal', 'custom'];
function isEngineKind(kind: string): kind is GameEngineId {
  return (ENGINE_KINDS as readonly string[]).includes(kind);
}

export function registerAppsHandlers(): void {
  ipcMain.handle(IpcChannel.UnityListVersions, () => listUnityVersions());
  ipcMain.handle(IpcChannel.UnityRunningProjects, () => listRunningUnityProjects());
  ipcMain.handle(IpcChannel.AppsRunning, () => listRunningAppsForSlots());
  ipcMain.handle(IpcChannel.EngineListVersions, (_e, engineId: GameEngineId) => listEngineVersions(engineId));
  ipcMain.handle(IpcChannel.AppsDetectEngine, (_e, worktreePath: string) => detectEngineForWorktree(worktreePath)?.engine ?? null);

  ipcMain.handle(
    IpcChannel.AppsOpen,
    async (
      _e,
      kind: 'terminal' | 'editor' | 'git' | GameEngineId,
      worktreePath: string,
      chatId?: string,
    ) => {
      if (!worktreePath || !existsSync(worktreePath)) {
        return { ok: false as const, error: 'Worktree path not found' };
      }
      const cfg = getSetting<AppsSettings>('apps') ?? {};
      // Game engines (Unity/Unreal/Custom) launch the same way on every
      // platform (spawn the editor binary / run the command), so they route to
      // launchEngine before the macOS-vs-Windows split below.
      if (isEngineKind(kind)) {
        return launchEngine(kind, cfg, worktreePath);
      }
      // The TERMINAL opens where the AGENT runs — for a Perforce repo that's a
      // configured subdir of the mount root. Editor/git keep the mount root
      // (that's where .git/.p4config live). cwd === worktreePath for non-p4.
      const termCwd =
        kind === 'terminal' && chatId
          ? applyPerforceAgentCwd(worktreePath, getChat(chatId)) ?? worktreePath
          : worktreePath;
      // Windows: terminal/editor/git map to native launchers.
      if (isWindows && (kind === 'terminal' || kind === 'editor' || kind === 'git')) {
        return openAppWindows(kind, cfg, kind === 'terminal' ? termCwd : worktreePath);
      }
      try {
        switch (kind) {
          case 'terminal': {
            const term = cfg.terminalApp || 'iTerm';
            const title = basename(worktreePath); // e.g. 'slot-3'
            if (term === 'iTerm') {
              await openITermWithTitle(termCwd, title);
            } else {
              await openApp(term, termCwd);
            }
            return { ok: true as const };
          }
          case 'editor': {
            const editor = (cfg.editorApp || 'vscode').toLowerCase();
            const appName = editor === 'cursor' ? 'Cursor' : 'Visual Studio Code';
            // `open -a <App> <path>` makes the editor open the folder
            // — if a window already has this folder it gets focus,
            // otherwise a new window is created. The vscode:// URL
            // scheme replaces the contents of the most-recent window
            // instead, which is not what we want.
            await openApp(appName, worktreePath);
            return { ok: true as const };
          }
          case 'git':
            await openApp(cfg.gitApp || 'GitHub Desktop', worktreePath);
            return { ok: true as const };
          default:
            return { ok: false as const, error: `Unknown app kind: ${kind}` };
        }
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
  );
}

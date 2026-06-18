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
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { IpcChannel } from '@shared/ipc';
import { getSetting } from '../persistence/settings';

const execFileP = promisify(execFile);

interface AppsSettings {
  /** macOS app name for terminal launches. Default 'iTerm'. */
  terminalApp?: string;
  /** 'vscode' | 'cursor' — the editor handler to use for "Open editor". */
  editorApp?: string;
  /** macOS app name for git client. Default 'GitHub Desktop'. */
  gitApp?: string;
  /** Absolute path to the Unity Editor binary, e.g.
   *  /Applications/Unity/Hub/Editor/6.3.0f1/Unity.app/Contents/MacOS/Unity
   *  When set, slot-launch goes direct (with -projectPath /
   *  -noprojectBrowser / per-slot -logFile). When unset, falls back
   *  to Unity Hub so users without a configured version still work. */
  unityBinary?: string;
  /** Path of the Unity project relative to the worktree root.
   *  Defaults to blank (the worktree root is the Unity project). */
  unityProjectSubpath?: string;
}

async function openApp(appName: string, path: string): Promise<void> {
  // `open -a "<App>" <path>` activates an existing instance pointed
  // at <path> when supported, else launches a fresh one.
  await execFileP('open', ['-a', appName, path]);
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

const UNITY_HUB_EDITORS = '/Applications/Unity/Hub/Editor';

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

/**
 * List Unity Editor versions installed via Unity Hub. Each entry is
 * the directory name (e.g. '6.3.0f1') paired with the absolute path
 * of its Unity binary. Filters out anything missing the binary.
 */
function listUnityVersions(): Array<{ version: string; binary: string }> {
  if (!existsSync(UNITY_HUB_EDITORS)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(UNITY_HUB_EDITORS);
  } catch {
    return [];
  }
  const out: Array<{ version: string; binary: string }> = [];
  for (const v of entries) {
    if (v.startsWith('.')) continue;
    const binary = `${UNITY_HUB_EDITORS}/${v}/Unity.app/Contents/MacOS/Unity`;
    if (existsSync(binary)) out.push({ version: v, binary });
  }
  // Sort newest-looking first (Unity versions sort lexicographically
  // close enough — '6.3.0f1' > '2022.3.45f1' isn't right but real
  // installs are usually a single major-version family).
  out.sort((a, b) => b.version.localeCompare(a.version));
  return out;
}

export function registerAppsHandlers(): void {
  ipcMain.handle(IpcChannel.UnityListVersions, () => listUnityVersions());
  ipcMain.handle(IpcChannel.UnityRunningProjects, () => listRunningUnityProjects());
  ipcMain.handle(IpcChannel.AppsRunning, () => listRunningAppsForSlots());

  ipcMain.handle(
    IpcChannel.AppsOpen,
    async (_e, kind: 'terminal' | 'editor' | 'git' | 'unity', worktreePath: string) => {
      if (!worktreePath || !existsSync(worktreePath)) {
        return { ok: false as const, error: 'Worktree path not found' };
      }
      const cfg = getSetting<AppsSettings>('apps') ?? {};
      try {
        switch (kind) {
          case 'terminal': {
            const term = cfg.terminalApp || 'iTerm';
            const title = basename(worktreePath); // e.g. 'slot-3'
            if (term === 'iTerm') {
              await openITermWithTitle(worktreePath, title);
            } else {
              await openApp(term, worktreePath);
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
          case 'unity': {
            // Unity project may live one level deeper than the
            // worktree root, depending on repo layout. Configurable so
            // other repos / layouts work; blank = worktree root.
            const subpath = (cfg.unityProjectSubpath ?? '').trim();
            const proj = subpath ? join(worktreePath, subpath) : worktreePath;
            if (!existsSync(proj)) {
              return { ok: false as const, error: `Not a Unity project: ${proj}` };
            }
            if (!cfg.unityBinary) {
              return {
                ok: false as const,
                error: 'Unity Editor not configured. Open Preferences → Unity to pick a version.',
                reason: 'unity-not-configured' as const,
              };
            }
            // Unity is single-instance per project. If one is already
            // running with this project path, bring its window to the
            // front instead of launching a duplicate.
            //
            // Primary path: window-title match. Unity's title bar
            // contains the full project path, so we can disambiguate
            // concurrent slot instances exactly. AXRaise on the
            // matched window forces the right one forward, even when
            // multiple Unity processes share focus history.
            if (await focusUnityWindowByProjectPath(proj)) {
              return { ok: true as const };
            }
            // Fallback: PID-based focus. Catches the case where Unity
            // is launched but the editor window hasn't opened yet
            // (splash / project-load) so there's no titled window to
            // match against. Path-equality is exact — Unity sometimes
            // canonicalizes the path differently from us, which is
            // why this is a fallback rather than the primary signal.
            const existingPid = await findUnityPidForProject(proj);
            if (existingPid) {
              try { await focusPid(existingPid); } catch { /* best-effort */ }
              return { ok: true as const };
            }
            if (cfg.unityBinary) {
              if (!existsSync(cfg.unityBinary)) {
                return {
                  ok: false as const,
                  error: `Unity binary not found: ${cfg.unityBinary}`,
                };
              }
              // Direct launch — bypasses Unity Hub. -noprojectBrowser
              // skips the project picker; -logFile is per-slot so we
              // don't fight other slots for the default log path.
              const slotName = basename(worktreePath); // e.g. 'slot-3'
              const logPath = `/tmp/unity-${slotName}.log`;
              try {
                await new Promise<void>((resolve, reject) => {
                  const child = spawn(
                    cfg.unityBinary!,
                    ['-projectPath', proj, '-noprojectBrowser', '-logFile', logPath],
                    { detached: true, stdio: 'ignore' },
                  );
                  child.once('error', reject);
                  // The process is detached — it'll outlive popbot.
                  // Resolve as soon as spawn succeeds (next tick).
                  child.once('spawn', () => { child.unref(); resolve(); });
                });
                return { ok: true as const };
              } catch (err) {
                return {
                  ok: false as const,
                  error: `Unity launch failed: ${(err as Error).message}`,
                };
              }
            }
            // Fall back to Unity Hub if no direct binary configured.
            await openApp('Unity Hub', proj);
            return { ok: true as const };
          }
          default:
            return { ok: false as const, error: `Unknown app kind: ${kind}` };
        }
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
  );
}

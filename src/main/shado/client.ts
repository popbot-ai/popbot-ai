// Thin client for the bundled `shado` shadow-workspace controller.
//
// shado manages VHDX copy-on-write "shadow" workspaces (a frozen read-only base
// plus per-slot differencing children) for projects too large to copy — the
// Windows storage substrate behind PopBot's warm-slot model for Perforce/game
// trees. See https://github.com/popbot-ai/shado.
//
// This module only locates and invokes the binary; it never opens a console
// window (windowsHide), and shado itself runs its own child processes windowless.
// Privileged operations (create/clone/recache/restore) require elevation — those
// are gated and surfaced to the user, not run silently as admin here.

import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'
import { app } from 'electron'

export interface ShadoShadow {
  id: string
  mount: string
  vhdx: string
  cleanSize: number
  main?: boolean
  parked?: boolean
}

export interface ShadoProject {
  name: string
  originalFolder: string
  baseVhdx: string
  sizeGb: number
  shadowsRoot: string
  shadows: ShadoShadow[]
}

export interface ShadoRegistry {
  projects: ShadoProject[]
}

export interface ShadoResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

const exeName = process.platform === 'win32' ? 'shado.exe' : 'shado'
const platformDir =
  process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'

/** Resolve the shado binary in both packaged and dev layouts. */
export function shadoExePath(): string {
  const candidates = [
    join(process.resourcesPath || '', 'shado', exeName), // packaged: resources/shado/
    join(app.getAppPath(), 'native', 'shado', 'bin', platformDir, exeName), // dev (app root)
    join(process.cwd(), 'native', 'shado', 'bin', platformDir, exeName), // dev (cwd)
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  // Fall back to PATH (e.g. a user-installed shado), letting execFile resolve it.
  return exeName
}

export function shadoAvailable(): boolean {
  // A resolved bundled/dev path means it exists. Otherwise we fell back to
  // the bare name — check whether it's actually on PATH (existsSync against a
  // relative name would always be false, hiding a PATH install).
  if (shadoExePath() !== exeName) return true
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, [exeName], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * The PopBot folder on the drive of `repoPath`. Slots MUST live on the
 * same drive as the source repo (the VHDX differencing model + the user's
 * workflow), so we mirror the user-folder-relative path onto the repo's
 * drive: the path AFTER the drive letter is identical on every drive.
 * On the home drive this is `~/popbot` (back-compat with the existing
 * layout); on a data drive it's the same sub-path rooted there
 * (e.g. `D:\Users\me\popbot`). Workspaces live under `…/popbot/workspaces`,
 * the shado base + diffs under `…/popbot/shado`.
 */
export function popbotRootForRepo(repoPath: string): string {
  const home = homedir()
  const homeRel = home.slice(parse(home).root.length) // e.g. "Users\\me"
  const drive = parse(repoPath).root || parse(home).root
  return join(drive, homeRel, 'popbot')
}

/** SHADO_HOME for a repo's slots — the frozen base VHDX and every per-slot
 *  differencing child, on the repo's drive so base creation and slot
 *  cloning always agree on the parent path. */
export function shadoHomeForRepo(repoPath: string): string {
  return join(popbotRootForRepo(repoPath), 'shado')
}

/** Run shado with the given args. Never throws; returns a structured
 *  result. `opts.env` is merged over the process env (e.g. SHADO_HOME). */
export function runShado(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<ShadoResult> {
  return new Promise((resolvePromise) => {
    execFile(
      shadoExePath(),
      args,
      {
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? (err as unknown as { code: number }).code
            : err
              ? 1
              : 0
        resolvePromise({ ok: !err, code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
      },
    )
  })
}

/** Full registry state (bases + shadows) via `shado json`. */
export async function shadoState(): Promise<ShadoRegistry> {
  const r = await runShado(['json'])
  try {
    return JSON.parse(r.stdout || '{}') as ShadoRegistry
  } catch {
    return { projects: [] }
  }
}

/** Human-readable environment check (`shado doctor`). */
export async function shadoDoctor(): Promise<string> {
  const r = await runShado(['doctor'])
  return r.stdout || r.stderr
}

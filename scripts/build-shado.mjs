// Build the bundled `shado` CLI binary into native/shado/ so electron-builder can
// ship it via extraResources. shado is the shadow-workspace controller (VHDX
// copy-on-write slots for very large Perforce/game projects); see
// https://github.com/popbot-ai/shado.
//
// Source defaults to the sibling repo (../shado); override with SHADO_SRC.
// Requires the Go toolchain on PATH. Safe to run on any platform — if the source
// or Go is missing it warns and skips. Windows and Linux ship a committed binary
// today (native/shado/bin/<platform>/); macOS is planned.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = process.env.SHADO_SRC || resolve(repoRoot, '..', 'shado')
const exeName = process.platform === 'win32' ? 'shado.exe' : 'shado'
const platformDir = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform] || process.platform
// Committed location, one folder per platform: the prebuilt binary is checked in
// so PopBot's release CI (no Go toolchain, no shado source) can still bundle it.
// This script just refreshes the current platform's binary locally; commit it.
const outDir = join(repoRoot, 'native', 'shado', 'bin', platformDir)
const outExe = join(outDir, exeName)

function have(cmd) {
  try {
    execFileSync(cmd, ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!existsSync(join(src, 'go.mod'))) {
  console.warn(`[build-shado] no shado source at ${src} (set SHADO_SRC) — skipping bundle.`)
  process.exit(0)
}
if (!have('go')) {
  console.warn('[build-shado] Go toolchain not found on PATH — skipping bundle.')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
console.log(`[build-shado] building ${exeName} from ${src}`)
execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', outExe, '.'], {
  cwd: src,
  stdio: 'inherit',
})
console.log(`[build-shado] -> ${outExe}`)

/**
 * Optional startup probe for the user's Codex CLI. The Codex SDK can
 * fall back to its packaged binary, but a user-installed `codex`
 * usually has the freshest version and exactly the auth/config the
 * user tests in Terminal, so prefer it when available.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dlog } from '../diagLog';
import { resolveCliPath } from './resolveCli';

const execFileP = promisify(execFile);

export interface CodexProbeResult {
  ok: boolean;
  version?: string;
  binaryPath?: string;
  pathUsed?: string;
  error?: string;
}

let cachedBinaryPath: string | null = null;

export function getCodexBinaryPath(): string | null {
  return cachedBinaryPath;
}

export async function probeCodex(): Promise<CodexProbeResult> {
  try {
    const binaryPath = await resolveCliPath('codex');
    const { stdout: verOut } = await execFileP(binaryPath, ['--version'], {
      timeout: 5000,
      env: process.env,
    });
    cachedBinaryPath = binaryPath;
    return { ok: true, version: verOut.trim(), binaryPath, pathUsed: process.env.PATH };
  } catch (err) {
    cachedBinaryPath = null;
    return {
      ok: false,
      pathUsed: process.env.PATH,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeCodexForPath(): Promise<void> {
  const r = await probeCodex();
  dlog('codex.probe', { ...r });
}

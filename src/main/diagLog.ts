/**
 * Append-only diagnostic log for chasing chat-loop / session-recovery
 * bugs. Writes to `app.getPath('logs')/popbot-agent.log`. Synchronous
 * fs.appendFile on purpose — we want lines to land even if the process
 * crashes mid-loop.
 *
 * Find the log on macOS: `~/Library/Logs/PopBot/popbot-agent.log`.
 * (Or `npm run dev` → `~/Library/Logs/Electron/popbot-agent.log`.)
 *
 * Keep entries one line of JSON for easy grep/jq. PII = the chat id +
 * any user prompt text the caller chooses to include; nothing extra
 * is captured.
 */
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Electron's `app`, when this runs inside the desktop app. The host
 *  daemon runs under plain Node, where the `electron` module is absent
 *  or a bare path string; either way there is no `app`. */
function electronApp(): { getPath(name: 'logs'): string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron') as { app?: { getPath(name: 'logs'): string } } | string;
    return typeof mod === 'object' && mod.app && typeof mod.app.getPath === 'function' ? mod.app : null;
  } catch {
    return null;
  }
}

/** Where the log lives: the app's log folder in the desktop app, else
 *  `POPBOT_LOG_DIR`, else `~/.popbot-host/logs` for the host daemon. */
function logDir(): string {
  const override = process.env.POPBOT_LOG_DIR?.trim();
  if (override) return override;
  const app = electronApp();
  if (app) return app.getPath('logs');
  return join(homedir(), '.popbot-host', 'logs');
}

let logPath: string | null = null;
let initFailed = false;

function ensurePath(): string | null {
  if (logPath) return logPath;
  if (initFailed) return null;
  try {
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'popbot-agent.log');
    rotateIfHuge(logPath);
    return logPath;
  } catch {
    initFailed = true;
    return null;
  }
}

/** Rotate to .1 once the live log crosses 5 MB so it doesn't grow
 *  unbounded across long-lived sessions. We keep one previous file
 *  (no fancy rotation chain — this is a debugging aid, not telemetry). */
function rotateIfHuge(path: string): void {
  try {
    const st = statSync(path);
    if (st.size > 5 * 1024 * 1024) renameSync(path, `${path}.1`);
  } catch {
    // file doesn't exist yet — fine
  }
}

export function dlog(tag: string, fields: Record<string, unknown>): void {
  const p = ensurePath();
  if (!p) return;
  const line = JSON.stringify({ t: new Date().toISOString(), tag, ...fields }) + '\n';
  try {
    appendFileSync(p, line, { encoding: 'utf8' });
  } catch {
    // best-effort — never throw from a logger
  }
}

/** Returns the absolute path of the log file (for surfacing in UI). */
export function getDiagLogPath(): string | null {
  return ensurePath();
}

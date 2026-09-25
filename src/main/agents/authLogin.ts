/**
 * Sign-in for the agent CLIs, from inside PopBot.
 *
 * Both CLIs own their credentials (Claude Code's OAuth login, Codex's
 * ChatGPT / API-key login) and PopBot never sees a token. What it can do
 * is run the CLI's own login command for the user: `claude auth login`
 * opens the browser, prints a fallback URL, and waits for a code to be
 * pasted on stdin; `codex login` opens the browser and completes on a
 * local callback. So a login here is a child process whose output lines
 * stream to the renderer's sign-in dialog and whose stdin the dialog can
 * write the pasted code to.
 *
 * Also the "are we signed in?" probes the readiness checklist uses:
 * `claude auth status` (JSON) and `codex login status`.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { WebContents } from 'electron';
import { IpcChannel, type AuthLoginEvent, type AuthProvider, type AuthState } from '@shared/ipc';
import { dlog } from '../diagLog';

const execFileP = promisify(execFile);

/** `claude auth status` → is the CLI signed in? */
export async function probeClaudeAuth(binary: string): Promise<AuthState> {
  try {
    const { stdout } = await execFileP(binary, ['auth', 'status'], {
      timeout: 8000,
      env: process.env,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout.trim()) as { loggedIn?: boolean };
    return parsed.loggedIn ? 'signed-in' : 'signed-out';
  } catch (err) {
    // A signed-out CLI may exit non-zero and say so; anything else (an
    // old CLI without the subcommand, a timeout) is simply unknown.
    const text = `${(err as { stdout?: string }).stdout ?? ''} ${(err as { stderr?: string }).stderr ?? ''}`;
    if (/not logged in|logged out|"loggedIn":\s*false/i.test(text)) return 'signed-out';
    return 'unknown';
  }
}

/** `codex login status` → is the CLI signed in? Exit 0 means yes. */
export async function probeCodexAuth(binary: string): Promise<AuthState> {
  try {
    const { stdout } = await execFileP(binary, ['login', 'status'], {
      timeout: 8000,
      env: process.env,
      windowsHide: true,
    });
    return /not logged in/i.test(stdout) ? 'signed-out' : 'signed-in';
  } catch (err) {
    const text = `${(err as { stdout?: string }).stdout ?? ''} ${(err as { stderr?: string }).stderr ?? ''}`;
    if (/not logged in|logged out/i.test(text)) return 'signed-out';
    return 'unknown';
  }
}

const running = new Map<AuthProvider, ChildProcess>();

/** Start the CLI's login. One at a time per provider; a second start
 *  while one runs just re-attaches the dialog to the running one. */
export function startLogin(provider: AuthProvider, binary: string, wc: WebContents): void {
  if (running.has(provider)) return;
  const args = provider === 'claude' ? ['auth', 'login'] : ['login'];
  // An npm shim on Windows is a .cmd; Node launches those through a shell.
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
  let child: ChildProcess;
  try {
    child = spawn(viaShell ? `"${binary}"` : binary, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: viaShell,
      windowsHide: true,
    });
  } catch (err) {
    send(wc, { provider, type: 'exit', code: -1, message: (err as Error).message });
    return;
  }
  running.set(provider, child);
  dlog('auth.login.start', { provider, binary });

  let buffer = '';
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    // Prompts end without a newline ("Paste code here if prompted > "),
    // so flush on newlines AND on a trailing prompt marker.
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const raw of parts) emitLine(wc, provider, raw);
    if (/[>:]\s*$/.test(buffer)) {
      emitLine(wc, provider, buffer);
      buffer = '';
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.stdin?.on('error', () => undefined);
  child.on('error', (err) => {
    running.delete(provider);
    dlog('auth.login.error', { provider, error: err.message });
    send(wc, { provider, type: 'exit', code: -1, message: err.message });
  });
  child.on('exit', (code, signal) => {
    running.delete(provider);
    if (buffer.trim()) emitLine(wc, provider, buffer);
    dlog('auth.login.exit', { provider, code, signal });
    send(wc, { provider, type: 'exit', code: code ?? -1, ...(signal ? { message: `stopped by ${signal}` } : {}) });
  });
}

/** Feed a line (the pasted code) to the login's stdin. */
export function sendLoginInput(provider: AuthProvider, text: string): boolean {
  const child = running.get(provider);
  if (!child?.stdin || child.stdin.destroyed) return false;
  child.stdin.write(`${text}\n`);
  return true;
}

export function cancelLogin(provider: AuthProvider): void {
  const child = running.get(provider);
  if (!child) return;
  running.delete(provider);
  child.kill();
}

export function isLoginRunning(provider: AuthProvider): boolean {
  return running.has(provider);
}

function emitLine(wc: WebContents, provider: AuthProvider, raw: string): void {
  // Strip ANSI colour / cursor sequences; the dialog shows plain text.
  const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
  if (!line.trim()) return;
  send(wc, { provider, type: 'output', line });
  const url = /https?:\/\/[^\s"'<>]+/.exec(line)?.[0];
  if (url) send(wc, { provider, type: 'url', url });
  if (/paste (?:the )?code|enter (?:the )?code/i.test(line)) send(wc, { provider, type: 'prompt-code' });
}

function send(wc: WebContents, event: AuthLoginEvent): void {
  if (wc.isDestroyed()) return;
  wc.send(IpcChannel.AuthLoginEvent, event);
}

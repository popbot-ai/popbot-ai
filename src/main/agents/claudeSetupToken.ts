/**
 * Signs a Claude account in for the user: runs `claude setup-token` — the
 * CLI's own way to make a long-lived (one-year) token — and hands PopBot
 * the token it produces, so adding an account never needs a terminal.
 *
 * The CLI only does this on a terminal (it is a full-screen app), so it
 * runs under a pseudo-terminal wide enough that the sign-in link and the
 * token are never wrapped. What it draws is read by setupTokenParser.ts;
 * the code from the sign-in page is typed into it as a person would.
 *
 * One attempt per run: a refused code ends it (the next try is a fresh
 * run with a fresh link), as does success, a failure, or the time limit.
 * The token goes to the caller in the main process only — it is never
 * logged and never sent to the window.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn, type IPty } from 'node-pty';
import { dlog } from '../diagLog';
import { SetupTokenParser } from './setupTokenParser';

export type SetupTokenEvent =
  | { type: 'url'; url: string }
  | { type: 'ready-for-code' }
  | { type: 'checking-code' }
  | { type: 'code-refused'; message: string }
  | { type: 'token'; token: string }
  /** `no-token`: the CLI signed in and printed a token, but not one the
   *  parser could read. */
  | { type: 'failed'; message: string; reason?: 'no-token' };

export interface SetupTokenRun {
  /** Type the code from the sign-in page. False when it can't take one now. */
  sendCode(code: string): boolean;
  /** Stop, saying nothing more. */
  cancel(): void;
  /** Whether the CLI opens the sign-in page in a browser by itself: when
   *  asked to, and also where it could not be told not to. */
  opensBrowser: boolean;
}

/** Long enough to sign in at leisure; short enough not to leave a CLI
 *  waiting forever behind a closed dialog. */
const TIME_LIMIT_MS = 15 * 60_000;

export function runSetupToken(
  binary: string,
  opts: { openBrowser: boolean },
  onEvent: (event: SetupTokenEvent) => void,
): SetupTokenRun {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  // A fresh sign-in, whatever this process happens to be running on.
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  let opensBrowser = opts.openBrowser;
  if (!opts.openBrowser) {
    // The CLI opens the browser itself unless BROWSER names something
    // else: a no-op leaves opening the link (or copying it to a private
    // window, to sign in as another account) to the user. Where there is
    // no such no-op (Windows) the CLI opens it all the same, and the
    // caller is told so.
    const noop = ['/usr/bin/true', '/bin/true'].find((p) => existsSync(p));
    if (noop) env.BROWSER = noop;
    else opensBrowser = true;
  }

  // An npm shim on Windows is a .cmd: run it through the shell.
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
  const file = viaShell ? (process.env.ComSpec ?? 'cmd.exe') : binary;
  const args = viaShell ? ['/d', '/s', '/c', `"${binary}" setup-token`] : ['setup-token'];

  const parser = new SetupTokenParser();
  let over = false;
  let ready = false;
  let term: IPty | null = null;
  const end = (): void => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    try { term?.kill(); } catch { /* already gone */ }
  };
  const fail = (message: string, reason?: 'no-token'): void => {
    if (over) return;
    end();
    dlog('claude.setup-token.failed', { message: message.slice(0, 200), ...(reason ? { reason } : {}) });
    onEvent({ type: 'failed', message, ...(reason ? { reason } : {}) });
  };
  const timer = setTimeout(() => fail('The sign-in was left waiting too long.'), TIME_LIMIT_MS);

  try {
    term = spawn(file, args, { name: 'xterm-256color', cols: 400, rows: 40, cwd: homedir(), env });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    // The CLI never ran, so it opened nothing.
    return { sendCode: () => false, cancel: () => undefined, opensBrowser: false };
  }
  dlog('claude.setup-token.start', { openBrowser: opts.openBrowser, opensBrowser });

  term.onData((chunk) => {
    if (over) return;
    for (const signal of parser.feed(chunk)) {
      if (over) return;
      if (signal.type === 'url') {
        onEvent(signal);
      } else if (signal.type === 'ready-for-code') {
        ready = true;
        onEvent(signal);
      } else if (signal.type === 'code-refused') {
        end();
        dlog('claude.setup-token.code-refused', {});
        onEvent(signal);
      } else {
        end();
        dlog('claude.setup-token.done', {});
        onEvent(signal);
      }
    }
  });
  term.onExit(({ exitCode }) => {
    if (over) return;
    // Signed in, but the token was not read (the CLI shows it for a moment
    // and leaves). Said in PopBot's own words: the screen is not quoted,
    // because the token is on it.
    if (parser.sawSuccess()) fail('Claude finished the sign-in, but PopBot could not read the token it printed.', 'no-token');
    else fail(parser.tail() || `The sign-in ended before it finished (exit ${exitCode}).`);
  });

  return {
    opensBrowser,
    sendCode(code) {
      const text = code.trim();
      if (over || !ready || !text || !term) return false;
      const t = term;
      t.write(text);
      // Enter on its own keystroke, as typed — the input treats a burst
      // ending in a newline as pasted text.
      setTimeout(() => { if (!over) t.write('\r'); }, 150);
      onEvent({ type: 'checking-code' });
      return true;
    },
    cancel() {
      if (over) return;
      end();
      dlog('claude.setup-token.cancelled', {});
    },
  };
}

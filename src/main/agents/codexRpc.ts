/**
 * JSON-RPC client for `codex app-server`, the protocol the Codex desktop
 * app and IDE extension speak. Newline-delimited JSON over stdio; the
 * `"jsonrpc": "2.0"` member is omitted on the wire.
 *
 * Three kinds of message cross the pipe:
 *   - requests we send, answered by `{ id, result | error }`
 *   - notifications the server pushes, `{ method, params }` with no id
 *   - requests the SERVER sends us (approvals and the like),
 *     `{ id, method, params }`, which we must answer or it waits forever
 *
 * The transport is an interface so the session logic can be tested
 * against a scripted fake instead of a real CLI.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface LineTransport {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  /** Fires once, when the pipe is gone for any reason. */
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

/** JSON-RPC `error` member, surfaced as a rejection. */
export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

/** `code` used when the pipe closed before an answer arrived. */
export const RPC_CLOSED = -1;
/** JSON-RPC "method not found" — an older CLI that lacks the call. */
export const RPC_METHOD_NOT_FOUND = -32601;

export interface CodexRpcHandlers {
  onNotification(method: string, params: unknown): void;
  onServerRequest(id: number | string, method: string, params: unknown): void;
  onClose(reason: string): void;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
}

export class CodexRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly transport: LineTransport,
    private readonly handlers: CodexRpcHandlers,
  ) {
    transport.onLine((line) => this.handleLine(line));
    transport.onClose((reason) => this.handleClose(reason));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new CodexRpcError(method, RPC_CLOSED, 'codex app-server is not running'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    if (this.closed) return;
    this.write({ id, error: { code, message } });
  }

  close(): void {
    if (this.closed) return;
    this.transport.close();
    this.handleClose('closed by PopBot');
  }

  private write(message: unknown): void {
    try {
      this.transport.send(JSON.stringify(message));
    } catch {
      // A dead pipe surfaces through onClose; nothing more to do here.
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Not protocol — a stray log line on stdout. Ignore it.
      return;
    }
    if (msg === null || typeof msg !== 'object') return;

    if (msg.method !== undefined) {
      if (msg.id !== undefined) this.handlers.onServerRequest(msg.id, msg.method, msg.params);
      else this.handlers.onNotification(msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== 'number') return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      waiter.reject(new CodexRpcError(
        waiter.method,
        typeof msg.error.code === 'number' ? msg.error.code : 0,
        msg.error.message ?? 'request failed',
        msg.error.data,
      ));
    } else {
      waiter.resolve(msg.result);
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const w of waiting) w.reject(new CodexRpcError(w.method, RPC_CLOSED, reason));
    this.handlers.onClose(reason);
  }
}

/**
 * Start `codex app-server` and expose its stdio as a LineTransport.
 *
 * stderr is where the CLI logs; the tail is kept so an unexpected exit
 * can say why (bad auth, unknown flag on an old CLI, ...).
 */
export function spawnCodexAppServer(codexPath: string, extraPathDirs: string[] = []): LineTransport {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (extraPathDirs.length > 0) {
    const sep = process.platform === 'win32' ? ';' : ':';
    env.PATH = [...extraPathDirs, env.PATH ?? ''].filter(Boolean).join(sep);
  }
  // An npm shim on Windows is a .cmd, which Node will only launch
  // through a shell. A native binary (what the probe prefers) is direct.
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexPath);
  const child = spawn(viaShell ? `"${codexPath}"` : codexPath, ['app-server'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: viaShell,
    windowsHide: true,
  });

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  // Writes to a pipe whose reader has exited raise EPIPE asynchronously;
  // without a listener that would take the whole app down.
  child.stdin?.on('error', () => undefined);

  const lineHandlers: Array<(line: string) => void> = [];
  const closeHandlers: Array<(reason: string) => void> = [];
  let closed = false;
  const fireClose = (reason: string): void => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h(reason);
  };

  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      for (const h of lineHandlers) h(line);
    });
  }
  child.on('error', (err) => fireClose(`could not start codex app-server: ${err.message}`));
  child.on('exit', (code, signal) => {
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    const detail = stderrTail.trim().split('\n').slice(-3).join(' · ');
    fireClose(detail ? `codex app-server stopped (${why}): ${detail}` : `codex app-server stopped (${why})`);
  });

  return {
    send: (line) => {
      child.stdin?.write(`${line}\n`);
    },
    onLine: (handler) => {
      lineHandlers.push(handler);
    },
    onClose: (handler) => {
      closeHandlers.push(handler);
    },
    close: () => {
      try {
        child.stdin?.end();
      } catch {
        // already gone
      }
      if (child.exitCode === null && !child.killed) child.kill();
    },
  };
}

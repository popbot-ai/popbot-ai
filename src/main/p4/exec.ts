/**
 * Perforce command execution + output parsing — the low-level core the
 * Perforce source-control provider builds on (mirrors the `git()` helper
 * in `../git/files`).
 *
 * Connection details (P4PORT / P4USER / P4CLIENT) are passed as a
 * {@link P4Context} and exported to the child's environment rather than
 * on the command line, so a per-slot client never leaks into argv and an
 * optional password is never visible in a process listing. Auth otherwise
 * relies on an existing `p4 login` ticket.
 *
 * Structured commands use `-ztag` (one `... key value` line per field,
 * records separated by blank lines); {@link parseZtag} turns that into
 * plain records.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PerforceSettings } from '@shared/persistence';
import { getSetting } from '../persistence/settings';

/** The p4 executable — the configured path (Preferences → Source control →
 *  Perforce) or `p4` resolved on PATH. */
export function p4bin(): string {
  return getSetting<PerforceSettings>('perforce')?.p4Path?.trim() || 'p4';
}

export interface P4Context {
  /** P4PORT, e.g. "ssl:host:1666". */
  port: string;
  /** P4USER. */
  user: string;
  /** P4CLIENT — the per-slot client workspace. Omit for server-only ops. */
  client?: string;
  /** Optional P4PASSWD. Prefer a login ticket; only set when no ticket is
   *  available. Passed via env, never argv. */
  password?: string;
}

export interface P4ExecOpts {
  /** Working directory (the slot mount). p4 resolves the client from env,
   *  but several commands key off cwd for path translation. */
  cwd?: string;
  /** Data piped to stdin (client spec for `client -i`, submit form, …). */
  input?: string;
  maxBuffer?: number;
  /** When true, a non-zero exit resolves (with the captured streams + code)
   *  instead of rejecting — for commands whose "failure" is a normal
   *  answer (e.g. `opened` with nothing open exits 1). */
  tolerant?: boolean;
}

export interface P4ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function envFor(ctx: P4Context): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, P4PORT: ctx.port, P4USER: ctx.user };
  if (ctx.client) env.P4CLIENT = ctx.client;
  if (ctx.password) env.P4PASSWD = ctx.password;
  // P4CHARSET must MATCH the server: a unicode server requires it, but a
  // NON-unicode server REJECTS any charset ("Unicode clients require a unicode
  // enabled server"). So we NEVER force 'utf8' — use the explicit Perforce
  // setting when configured (for unicode servers), else inherit whatever the
  // environment/P4CONFIG already provides (which `...process.env` copied).
  const charset = getSetting<PerforceSettings>('perforce')?.charset?.trim();
  if (charset && charset.toLowerCase() !== 'none') env.P4CHARSET = charset;
  return env;
}

/** Run `p4 <args>`. Rejects on non-zero exit unless `opts.tolerant`. */
export function p4exec(ctx: P4Context, args: string[], opts: P4ExecOpts = {}): Promise<P4ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      p4bin(),
      args,
      {
        cwd: opts.cwd,
        env: envFor(ctx),
        windowsHide: true,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = stdout?.toString() ?? '';
        const errStr = stderr?.toString() ?? '';
        if (err) {
          const code = typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((err as unknown as { code: number }).code)
            : 1;
          if (opts.tolerant) return resolve({ stdout: out, stderr: errStr, code });
          return reject(new Error(`p4 ${args.join(' ')} failed: ${errStr.trim() || err.message}`));
        }
        resolve({ stdout: out, stderr: errStr, code: 0 });
      },
    );
    if (opts.input != null) child.stdin?.end(opts.input);
  });
}

/** Run `p4 <args>` and return raw stdout bytes (for `p4 print` of possibly
 *  binary files). Resolves null on any error — e.g. the spec didn't exist
 *  at that revision — mirroring git's readAtRev. */
export function p4execRaw(ctx: P4Context, args: string[], opts: P4ExecOpts = {}): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      p4bin(),
      args,
      {
        cwd: opts.cwd,
        env: envFor(ctx),
        windowsHide: true,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: 'buffer',
      },
      (err, stdout) => resolve(err ? null : (stdout as Buffer)),
    );
  });
}

/**
 * Build a {@link P4Context} for a slot from its `.p4config` (written by
 * shado's `p4-init` hook at the slot mount root: `P4PORT=…`, `P4USER=…`,
 * `P4CLIENT=…`, optional `P4PASSWD=…`). Lets the provider drive p4 from a
 * worktree path alone — the way git infers everything from `.git`.
 * Returns null when no usable config is present.
 */
export function readP4Config(wt: string): P4Context | null {
  const file = join(wt, '.p4config');
  if (!existsSync(file)) return null;
  const vals: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(P4[A-Z]+)\s*=\s*(.*)\s*$/.exec(raw);
    if (m) vals[m[1]] = m[2];
  }
  if (!vals.P4PORT || !vals.P4USER) return null;
  // Deliberately NOT reading P4PASSWD: we never load a stored Perforce
  // password off disk into the connection. Auth relies on a `p4 login`
  // ticket (the p4-init hook should likewise not persist the password).
  return {
    port: vals.P4PORT,
    user: vals.P4USER,
    client: vals.P4CLIENT || undefined,
  };
}

/**
 * Write the slot's `.p4config` at the mount root so {@link readP4Config} (and
 * any p4 invoked with P4CONFIG) resolves the SAME connection + client this
 * provider created — closing the client-name coupling. Never writes
 * P4PASSWD (auth is ticket-based).
 */
export function writeP4Config(wt: string, ctx: P4Context): void {
  const lines = [`P4PORT=${ctx.port}`, `P4USER=${ctx.user}`];
  if (ctx.client) lines.push(`P4CLIENT=${ctx.client}`);
  // Make p4 honor the repo's `.p4ignore` authoritatively: `p4 add` then skips
  // ignored files even if the watcher's coarse pre-filter let one through.
  lines.push('P4IGNORE=.p4ignore');
  writeFileSync(join(wt, '.p4config'), lines.join('\n') + '\n');
}

/**
 * Parse `p4 -ztag` output into records. Each field is a `... key value`
 * line; a blank line ends a record. Multi-valued tagged fields (e.g.
 * `depotFile0`, `depotFile1`) keep their numeric suffix — callers that
 * need arrays can collect by prefix.
 */
export function parseZtag(stdout: string): Record<string, string>[] {
  const records: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') {
      if (cur) { records.push(cur); cur = null; }
      continue;
    }
    const m = /^\.\.\.\s(\S+)\s?(.*)$/.exec(line);
    if (m) {
      cur ??= {};
      cur[m[1]] = m[2] ?? '';
    }
  }
  if (cur) records.push(cur);
  return records;
}

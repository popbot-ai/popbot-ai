/**
 * Move a file from one machine to another — this computer and PopBot hosts,
 * in any direction; host to host streams through this computer.
 *
 * Built for large files:
 *  - Streamed end to end: source disk → network → destination disk, with
 *    nothing held in memory and no size limit.
 *  - Resumable: the destination keeps what arrived (`<dest>.popbot-part`),
 *    and a dropped connection — a network change, a sleeping laptop — picks
 *    up from there, up to MAX_ATTEMPTS times.
 *  - Verified: the destination checks the SHA-256 of what arrived against
 *    the source's before the file takes its name, by an atomic rename. A
 *    source that changed while it was sent fails the transfer rather than
 *    landing a mix of two versions.
 *
 * No Electron here: the endpoints are this machine's disk (fileOps.ts) and
 * a host's /v1/files API over plain HTTP.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform, type Readable } from 'node:stream';
import type { FileStat } from '@shared/hostProtocol';
import { abortPart, commitPart, readFileFrom, statFile, writePartFrom } from './fileOps';

const MAX_ATTEMPTS = 10;
/** A connection silent this long is dead (a network change kills it
 *  without telling either end). */
const STALL_MS = 60_000;

/** One side of a transfer: a machine's disk. */
export interface Endpoint {
  label: string;
  stat(path: string, opts?: { hash?: boolean }): Promise<FileStat>;
  read(path: string, offset: number): Promise<{ stream: Readable; size: number }>;
  write(path: string, offset: number, body: Readable): Promise<{ partSize: number }>;
  commit(path: string, expect: { size: number; sha256: string; overwrite: boolean }): Promise<{ path: string; size: number; sha256: string }>;
  abort(path: string): Promise<void>;
}

/** This computer. */
export function localEndpoint(label = 'this computer'): Endpoint {
  return {
    label,
    stat: (path, opts) => statFile(path, opts),
    read: (path, offset) => readFileFrom(path, offset),
    write: (path, offset, body) => writePartFrom(path, offset, body),
    commit: (path, expect) => commitPart(path, expect),
    abort: (path) => abortPart(path),
  };
}

/** A PopBot host, over its /v1/files API. */
export function hostEndpoint(host: { name: string; url: string; token: string }): Endpoint {
  const base = new URL(host.url.trim().replace(/\/+$/, '') + '/');
  const send = (method: string, path: string, query: Record<string, string>, body?: Readable | string): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      const u = new URL(`v1/files/${path}`, base);
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
        method,
        headers: {
          Authorization: `Bearer ${host.token}`,
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...(body && typeof body !== 'string' ? { 'Content-Type': 'application/octet-stream' } : {}),
        },
      });
      req.setTimeout(STALL_MS, () => req.destroy(new Error(`${host.name} went silent`)));
      req.on('response', resolve);
      req.on('error', (err) => reject(new Error(`${host.name}: ${err.message}`)));
      if (body === undefined) req.end();
      else if (typeof body === 'string') req.end(body);
      else {
        body.on('error', (err) => req.destroy(err));
        // pipe() leaves the source open when the request dies mid-upload —
        // close it, or every dropped connection leaks the file handle.
        req.on('close', () => {
          if (!body.readableEnded) body.destroy();
        });
        body.pipe(req);
      }
    });
  const readJson = async <T>(res: IncomingMessage): Promise<T> => {
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if ((res.statusCode ?? 500) >= 400) {
      const why = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : res.statusCode === 401 ? 'the token was refused' : `HTTP ${res.statusCode}`;
      throw new Error(`${host.name}: ${why}`);
    }
    return parsed as T;
  };
  return {
    label: host.name,
    stat: async (path, opts) => readJson<FileStat>(await send('GET', 'stat', { path, ...(opts?.hash ? { hash: '1' } : {}) })),
    read: async (path, offset) => {
      const res = await send('GET', 'read', { path, offset: String(offset) });
      if (res.statusCode !== 200) await readJson(res);
      res.setTimeout?.(STALL_MS, () => res.destroy(new Error(`${host.name} went silent`)));
      return { stream: res, size: Number(res.headers['x-file-size'] ?? '0') };
    },
    write: async (path, offset, body) => readJson<{ partSize: number }>(await send('PUT', 'write', { path, offset: String(offset) }, body)),
    commit: async (path, expect) => readJson(await send('POST', 'commit', {}, JSON.stringify({ path, ...expect }))),
    abort: async (path) => {
      await readJson(await send('POST', 'abort', {}, JSON.stringify({ path })));
    },
  };
}

export interface TransferProgress {
  phase: 'starting' | 'sending' | 'verifying' | 'done' | 'failed' | 'cancelled';
  size: number;
  /** Bytes at the destination so far. */
  done: number;
  attempt: number;
  /** Where it lands, absolute, once known. */
  destPath?: string;
  sha256?: string;
  error?: string;
}

/** The file's name, whatever the separator of the machine it came from. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** `dir` + name, with the separator `dir` already uses. */
function joinOn(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export async function runTransfer(
  spec: { from: Endpoint; fromPath: string; to: Endpoint; toPath: string; overwrite: boolean },
  onProgress: (p: TransferProgress) => void,
  signal?: AbortSignal,
): Promise<{ path: string; size: number; sha256: string }> {
  const { from, to } = spec;
  const progress: TransferProgress = { phase: 'starting', size: 0, done: 0, attempt: 0 };
  const report = (): void => onProgress({ ...progress });
  const cancelled = (): boolean => signal?.aborted === true;

  const src = await from.stat(spec.fromPath);
  if (!src.exists) throw new Error(`${from.label} has no ${src.path}`);
  if (!src.isFile) throw new Error(`${src.path} on ${from.label} is not a file`);
  progress.size = src.size;

  // A directory as the destination takes the file under its own name.
  let toPath = spec.toPath;
  let dst = await to.stat(toPath);
  if (dst.exists && !dst.isFile) {
    toPath = joinOn(dst.path, baseName(src.path));
    dst = await to.stat(toPath);
  }
  if (dst.exists && !spec.overwrite) throw new Error(`${dst.path} already exists on ${to.label}`);
  progress.destPath = dst.path;
  report();

  for (let attempt = 1; ; attempt += 1) {
    if (cancelled()) break;
    progress.attempt = attempt;
    let offset = (await to.stat(toPath)).partSize;
    if (offset > src.size) {
      // Left over from another file: start again.
      await to.abort(toPath);
      offset = 0;
    }
    progress.done = offset;
    if (offset === src.size) break;
    progress.phase = 'sending';
    report();
    try {
      const { stream, size } = await from.read(spec.fromPath, offset);
      if (size !== src.size) {
        stream.destroy();
        throw Object.assign(new Error(`${src.path} changed on ${from.label} while it was being sent`), { final: true });
      }
      let last = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          progress.done += chunk.length;
          const now = Date.now();
          if (now - last > 250) {
            last = now;
            report();
          }
          cb(null, chunk);
        },
      });
      const onAbort = (): void => {
        stream.destroy(new Error('cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('error', (err) => counter.destroy(err));
      try {
        await to.write(toPath, offset, stream.pipe(counter));
      } finally {
        signal?.removeEventListener('abort', onAbort);
        // A failed upload leaves the source open (pipe() never closes it).
        stream.destroy();
      }
    } catch (err) {
      if (cancelled()) break;
      if ((err as { final?: boolean }).final || attempt >= MAX_ATTEMPTS) throw err;
      progress.error = err instanceof Error ? err.message : String(err);
      report();
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** (attempt - 1))));
    }
  }
  if (cancelled()) {
    await to.abort(toPath).catch(() => undefined);
    progress.phase = 'cancelled';
    report();
    throw new Error('cancelled');
  }

  progress.phase = 'verifying';
  progress.done = src.size;
  progress.error = undefined;
  report();
  const after = await from.stat(spec.fromPath, { hash: true });
  if (after.size !== src.size || after.mtimeMs !== src.mtimeMs || !after.sha256) {
    await to.abort(toPath).catch(() => undefined);
    throw new Error(`${src.path} changed on ${from.label} while it was being sent; nothing was written — send it again`);
  }
  const landed = await to.commit(toPath, { size: src.size, sha256: after.sha256, overwrite: spec.overwrite });
  progress.phase = 'done';
  progress.sha256 = landed.sha256;
  progress.destPath = landed.path;
  report();
  return landed;
}

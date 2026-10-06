/**
 * The file side of moving a file between machines (this computer and PopBot
 * hosts): what each machine does with its own disk. The desktop calls these
 * directly for this computer; a host serves them over its API (src/host/
 * server.ts › /v1/files/*). The transfer itself is src/main/transfer/
 * transfer.ts.
 *
 * Built for large files: everything streams — nothing holds a file in
 * memory — and a transfer writes `<dest>.popbot-part`, appending from an
 * offset so a dropped connection resumes where it stopped. The part becomes
 * the file only on commit, after its size and SHA-256 match the source's,
 * by an atomic rename — nothing ever sees half a file under the real name.
 *
 * Shared by the desktop and popbot-host: no Electron here.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileStat } from '@shared/hostProtocol';

export type { FileStat };

export class FileOpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'FileOpError';
  }
}

/** An absolute path on this machine: `~` is the user's home; anything
 *  else has to be absolute already. */
export function resolveMachinePath(path: string): string {
  const p = path.trim();
  if (!p) throw new FileOpError(400, 'no path given');
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  if (!isAbsolute(p)) throw new FileOpError(400, `"${path}" is not an absolute path (or one starting with ~)`);
  return p;
}

export function partPathFor(dest: string): string {
  return `${dest}.popbot-part`;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return null;
  }
}

/** SHA-256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** What is at `path`, and how much of a transfer to it already arrived. */
export async function statFile(path: string, opts: { hash?: boolean } = {}): Promise<FileStat> {
  const abs = resolveMachinePath(path);
  const partSize = (await sizeOf(partPathFor(abs))) ?? 0;
  try {
    const st = await fs.stat(abs);
    return {
      path: abs,
      exists: true,
      isFile: st.isFile(),
      size: st.size,
      mtimeMs: st.mtimeMs,
      partSize,
      ...(opts.hash && st.isFile() ? { sha256: await sha256File(abs) } : {}),
    };
  } catch {
    return { path: abs, exists: false, isFile: false, size: 0, mtimeMs: 0, partSize };
  }
}

/** The file's bytes from `offset` on, streamed. */
export async function readFileFrom(path: string, offset: number): Promise<{ stream: Readable; size: number }> {
  const abs = resolveMachinePath(path);
  let size: number;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new FileOpError(400, `${abs} is not a file`);
    size = st.size;
  } catch (err) {
    if (err instanceof FileOpError) throw err;
    throw new FileOpError(404, `${abs} does not exist`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > size) throw new FileOpError(416, `offset ${offset} is outside the file (${size} bytes)`);
  return { stream: createReadStream(abs, { start: offset }), size };
}

/**
 * Write `body` into the transfer's part file starting at `offset`: what was
 * there past it is dropped first, so a retry overwrites a torn tail. An
 * offset past what has arrived is refused (409) with the part's size, so
 * the sender can resume from there instead.
 */
export async function writePartFrom(path: string, offset: number, body: Readable): Promise<{ partSize: number }> {
  const abs = resolveMachinePath(path);
  const part = partPathFor(abs);
  await fs.mkdir(dirname(abs), { recursive: true });
  const have = (await sizeOf(part)) ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new FileOpError(400, `bad offset ${offset}`);
  if (offset > have) throw new FileOpError(409, `only ${have} bytes have arrived; resume from there`);
  if (have === 0 && offset === 0) await fs.writeFile(part, '');
  else await fs.truncate(part, offset);
  await pipeline(body, createWriteStream(part, { flags: 'r+', start: offset }));
  return { partSize: (await sizeOf(part)) ?? 0 };
}

/**
 * The part becomes the file — if it is all there and its SHA-256 is the
 * source's. Refused when a file is already there, unless `overwrite`.
 */
export async function commitPart(path: string, expect: { size: number; sha256: string; overwrite: boolean }): Promise<{ path: string; size: number; sha256: string }> {
  const abs = resolveMachinePath(path);
  const part = partPathFor(abs);
  const size = await sizeOf(part);
  if (size === null) throw new FileOpError(404, `nothing has arrived for ${abs}`);
  if (size !== expect.size) throw new FileOpError(409, `${size} of ${expect.size} bytes have arrived`);
  const sha256 = await sha256File(part);
  if (sha256 !== expect.sha256) {
    await fs.rm(part, { force: true });
    throw new FileOpError(409, `the file arrived damaged (SHA-256 ${sha256.slice(0, 12)}…, expected ${expect.sha256.slice(0, 12)}…) and was discarded`);
  }
  if (!expect.overwrite && (await sizeOf(abs)) !== null) throw new FileOpError(409, `${abs} already exists`);
  await fs.rename(part, abs);
  return { path: abs, size, sha256 };
}

/** Throw away what has arrived for `path`. */
export async function abortPart(path: string): Promise<void> {
  await fs.rm(partPathFor(resolveMachinePath(path)), { force: true });
}

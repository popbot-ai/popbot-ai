/**
 * The desktop's side of the host protocol (shared/hostProtocol.ts):
 * requests with the host's bearer token, a reader for a chat's
 * server-sent event stream, and the few calls the app makes outside a
 * session (probe a host, list a repo's branches, end a chat's session).
 * Nothing here touches the database.
 */
import { readFile } from 'node:fs/promises';
import type { PickedAttachment } from '@shared/ipc';
import type { HostRecord } from '@shared/persistence';
import {
  HOST_PROTOCOL_VERSION,
  type HostAttachment,
  type HostFrame,
  type HostInfo,
} from '@shared/hostProtocol';
import { dlog } from '../diagLog';

/** A request the host refused (`status` is its HTTP status) or that
 *  never reached it (`status` 0). The message names the host. */
export class HostRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HostRequestError';
  }
}

export type HostAddress = Pick<HostRecord, 'url' | 'token' | 'name'>;

const REQUEST_TIMEOUT_MS = 20_000;
/** Attachments ride inline; anything past this is left out with a note. */
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

function baseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Node's fetch wraps connection failures in "fetch failed" with the
 *  real reason in `cause`; surface that reason. */
function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'timed out';
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const c = cause as { code?: unknown; message?: unknown };
      if (typeof c.code === 'string') return c.code === 'ECONNREFUSED' ? 'connection refused' : c.code;
      if (typeof c.message === 'string') return c.message;
    }
    return err.message;
  }
  return String(err);
}

export async function hostRequest<T>(
  host: HostAddress,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(host.url)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${host.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const fromBody = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : null;
      const message = res.status === 401
        ? 'the token was refused'
        : fromBody ?? `${res.status} ${res.statusText}`;
      throw new HostRequestError(res.status, `${host.name}: ${message}`);
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof HostRequestError) throw err;
    throw new HostRequestError(0, `${host.name}: ${describeFetchError(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Ask a host what it is. Rejects a host speaking another protocol. */
export async function probeHost(host: HostAddress): Promise<HostInfo> {
  const info = await hostRequest<HostInfo>(host, 'GET', '/v1/info', undefined, 8_000);
  if (!info || typeof info !== 'object' || typeof info.protocol !== 'number') {
    throw new HostRequestError(0, `${host.name}: that is not a popbot-host`);
  }
  if (info.protocol !== HOST_PROTOCOL_VERSION) {
    throw new HostRequestError(
      0,
      `${host.name}: speaks host protocol ${info.protocol}; this PopBot speaks ${HOST_PROTOCOL_VERSION} — update one of them`,
    );
  }
  return info;
}

export async function hostBranches(host: HostAddress, repoId: string): Promise<string[]> {
  const res = await hostRequest<{ branches: string[] }>(host, 'GET', `/v1/repos/${encodeURIComponent(repoId)}/branches`);
  return Array.isArray(res?.branches) ? res.branches : [];
}

/** End a chat's session on its host. A host that has no session for
 *  the chat is fine — that is the state wanted. */
export async function endHostSession(host: HostAddress, chatId: string): Promise<void> {
  try {
    await hostRequest(host, 'POST', `/v1/chats/${encodeURIComponent(chatId)}/dispose`, {});
  } catch (err) {
    if (err instanceof HostRequestError && err.status === 404) return;
    throw err;
  }
}

/**
 * Read a chat's event stream until it ends or `signal` aborts. Resolves
 * when the host closes it (the host process going away), rejects when
 * the connection fails; the caller decides whether to come back with
 * the last seq it saw.
 */
export async function readHostEvents(
  host: HostAddress,
  chatId: string,
  after: number,
  signal: AbortSignal,
  onFrame: (frame: HostFrame) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(host.url)}/v1/chats/${encodeURIComponent(chatId)}/events?after=${after}`, {
      headers: { Authorization: `Bearer ${host.token}`, Accept: 'text/event-stream' },
      signal,
    });
  } catch (err) {
    throw new HostRequestError(0, `${host.name}: ${describeFetchError(err)}`);
  }
  if (!res.ok || !res.body) {
    throw new HostRequestError(res.status, `${host.name}: events ${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (signal.aborted) return;
      throw new HostRequestError(0, `${host.name}: ${describeFetchError(err)}`);
    }
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');
      // Comment lines (`: ping`) carry no data.
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      let frame: HostFrame;
      try {
        frame = JSON.parse(data) as HostFrame;
      } catch {
        dlog('host.frame.bad', { chatId, host: host.name, len: data.length });
        continue;
      }
      onFrame(frame);
    }
  }
}

/** Attachments go to the host as bytes; it writes them to files there. */
export async function encodeAttachments(attachments: PickedAttachment[] | undefined): Promise<HostAttachment[]> {
  if (!attachments || attachments.length === 0) return [];
  const out: HostAttachment[] = [];
  for (const att of attachments) {
    try {
      const bytes = await readFile(att.path);
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        dlog('host.attachment.too-large', { name: att.name, bytes: bytes.length });
        continue;
      }
      out.push({ name: att.name, isImage: att.isImage, dataBase64: bytes.toString('base64') });
    } catch (err) {
      dlog('host.attachment.unreadable', { name: att.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

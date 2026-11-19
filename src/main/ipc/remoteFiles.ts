/**
 * File links in a host chat name files on the host, not here: clicking
 * one downloads it — into Downloads, under its own name (numbered if that
 * is taken) — and shows it in Finder / Explorer. Same path forms as the
 * local handlers (files.ts): relative to the chat's folder on the host,
 * absolute, `file://`, with `:line` or `#L42` anchors dropped. Streamed,
 * resumable and checked end to end (transfer/transfer.ts).
 */
import { app, shell } from 'electron';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ChatRecord } from '@shared/persistence';
import { getHost } from '../persistence/hosts';
import { hostEndpoint, localEndpoint, runTransfer } from '../transfer/transfer';
import { dlog } from '../diagLog';

/** The path on the host a link names, or an error. */
export function hostPathFor(rawRef: string, hostCwd: string | null): { path: string } | { error: string } {
  let p = rawRef.trim();
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURI(p.replace(/^file:\/\/(localhost)?/i, '')); } catch { return { error: `Bad file URL: ${rawRef}` }; }
    // file:///C:/x → C:/x
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  }
  const hash = /^(.*)#L\d+(?:-L?\d+)?$/.exec(p);
  if (hash) p = hash[1];
  const line = /^(.+?):(\d+)(?::\d+)?$/.exec(p);
  if (line) p = line[1];
  const absolute = p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (absolute) return { path: p };
  if (!hostCwd) return { error: 'The chat has not started on its host yet, so a relative path has nothing to resolve against.' };
  const windows = hostCwd.includes('\\') && !hostCwd.includes('/');
  const sep = windows ? '\\' : '/';
  const rel = (windows ? p.replace(/\//g, '\\') : p).replace(/^\.[\\/]/, '');
  return { path: hostCwd.endsWith(sep) ? `${hostCwd}${rel}` : `${hostCwd}${sep}${rel}` };
}

/** Downloads/<name>, or <name> (1), (2)… when that is taken. */
function downloadsPathFor(name: string): string {
  const dir = app.getPath('downloads');
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = join(dir, name);
  for (let n = 1; existsSync(candidate) || existsSync(`${candidate}.popbot-part`); n += 1) {
    candidate = join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

export async function downloadFromHost(
  chat: ChatRecord,
  rawRef: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!chat.host) return { ok: false, error: 'not a host chat' };
  const host = getHost(chat.host.hostId);
  if (!host) return { ok: false, error: `The host "${chat.host.hostName}" is no longer configured.` };
  const resolved = hostPathFor(rawRef, chat.host.cwd);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const name = resolved.path.split(/[\\/]/).filter(Boolean).pop() ?? 'download';
  const from = hostEndpoint(host);
  try {
    const stat = await from.stat(resolved.path);
    if (!stat.exists) return { ok: false, error: `${host.name} has no ${resolved.path}` };
    if (!stat.isFile) return { ok: false, error: `${resolved.path} is a folder on ${host.name} — only files can be downloaded.` };
    const dest = downloadsPathFor(name);
    const done = await runTransfer(
      { from, fromPath: resolved.path, to: localEndpoint(), toPath: dest, overwrite: false },
      () => undefined,
    );
    dlog('files.download-from-host', { chatId: chat.id, host: host.name, from: resolved.path, to: done.path, size: done.size });
    shell.showItemInFolder(done.path);
    return { ok: true, path: done.path };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    dlog('files.download-from-host.failed', { chatId: chat.id, host: host.name, from: resolved.path, error });
    return { ok: false, error };
  }
}

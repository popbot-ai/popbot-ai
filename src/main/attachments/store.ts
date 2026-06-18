import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PickedAttachment } from '@shared/ipc';
import { type AttachmentsSettings, clampAttachmentTtlDays } from '@shared/persistence';
import { getSetting } from '../persistence/settings';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Live retention window in ms, read from Preferences on each call so the
 *  startup prune + new stores always honor the user's current setting. */
function attachmentTtlMs(): number {
  const ttlDays = clampAttachmentTtlDays(getSetting<AttachmentsSettings>('attachments')?.ttlDays);
  return ttlDays * DAY_MS;
}

function attachmentRoot(): string {
  return join(app.getPath('userData'), 'attachments');
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^\w .()[\]-]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || 'attachment';
}

function attachmentId(): string {
  return 'att_' + randomUUID().replace(/-/g, '').slice(0, 12);
}

export async function persistChatAttachments(
  chatId: string,
  attachments?: PickedAttachment[],
): Promise<PickedAttachment[]> {
  if (!attachments || attachments.length === 0) return [];
  const now = Date.now();
  const ttlMs = attachmentTtlMs();
  const dir = join(attachmentRoot(), chatId);
  await mkdir(dir, { recursive: true });

  const stored: PickedAttachment[] = [];
  for (const att of attachments) {
    const id = att.id || attachmentId();
    const name = safeName(att.name || basename(att.path));
    const dest = join(dir, `${id}-${name}`);
    await copyFile(att.path, dest);
    let sizeBytes = att.sizeBytes;
    try { sizeBytes = statSync(dest).size; } catch { /* best-effort */ }
    stored.push({
      ...att,
      id,
      name,
      path: dest,
      originalPath: att.originalPath ?? att.path,
      sizeBytes,
      storedAt: now,
      expiresAt: now + ttlMs,
    });
  }
  return stored;
}

export async function pruneExpiredChatAttachments(now = Date.now()): Promise<void> {
  const root = attachmentRoot();
  if (!existsSync(root)) return;
  await pruneDir(root, now, attachmentTtlMs());
}

async function pruneDir(dir: string, now: number, ttlMs: number): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }

  let empty = true;
  for (const entry of entries) {
    const path = join(dir, entry);
    let st;
    try {
      st = await stat(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const childEmpty = await pruneDir(path, now, ttlMs);
      if (childEmpty) {
        await rm(path, { recursive: true, force: true });
      } else {
        empty = false;
      }
      continue;
    }
    if (now - st.mtimeMs > ttlMs) {
      await rm(path, { force: true });
    } else {
      empty = false;
    }
  }
  return empty;
}

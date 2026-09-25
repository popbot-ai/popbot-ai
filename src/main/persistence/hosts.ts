/**
 * The `hosts` table: other boxes running `popbot-host` that chats can
 * run on (Preferences ▸ Hosts). See HostRecord in shared/persistence.
 */
import { randomUUID } from 'node:crypto';
import type { HostRecord } from '@shared/persistence';
import type { SaveHostInput } from '@shared/ipc';
import { db } from './db';

interface HostRow {
  id: string;
  name: string;
  url: string;
  token: string;
  created_at: number;
}

function rowToRecord(r: HostRow): HostRecord {
  return { id: r.id, name: r.name, url: r.url, token: r.token, createdAt: r.created_at };
}

export function listHosts(): HostRecord[] {
  return db()
    .prepare<[], HostRow>('SELECT id, name, url, token, created_at FROM hosts ORDER BY created_at ASC')
    .all()
    .map(rowToRecord);
}

export function getHost(id: string): HostRecord | null {
  const row = db()
    .prepare<[string], HostRow>('SELECT id, name, url, token, created_at FROM hosts WHERE id = ?')
    .get(id);
  return row ? rowToRecord(row) : null;
}

/** Add (no id) or update a host. The URL keeps no trailing slash. */
export function saveHost(input: SaveHostInput): HostRecord {
  const now = Date.now();
  const name = input.name.trim() || 'host';
  const url = input.url.trim().replace(/\/+$/, '');
  const token = input.token.trim();
  if (input.id) {
    db()
      .prepare('UPDATE hosts SET name = ?, url = ?, token = ?, updated_at = ? WHERE id = ?')
      .run(name, url, token, now, input.id);
    const updated = getHost(input.id);
    if (updated) return updated;
  }
  const id = input.id ?? 'host_' + randomUUID().replaceAll('-', '').slice(0, 12);
  db()
    .prepare('INSERT INTO hosts (id, name, url, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, url, token, now, now);
  const created = getHost(id);
  if (!created) throw new Error('saveHost: row missing immediately after insert');
  return created;
}

/** Remove a host. Chats made on it keep their host info (the chip still
 *  names it) but can no longer reach it. */
export function removeHost(id: string): void {
  db().prepare('DELETE FROM hosts WHERE id = ?').run(id);
}

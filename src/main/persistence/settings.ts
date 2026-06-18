import { db } from './db';

interface SettingRow {
  key: string;
  value: string;
}

export function getSetting<T = unknown>(key: string): T | null {
  const row = db().prepare<[string], SettingRow>('SELECT key, value FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: unknown): void {
  const json = JSON.stringify(value);
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, json, Date.now());
}

export function getAllSettings(): Record<string, unknown> {
  const rows = db().prepare<[], SettingRow>('SELECT key, value FROM settings').all();
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      // skip corrupt row
    }
  }
  return out;
}

export function deleteSetting(key: string): void {
  db().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

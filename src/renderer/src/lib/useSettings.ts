import { useCallback, useEffect, useState } from 'react';

/**
 * Loads all app settings on mount and exposes get/set helpers that keep
 * the local cache in sync with the SQLite-backed store in main.
 *
 * Values are JSON-encoded server-side, so any JSON-serializable type is
 * fine. For sensitive values (API keys), this still lives in user-land
 * SQLite — fine for our v1 single-user case but reconsider if PopBot
 * ever ships multi-user.
 */
export function useSettings() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void window.popbot.settings.getAll().then((all) => {
      setSettings(all);
      setLoading(false);
    });
  }, []);

  const get = useCallback(
    <T = unknown>(key: string, fallback?: T): T | undefined =>
      (settings[key] as T | undefined) ?? fallback,
    [settings],
  );

  const set = useCallback(async (key: string, value: unknown) => {
    await window.popbot.settings.set(key, value);
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const remove = useCallback(async (key: string) => {
    await window.popbot.settings.delete(key);
    setSettings((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  return { settings, loading, get, set, remove };
}

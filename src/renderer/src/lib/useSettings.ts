import { useCallback, useSyncExternalStore } from 'react';

type SettingsMap = Record<string, unknown>;

interface SettingsSnapshot {
  settings: SettingsMap;
  loading: boolean;
}

/**
 * Module-level store shared by every useSettings() caller.
 *
 * This used to be per-component state, which meant each mount started
 * from `{}` with `loading=true` and re-fetched. Panels that seed local
 * form state with `useState(get('foo') ?? default)` therefore captured
 * the DEFAULT on their first render — so a field showed (and on Save
 * persisted) the default instead of the user's stored value. Sharing one
 * snapshot means the fetch happens once, early, and by the time a panel
 * mounts `loading` is already false and `get()` returns real values.
 *
 * It also keeps siblings in sync: a `set()` anywhere publishes to every
 * consumer, so one panel can no longer merge onto a stale blob and
 * clobber another panel's just-saved keys.
 */
let snapshot: SettingsSnapshot = { settings: {}, loading: true };
const listeners = new Set<() => void>();
let fetchStarted = false;

function publish(next: SettingsSnapshot): void {
  snapshot = next;
  for (const notify of listeners) notify();
}

function loadOnce(): void {
  if (fetchStarted) return;
  fetchStarted = true;
  void window.popbot.settings
    .getAll()
    .then((all: SettingsMap) => publish({ settings: all ?? {}, loading: false }))
    // Leave whatever we have and stop blocking the UI — a failed read
    // shouldn't leave every panel stuck on its loading placeholder.
    .catch(() => publish({ settings: snapshot.settings, loading: false }));
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  loadOnce();
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): SettingsSnapshot {
  return snapshot;
}

/**
 * Reads the app settings store and exposes get/set helpers backed by the
 * SQLite store in main.
 *
 * Values are JSON-encoded server-side, so any JSON-serializable type is
 * fine. For sensitive values (API keys), this still lives in user-land
 * SQLite — fine for our v1 single-user case but reconsider if PopBot
 * ever ships multi-user.
 */
export function useSettings() {
  const { settings, loading } = useSyncExternalStore(subscribe, getSnapshot);

  const get = useCallback(
    <T = unknown>(key: string, fallback?: T): T | undefined =>
      (settings[key] as T | undefined) ?? fallback,
    [settings],
  );

  const set = useCallback(async (key: string, value: unknown) => {
    await window.popbot.settings.set(key, value);
    // Merge onto the live snapshot rather than the one captured at render
    // time, so concurrent writes to different keys don't drop each other.
    publish({ settings: { ...snapshot.settings, [key]: value }, loading: snapshot.loading });
  }, []);

  const remove = useCallback(async (key: string) => {
    await window.popbot.settings.delete(key);
    const { [key]: _dropped, ...rest } = snapshot.settings;
    publish({ settings: rest, loading: snapshot.loading });
  }, []);

  return { settings, loading, get, set, remove };
}

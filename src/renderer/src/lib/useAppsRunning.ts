import { useEffect, useState } from 'react';

/**
 * Shared singleton poller — one IPC call every 2s for the entire app
 * regardless of how many slot rows are mounted. Each `useAppsRunning`
 * subscriber bumps a ref-count; the interval only runs while at least
 * one consumer is mounted.
 *
 * Returns the set of slot basenames (e.g. `slot-3`) currently running
 * each external app. The main process derives terminal state from
 * shell cwds and unity from process args; editor + git are not yet
 * detectable (always empty).
 */
export interface AppsRunning {
  terminal: ReadonlySet<string>;
  editor: ReadonlySet<string>;
  git: ReadonlySet<string>;
  unity: ReadonlySet<string>;
  unreal: ReadonlySet<string>;
  custom: ReadonlySet<string>;
}

const EMPTY: AppsRunning = {
  terminal: new Set(),
  editor: new Set(),
  git: new Set(),
  unity: new Set(),
  unreal: new Set(),
  custom: new Set(),
};

let cache: AppsRunning = EMPTY;
const subs = new Set<(s: AppsRunning) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  try {
    const res = await window.popbot.apps.running();
    cache = {
      terminal: new Set(res.terminal),
      editor: new Set(res.editor),
      git: new Set(res.git),
      unity: new Set(res.unity),
      unreal: new Set(res.unreal),
      custom: new Set(res.custom),
    };
    for (const s of subs) s(cache);
  } catch {
    /* swallow — next tick will retry */
  }
}

function start(): void {
  if (timer) return;
  void tick();
  timer = setInterval(tick, 2000);
}

function stop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function useAppsRunning(): AppsRunning {
  const [snapshot, setSnapshot] = useState<AppsRunning>(cache);
  useEffect(() => {
    subs.add(setSnapshot);
    if (subs.size === 1) start();
    return () => {
      subs.delete(setSnapshot);
      if (subs.size === 0) stop();
    };
  }, []);
  return snapshot;
}

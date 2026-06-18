import { useEffect, useState } from 'react';
import type { UpdateInfo } from '@shared/updates';

/**
 * Subscribe to the main-process update poller. State holds the most
 * recent update push, or null if nothing's been announced yet (or the
 * user explicitly dismissed the current one).
 *
 * The 3-hour quiet window lives in the main process — once a version
 * is pushed and dismissed here, the next push won't arrive for either
 * 3h or whenever a newer release lands, whichever comes first.
 */
export function useUpdates(): {
  available: UpdateInfo | null;
  dismiss(): void;
} {
  const [available, setAvailable] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    return window.popbot.updates.onAvailable((info) => {
      setAvailable(info);
    });
  }, []);

  return {
    available,
    dismiss: () => setAvailable(null),
  };
}

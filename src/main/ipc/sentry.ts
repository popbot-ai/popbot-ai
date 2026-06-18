import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { SentryTestResult } from '@shared/sentry';
import { fetchOrg, SentryAuthError } from '../sentry/client';

export function registerSentryHandlers(): void {
  ipcMain.handle(
    IpcChannel.SentryTest,
    async (_e, input: { token: string; orgSlug: string }): Promise<SentryTestResult> => {
      const token = input.token?.trim();
      const orgSlug = input.orgSlug?.trim();
      if (!token || !orgSlug) return { ok: false, reason: 'no-org' };
      try {
        const org = await fetchOrg({ token, orgSlug });
        return { ok: true, orgSlug: org.slug, org: org.name };
      } catch (err) {
        if (err instanceof SentryAuthError) return { ok: false, reason: 'auth' };
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: 'other', error: message };
      }
    },
  );
}

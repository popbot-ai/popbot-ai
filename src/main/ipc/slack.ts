import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import type { SlackTestResult } from '@shared/slack';
import { authTest, SlackAuthError } from '../slack/client';

export function registerSlackHandlers(): void {
  ipcMain.handle(
    IpcChannel.SlackTest,
    async (_e, token: string): Promise<SlackTestResult> => {
      const t = token?.trim();
      if (!t) return { ok: false, reason: 'auth', error: 'token missing' };
      try {
        const a = await authTest(t);
        return { ok: true, team: a.team, user: a.user, userId: a.user_id };
      } catch (err) {
        if (err instanceof SlackAuthError) return { ok: false, reason: 'auth', error: err.message };
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: 'other', error: message };
      }
    },
  );
}

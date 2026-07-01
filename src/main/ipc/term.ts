/** IPC layer for the in-app terminal. Defers to ptyManager — handlers
 *  here only validate args and proxy. */
import { ipcMain } from 'electron';
import { IpcChannel } from '@shared/ipc';
import * as pty from '../term/ptyManager';
import { getChat } from '../persistence/chats';
import { applyPerforceAgentCwd } from '../git/chatPaths';

export function registerTermHandlers(): void {
  ipcMain.handle(
    IpcChannel.TermOpen,
    async (_e, chatId: string, cwd: string, cols?: number, rows?: number) => {
      if (!chatId || !cwd) return { ok: false, error: 'missing chatId/cwd' };
      // Match the agent's cwd for Perforce repos (a configured subdir of the
      // mount root) so the terminal opens where the agent runs.
      const resolved = applyPerforceAgentCwd(cwd, getChat(chatId)) ?? cwd;
      return pty.open(chatId, resolved, cols, rows);
    },
  );
  ipcMain.handle(IpcChannel.TermWrite, (_e, chatId: string, data: string) => {
    pty.write(chatId, data);
  });
  ipcMain.handle(IpcChannel.TermResize, (_e, chatId: string, cols: number, rows: number) => {
    pty.resize(chatId, cols, rows);
  });
}

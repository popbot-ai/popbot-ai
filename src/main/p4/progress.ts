/**
 * Broadcast Perforce file-open progress to the renderer. Opening a huge
 * changed-file set (a game export's thousands of files) takes real time even
 * parallelized, so the panel shows live progress. Empty string clears it.
 *
 * A broadcast (not a threaded callback) keeps it out of the provider's hot
 * path — `openChanges` deep in a status load just calls this; no IPC handler
 * plumbing to thread through.
 */
import { webContents } from 'electron';
import { IpcChannel } from '@shared/ipc';

export function emitP4Progress(message: string): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send(IpcChannel.P4OpenProgress, message);
  }
}

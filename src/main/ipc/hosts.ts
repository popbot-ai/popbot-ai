/**
 * Hosts (Preferences ▸ Hosts): the records, a probe for the panel and
 * the new-chat dialog, a host repo's branches, and the one action that
 * ends a chat's session on its host.
 */
import { ipcMain } from 'electron';
import { IpcChannel, type HostProbeResult, type SaveHostInput } from '@shared/ipc';
import { AgentHost } from '../agents/AgentHost';
import { endHostSession, hostBranches, probeHost } from '../agents/hostClient';
import { getChat } from '../persistence/chats';
import { getHost, listHosts, removeHost, saveHost } from '../persistence/hosts';
import { appendMessage } from '../persistence/messages';
import { dlog } from '../diagLog';

export function registerHostsHandlers(): void {
  ipcMain.handle(IpcChannel.HostsList, () => listHosts());

  ipcMain.handle(IpcChannel.HostsSave, (_e, input: SaveHostInput) => {
    if (!input || typeof input !== 'object') throw new Error('hosts.save: bad input');
    return saveHost({
      ...(typeof input.id === 'string' ? { id: input.id } : {}),
      name: typeof input.name === 'string' ? input.name : '',
      url: typeof input.url === 'string' ? input.url : '',
      token: typeof input.token === 'string' ? input.token : '',
    });
  });

  ipcMain.handle(IpcChannel.HostsRemove, (_e, id: string) => {
    if (typeof id === 'string') removeHost(id);
  });

  ipcMain.handle(IpcChannel.HostsProbe, async (_e, url: string, token: string): Promise<HostProbeResult> => {
    const address = { url: typeof url === 'string' ? url : '', token: typeof token === 'string' ? token : '', name: 'host' };
    if (!address.url.trim()) return { ok: false, error: 'no URL' };
    try {
      const info = await probeHost(address);
      dlog('hosts.probe.ok', { url: address.url, name: info.name, version: info.version, repos: info.repos.length });
      return { ok: true, info };
    } catch (err) {
      const error = err instanceof Error ? err.message.replace(/^host: /, '') : String(err);
      dlog('hosts.probe.failed', { url: address.url, error });
      return { ok: false, error };
    }
  });

  ipcMain.handle(IpcChannel.HostsBranches, async (_e, hostId: string, repoId: string) => {
    const host = typeof hostId === 'string' ? getHost(hostId) : null;
    if (!host) return { ok: false as const, error: 'that host is no longer configured' };
    try {
      return { ok: true as const, branches: await hostBranches(host, typeof repoId === 'string' ? repoId : '') };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // "Shut down on host" — the one thing that ends a session there.
  // Closing the chat or quitting PopBot only detaches.
  ipcMain.handle(IpcChannel.HostsShutdown, async (_e, chatId: string) => {
    const chat = typeof chatId === 'string' ? getChat(chatId) : null;
    if (!chat?.host) return;
    const host = getHost(chat.host.hostId);
    if (!host) throw new Error(`the host "${chat.host.hostName}" is no longer configured`);
    await AgentHost.dispose(chatId);
    await endHostSession(host, chatId);
    dlog('hosts.shutdown', { chatId, host: host.name });
    const note = appendMessage({
      chatId,
      role: 'system',
      kind: 'system',
      body: { text: `host: The session on ${host.name} was shut down. Your next message starts a new one there, resuming this conversation.` },
    });
    AgentHost.emit({ type: 'message-added', chatId, message: note, ts: Date.now() });
  });
}

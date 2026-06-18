import { ipcMain } from 'electron';
import {
  IpcChannel,
  type ApprovePermissionInput,
  type ConfigureAgentInput,
  type SendMessageInput,
} from '@shared/ipc';
import { AgentHost } from '../agents/AgentHost';

export function registerAgentHandlers(): void {
  ipcMain.handle(IpcChannel.AgentSend, async (_e, input: SendMessageInput) => {
    await AgentHost.send(input.chatId, input.text, input.attachments);
  });

  ipcMain.handle(IpcChannel.AgentStop, (_e, chatId: string) => {
    AgentHost.stop(chatId);
  });

  ipcMain.handle(IpcChannel.AgentConfigure, async (_e, input: ConfigureAgentInput) => {
    return AgentHost.configureAgent(input);
  });

  ipcMain.handle(IpcChannel.AgentApprove, (_e, input: ApprovePermissionInput) => {
    AgentHost.approve(input.chatId, input.permissionId, input.decision);
  });

  ipcMain.handle(IpcChannel.AgentRecover, async (_e, chatId: string) => {
    await AgentHost.recoverChat(chatId);
  });

  ipcMain.handle(IpcChannel.AgentListSessions, async (_e, chatId: string) => {
    return AgentHost.listSessionsForChat(chatId);
  });

  ipcMain.handle(IpcChannel.AgentSetSession, async (_e, chatId: string, sessionId: string) => {
    await AgentHost.setChatSession(chatId, sessionId);
  });

  ipcMain.handle(IpcChannel.AgentValidateSession, (_e, chatId: string) => {
    return AgentHost.validateChatSession(chatId);
  });

  ipcMain.handle(IpcChannel.AgentRestartWithContext, async (_e, chatId: string) => {
    await AgentHost.restartWithContext(chatId);
  });
}

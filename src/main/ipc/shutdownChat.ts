/**
 * Shut a chat's agent down — running, or paused waiting on its user —
 * wherever it runs. The sidebar's RUNNING / PAUSED / LIVE chips offer it
 * for open and closed chats alike.
 *
 *   host    its session there ends and its slot is given back (hosts.ts)
 *   cloud   its cloud session ends (cloudSessions.ts)
 *   here    its turn stops and its agent process ends
 *
 * The chat and its transcript stay; its next message starts a new session
 * that resumes the conversation. A bot's chat is the bot's: pause or kill
 * the bot instead.
 */
import { appendMessage } from '../persistence/messages';
import { getChat, updateChatStatus } from '../persistence/chats';
import { AgentHost } from '../agents/AgentHost';
import { endCloudSession } from '../agents/cloudSessions';
import { dlog } from '../diagLog';
import { shutdownHostChat } from './hosts';
import { autoContinueModes, setAutoContinue } from '../agents/autoContinue';

export async function shutdownChat(chatId: string): Promise<void> {
  const chat = getChat(chatId);
  if (!chat) return;
  if (chat.host?.botId) throw new Error(`${chat.name} is a bot's chat — pause or kill the bot in the Bots tab`);
  if (chat.host) {
    await shutdownHostChat(chatId);
  } else if (chat.cloud?.sessionId && !chat.cloud.ended) {
    await AgentHost.dispose(chatId);
    await endCloudSession(chatId, (event) => AgentHost.emit(event));
  } else {
    AgentHost.stop(chatId);
    await AgentHost.dispose(chatId);
    const note = appendMessage({
      chatId,
      role: 'system',
      kind: 'system',
      body: { text: 'switch: The agent was shut down. Your next message starts a new session, resuming this conversation.' },
    });
    AgentHost.emit({ type: 'message-added', chatId, message: note, ts: Date.now() });
  }
  // Shut down means stay down: auto-continue would start it again.
  if (autoContinueModes()[chatId]) setAutoContinue(chatId, null);
  // Whatever it was doing, it is not doing it now.
  updateChatStatus(chatId, 'idle');
  AgentHost.emit({ type: 'session-status', chatId, status: 'idle', ts: Date.now() });
  AgentHost.emit({ type: 'chats-changed', chatId, reason: 'liveness', ts: Date.now() });
  dlog('agent.shutdown', { chatId, where: chat.host ? 'host' : chat.cloud ? 'cloud' : 'here' });
}

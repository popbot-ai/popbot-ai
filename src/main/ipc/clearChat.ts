/**
 * Clear a chat: its whole history goes — the messages in the chat log and
 * in the database, and the agent's conversation behind them — and its
 * next message starts a new conversation from nothing. The chat itself
 * stays as it was: name, workspace, agent and model, settings, rules,
 * who it manages.
 *
 * The agent is stopped wherever it runs first, so nothing of the old
 * conversation survives in a live process: here its process ends; on a
 * host its session there ends (its slot is kept — unlike Shut down); in
 * the cloud its session ends. A host that can't be reached fails the
 * clear rather than leave the old conversation running there to be
 * reattached. A bot's chat is the bot's.
 */
import { clearChatHistory, getChat } from '../persistence/chats';
import { getHost } from '../persistence/hosts';
import { AgentHost } from '../agents/AgentHost';
import { endHostSession } from '../agents/hostClient';
import { endCloudSession } from '../agents/cloudSessions';
import { autoContinueModes, setAutoContinue } from '../agents/autoContinue';
import { forgetChatLiveness } from './closedLiveness';
import { dlog } from '../diagLog';

export async function clearChat(chatId: string): Promise<void> {
  const chat = getChat(chatId);
  if (!chat) return;
  if (chat.host?.botId) throw new Error(`${chat.name} is a bot's chat — its history is the bot's`);
  AgentHost.stop(chatId);
  await AgentHost.dispose(chatId);
  if (chat.host) {
    const host = getHost(chat.host.hostId);
    if (!host) throw new Error(`the host "${chat.host.hostName}" is no longer configured`);
    await endHostSession(host, chatId);
    forgetChatLiveness(chatId);
  } else if (chat.cloud?.sessionId && !chat.cloud.ended) {
    await endCloudSession(chatId, (event) => AgentHost.emit(event));
  }
  // Nothing left to continue: it would only wake the new, empty agent.
  if (autoContinueModes()[chatId]) setAutoContinue(chatId, null);
  AgentHost.forgetConversation(chatId);
  clearChatHistory(chatId);
  const now = Date.now();
  AgentHost.emit({ type: 'messages-cleared', chatId, ts: now });
  AgentHost.emit({ type: 'session-status', chatId, status: 'idle', ts: now });
  const fresh = getChat(chatId);
  if (fresh) AgentHost.emit({ type: 'chat-updated', chatId, chat: fresh, ts: now });
  dlog('agent.clear', { chatId, where: chat.host ? 'host' : chat.cloud ? 'cloud' : 'here' });
}

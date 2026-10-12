/**
 * Closed chats whose agent is still up somewhere else, for the chat list
 * (PanelB shows them bright, with a RUNNING / LIVE chip and "Shut down").
 *
 * Closing a host chat only detaches this app: its session goes on on the
 * host — finishing its turn, then idling — until it is shut down. A cloud
 * session likewise lives until it is shut down. This app stops following
 * a chat it closed, so the hosts' own word (HostInfo.chats, read every
 * 30 seconds by ipc/bots.ts) is what says which are still up.
 */
import type { HostInfo } from '@shared/hostProtocol';
import type { ChatRecord } from '@shared/persistence';
import { AgentHost } from '../agents/AgentHost';
import { listClosedChats } from '../persistence/chats';

type Liveness = NonNullable<ChatRecord['liveElsewhere']>['state'];

/** Host id → closed chat id → its state there, as of the last look. */
const byHost = new Map<string, Map<string, Liveness>>();

function changed(): void {
  AgentHost.emit({ type: 'chats-changed', chatId: '', reason: 'liveness', ts: Date.now() });
}

/** What a host said of its chats just now; null when it could not be
 *  reached (nothing known, so nothing shown). */
export function noteHostChats(hostId: string, chats: HostInfo['chats'] | null): void {
  const next = new Map<string, Liveness>();
  if (chats) {
    const running = new Map(chats.filter((c) => c.alive).map((c) => [c.chatId, c.busy === true]));
    for (const chat of listClosedChats(10_000)) {
      if (chat.host?.hostId !== hostId || chat.host.botId) continue;
      const busy = running.get(chat.id);
      if (busy !== undefined) next.set(chat.id, busy ? 'running' : 'live');
    }
  }
  const prev = byHost.get(hostId) ?? new Map<string, Liveness>();
  byHost.set(hostId, next);
  if (prev.size !== next.size || [...next].some(([id, s]) => prev.get(id) !== s)) changed();
}

/** A host chat was just closed with its session running there — it goes
 *  on after the close (closing only detaches), so say so now rather than
 *  at the next look. */
export function noteClosedOnHost(hostId: string, chatId: string, state: Liveness): void {
  const chats = byHost.get(hostId) ?? new Map<string, Liveness>();
  byHost.set(hostId, chats);
  if (chats.get(chatId) === state) return;
  chats.set(chatId, state);
  changed();
}

/** A host that is gone from Preferences ▸ Hosts. */
export function forgetHost(hostId: string): void {
  if (byHost.delete(hostId)) changed();
}

/** Its session there was just shut down. */
export function forgetChatLiveness(chatId: string): void {
  let any = false;
  for (const chats of byHost.values()) any = chats.delete(chatId) || any;
  if (any) changed();
}

/** The closed list, with each chat's agent elsewhere marked. */
export function withLiveness(chats: ChatRecord[]): ChatRecord[] {
  return chats.map((chat) => {
    const onHost = chat.host ? byHost.get(chat.host.hostId)?.get(chat.id) : undefined;
    if (onHost) return { ...chat, liveElsewhere: { state: onHost, where: 'host' as const } };
    if (chat.cloud?.sessionId && !chat.cloud.ended) return { ...chat, liveElsewhere: { state: 'live' as const, where: 'cloud' as const } };
    return chat;
  });
}

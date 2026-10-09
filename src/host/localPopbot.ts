/**
 * The host's own popbot tools, for its chats while no desktop is
 * connected. A chat's popbot calls normally go up its event stream to the
 * desktop (mcpRelay.ts), which knows every chat everywhere. With no
 * desktop reading the stream they come here instead, so the chats on a
 * working host can always see and talk to each other, and to its bots:
 *
 *   list_chats, send_to_chat   this host's chats (sessions.ts › roster)
 *   list_bots, message_bot     this host's bots
 *   list_hosts, list_refs      this host only
 *
 * Everything else — transcripts, search, making and closing chats, file
 * transfers — needs the desktop, and says so.
 *
 * The same tools as the desktop's server, registered by the same code
 * (src/main/mcp/server.ts), so an agent sees one tool list whichever end
 * answers. A message delivered here is in the receiving chat's event log,
 * and its transcript on the desktop catches up when the desktop next
 * reads that log.
 */
import type { HostFrame, HostRepo } from '@shared/hostProtocol';
import type { BotSummary, ChatSummary, PopbotToolHandlers, ToolFailure } from '../main/mcp/server';
import { attributeCrossChatMessage } from '../main/mcp/crossChat';
import { dlog } from '../main/diagLog';
import { forwardMcp, type McpRelayFn } from './mcpRelay';
import type { HostBots } from './bots';
import type { RosterChat } from './chatRoster';
import type { HostSessions } from './sessions';
import type { HostWorkspaces } from './workspaces';

type Outcome = 'replied' | 'timeout' | 'needs-permission' | 'errored';

export interface LocalPopbotDeps {
  hostName: string;
  version: string;
  cli: { claude: string | null; codex: string | null };
  repos: () => HostRepo[];
  sessions: HostSessions;
  workspaces: HostWorkspaces;
  bots: HostBots;
}

/** Where a chat's popbot call goes: up its stream to the desktop when
 *  one is reading it, else to the host's own server (`localUrlFor`). */
export function popbotRoute(sessions: HostSessions, localUrlFor: (chatId: string) => string): McpRelayFn {
  return (chatId, request, signal) => (
    sessions.desktopAttached(chatId)
      ? sessions.relayMcp(chatId, request, signal)
      : forwardMcp(localUrlFor(chatId), request, signal)
  );
}

export function localPopbotHandlers(d: LocalPopbotDeps): PopbotToolHandlers {
  const { sessions, bots } = d;
  const fail = (error: string): ToolFailure => ({ error });
  const away = (what: string): ToolFailure =>
    fail(
      `${what} needs PopBot's desktop, which is not connected to ${d.hostName} right now. ` +
      'Until it is back, list_chats, send_to_chat, list_bots and message_bot work for the chats and bots on this host.',
    );
  const isThisHost = (host: string): boolean => {
    const h = host.trim().toLowerCase();
    return h === d.hostName.toLowerCase() || h === 'this host';
  };
  const nameOf = (chatId: string | null): string =>
    (chatId && sessions.roster.get(chatId)?.name) || chatId || 'a chat';

  const summarize = (c: RosterChat, caller: string | null): ChatSummary => {
    const held = d.workspaces.held(c.id);
    const live = sessions.get(c.id);
    return {
      id: c.id,
      name: c.name,
      status: live?.session.isAlive() && sessions.isBusy(c.id) ? 'run' : 'idle',
      agent: c.body.agent,
      repoId: c.body.workspace?.repoId ?? '',
      branch: held?.branch ?? c.body.workspace?.branch ?? null,
      ticket: null,
      pr: null,
      cloud: false,
      host: d.hostName,
      closed: !c.open,
      lastActiveAt: c.lastActiveAt,
      isCaller: c.id === caller,
    };
  };

  /** A chat on this host by id, or by its exact name. */
  const findChat = (ref: string): RosterChat | null => {
    const byId = sessions.roster.get(ref);
    if (byId) return byId;
    const key = ref.trim().toLowerCase();
    const named = sessions.roster.list().filter((c) => c.name.toLowerCase() === key);
    return named.length === 1 ? named[0] : null;
  };

  return {
    listChats({ includeClosed, host }, caller) {
      if (host && !isThisHost(host)) return away(`Listing the chats on "${host}"`);
      return sessions.roster.list()
        .filter((c) => includeClosed || c.open)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .map((c) => summarize(c, caller));
    },

    async listHosts() {
      return [{
        id: 'this-host',
        name: d.hostName,
        openChats: sessions.roster.list().filter((c) => c.open).length,
        reachable: true,
        version: d.version,
        claude: !!d.cli.claude,
        codex: !!d.cli.codex,
        repos: d.repos().map((r) => ({ id: r.id, defaultBase: r.defaultBase, mode: r.mode, slotCount: r.slotCount })),
      }];
    },

    async sendToChat({ chatId, text, waitForReply, timeoutSeconds }, caller) {
      if (chatId === caller) return fail('you cannot message the chat you are running in — that would wait on your own turn');
      if (sessions.isBot(chatId)) return fail(`${chatId} is a bot; use message_bot`);
      const target = findChat(chatId);
      if (!target) {
        return fail(
          `no chat ${chatId} on ${d.hostName}. PopBot's desktop is not connected, so only the chats on this host can be ` +
          'reached right now (list_chats shows them).',
        );
      }
      if (target.id === caller) return fail('you cannot message the chat you are running in — that would wait on your own turn');
      if (!target.open) return fail(`chat ${target.id} ("${target.name}") is closed; it can be reopened in PopBot`);
      const from = { id: caller ?? '', name: nameOf(caller) };
      const forAgent = attributeCrossChatMessage(text, from, waitForReply);
      const send = async (): Promise<void> => {
        await sessions.prompt(target.id, text, { ...from, waiting: waitForReply }, forAgent);
      };
      try {
        await sessions.wake(target.id);
        if (!waitForReply) {
          await send();
          dlog('host.popbot.send', { by: caller, to: target.id, wait: false });
          return { outcome: 'sent', reply: '', entries: 0 };
        }
        const res = await deliverAndWait(sessions, target.id, send, timeoutSeconds * 1000);
        dlog('host.popbot.send', { by: caller, to: target.id, wait: true, outcome: res.outcome, replyChars: res.reply.length });
        return {
          outcome: res.outcome,
          reply: res.reply,
          entries: res.entries,
          ...(res.outcome === 'errored'
            ? { reason: `delivered, but the agent in chat ${target.id} failed to run its turn${res.reason ? `: ${res.reason}` : ''}. Resending will not help.` }
            : {}),
        };
      } catch (err) {
        return fail(`could not reach "${target.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async listBots({ host }) {
      if (host && !isThisHost(host)) return away(`Listing the bots on "${host}"`);
      return bots.list().map((b): BotSummary => ({
        id: b.id,
        name: b.name,
        host: d.hostName,
        hostReachable: true,
        chatId: b.chatId,
        state: b.state,
        githubLogin: b.githubLogin,
        triggers: b.triggers.map((t) => (t.kind === 'github' ? { github: t.repo, labels: t.labels } : { schedule: t.schedule })),
        watching: b.watching.map((pr) => ({ repo: pr.repo, number: pr.number, title: pr.title, ci: pr.ci, decision: pr.decision })),
        lastError: b.lastError,
      }));
    },

    async messageBot({ bot: wanted, host, text, waitForReply, timeoutSeconds }, caller) {
      if (host && !isThisHost(host)) return away(`Messaging a bot on "${host}"`);
      const from = { id: caller ?? '', name: nameOf(caller) };
      if (!waitForReply) {
        const sent = await bots.fromChat(wanted, from, text, false);
        if ('error' in sent) return sent;
        return { outcome: 'sent', reply: '', entries: 0, chatId: sent.bot.id };
      }
      let chatId = '';
      let sent: Awaited<ReturnType<HostBots['fromChat']>> | null = null;
      const res = await deliverAndWait(
        sessions,
        () => chatId,
        async (watch) => {
          sent = await bots.fromChat(wanted, from, text, true, (id) => { chatId = id; watch(); });
          if ('error' in sent) throw new Error(sent.error);
        },
        timeoutSeconds * 1000,
      ).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
      if ('error' in res) return fail(res.error);
      return { outcome: res.outcome, reply: res.reply, entries: res.entries, chatId };
    },

    async createChat() { return away('Creating a chat'); },
    async closeChat() { return away('Closing a chat'); },
    async reopenChat() { return away('Reopening a chat'); },
    async startCodeReview() { return away('Starting a code review'); },
    async openTicketChat() { return away('Opening a ticket chat'); },
    getTranscript() { return away('Reading a transcript'); },
    searchTranscripts() { return away('Searching transcripts'); },
    listRefs() {
      return {
        tickets: [],
        prs: [],
        chats: sessions.roster.list().map((c) => ({ id: c.id, name: c.name, closed: !c.open })),
      };
    },
    goToMessage() { return away('Showing a message'); },
    async transferFile() { return away('Sending a file'); },
    async acceptFileTransfer() { return away('Accepting a file'); },
    async declineFileTransfer() { return away('Declining a file'); },
    async getFileTransfer() { return away('Checking a file transfer'); },
    async cancelFileTransfer() { return away('Cancelling a file transfer'); },
  };
}

/**
 * Send a message into a chat and wait for the turn that answers it — the
 * host's version of AgentHost.sendAndWait. A chat that is mid-turn gets
 * the message queued behind its current work, so the answer is the turn
 * that starts after the message went in. Ends early when the agent stops
 * to ask a person for a permission (none may be there), on an error, or
 * at the timeout.
 */
export function deliverAndWait(
  sessions: HostSessions,
  chat: string | (() => string),
  send: (watch: () => void) => Promise<void>,
  timeoutMs: number,
): Promise<{ outcome: Outcome; reply: string; entries: number; reason: string | null }> {
  const chatIdOf = (): string => (typeof chat === 'string' ? chat : chat());
  return new Promise((resolve, reject) => {
    const texts = new Map<string, string>();
    let reason: string | null = null;
    let wasBusy = false;
    let started = false;
    let done = false;
    let off: (() => void) | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: Outcome): void => {
      if (done) return;
      done = true;
      off?.();
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      const replies = [...texts.values()].map((t) => t.trim()).filter(Boolean);
      resolve({ outcome, reply: replies.join('\n\n'), entries: replies.length, reason: outcome === 'errored' ? reason : null });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const onFrame = (frame: HostFrame): void => {
      if (frame.kind === 'dead') {
        reason = reason ?? 'its session ended';
        return finish('errored');
      }
      if (frame.kind !== 'event') return;
      const event = frame.event;
      switch (event.type) {
        case 'turn-start':
          started = true;
          if (grace) { clearTimeout(grace); grace = null; }
          return;
        case 'error':
          reason = event.message;
          return;
        case 'permission-request':
          return finish('needs-permission');
        case 'message-start':
          // Text from the turn the message is queued behind is not the answer.
          if (started) texts.set(event.messageId, '');
          return;
        case 'text-delta':
          if (started) texts.set(event.messageId, (texts.get(event.messageId) ?? '') + event.delta);
          return;
        case 'session-status':
          if (event.status === 'errored') return finish('errored');
          if (event.status !== 'idle' && event.status !== 'complete') return;
          if (started) return finish('replied');
          // The turn the message was queued behind just ended: the answer
          // is next — unless the backend folded the message into that
          // turn, which then never gets a turn-start of its own.
          if (wasBusy && !grace) grace = setTimeout(() => finish('replied'), 5_000);
          return;
        default:
          return;
      }
    };
    const watch = (): void => {
      if (off) return;
      const id = chatIdOf();
      wasBusy = sessions.isBusy(id);
      off = sessions.tap(id, onFrame);
    };
    const go = async (): Promise<void> => {
      if (typeof chat === 'string') watch();
      await send(watch);
      watch();
    };
    go().catch((err: unknown) => {
      if (done) return;
      done = true;
      off?.();
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      reject(err);
    });
  });
}

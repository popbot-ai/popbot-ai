/**
 * The host's own popbot tools: the fallback for its chats while the
 * desktop cannot be reached. A chat's popbot calls go to the desktop
 * (mcpRelay.ts, popbotRoute), which knows every chat everywhere; when it
 * cannot be reached they come here instead, so the chats on a working
 * host can always see and talk to each other, and to its bots:
 *
 *   list_chats, send_to_chat            this host's chats (sessions.ts › roster)
 *   get_chat_transcript, search_chats   from their event logs (hostTranscript.ts)
 *   create_chat, close_chat, reopen_chat   on this host; the desktop adopts
 *                                       them when it is back (HostInfo.roster)
 *   list_bots, message_bot              this host's bots
 *   list_hosts, list_refs               this host only
 *
 * The rest — code reviews and ticket chats (the desktop's settings),
 * showing a message (its window), file transfers (it carries them) —
 * needs the desktop, and says so.
 *
 * The same tools as the desktop's server, registered by the same code
 * (src/main/mcp/server.ts), so an agent sees one tool list whichever end
 * answers. A message delivered here is in the receiving chat's event log,
 * and its transcript on the desktop catches up when the desktop next
 * reads that log.
 */
import { randomUUID } from 'node:crypto';
import type { HostFrame, HostRepo, HostSpawnBody, HostWorkspaceRequest } from '@shared/hostProtocol';
import type { TranscriptSearchHit } from '@shared/ipc';
import type { BotSummary, ChatSummary, PopbotToolHandlers, ToolFailure } from '../main/mcp/server';
import { attributeCrossChatMessage } from '../main/mcp/crossChat';
import { renderTranscript, searchTranscript } from '../main/mcp/transcript';
import { dlog } from '../main/diagLog';
import type { HostBots } from './bots';
import type { RosterChat } from './chatRoster';
import { frameEntries } from './hostTranscript';
import { forwardMcp, type McpRelayFn } from './mcpRelay';
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

/**
 * Where a chat's popbot call goes. The desktop answers whenever it can:
 * when it is reading the chat's stream, at once; when it is around but
 * not reading this chat, the call goes in the log and the desktop picks
 * it up as it follows a chat that moved on (its 30-second host check).
 * The host's own server (`localUrlFor`) is the fallback — no desktop to
 * be reached, or none picked the call up within `waitMs`.
 *
 * Only tool calls wait. The protocol's own requests (initialize, the tool
 * list) get the same answer from either end, and an agent connecting its
 * tools must not wait on a desktop that may not come.
 */
export function popbotRoute(
  sessions: HostSessions,
  localUrlFor: (chatId: string) => string,
  opts: { waitMs?: number } = {},
): McpRelayFn {
  const waitMs = opts.waitMs ?? 45_000;
  return async (chatId, request, signal) => {
    if (sessions.desktopAttached(chatId)) return sessions.relayMcp(chatId, request, signal);
    if (sessions.desktopReachable() && isToolCall(request.body)) {
      const answer = await sessions.relayMcpOrWithdraw(chatId, request, signal, waitMs);
      if (answer) return answer;
      dlog('host.popbot.fallback', { chatId, waitedMs: waitMs });
    }
    return forwardMcp(localUrlFor(chatId), request, signal);
  };
}

function isToolCall(body: string): boolean {
  try {
    const msg = JSON.parse(body) as { method?: unknown } | unknown[];
    return !Array.isArray(msg) && msg?.method === 'tools/call';
  } catch {
    return false;
  }
}

export function localPopbotHandlers(d: LocalPopbotDeps): PopbotToolHandlers {
  const { sessions, bots } = d;
  const fail = (error: string): ToolFailure => ({ error });
  const away = (what: string): ToolFailure =>
    fail(
      `${what} needs PopBot's desktop, which is not connected to ${d.hostName} right now. ` +
      'Until it is back, the chat tools (list, message, transcripts, search, create, close, reopen) and the bot tools work for the chats and bots on this host.',
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

  /** A bot's chat on this host, by the bot's id or name. */
  const botChat = (ref: string): string | null => {
    const key = ref.trim().toLowerCase();
    return bots.list().find((b) => b.chatId === ref || b.id.toLowerCase() === key || b.name.toLowerCase() === key)?.chatId ?? null;
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

    async createChat({ name, host, repoId, workspace, baseBranch, branch, agent, firstMessage }, caller) {
      if (host && !isThisHost(host)) return away(`Creating a chat on "${host}"`);
      if (workspace === 'cloud') return away('Creating a cloud chat');
      const parent = caller ? sessions.roster.get(caller) : null;
      const repo = repoId?.trim() || parent?.body.workspace?.repoId || null;
      if (repo && !d.repos().some((r) => r.id === repo)) {
        return fail(`no repository "${repo}" on ${d.hostName} (list_hosts shows its repositories)`);
      }
      const want: HostWorkspaceRequest = !repo
        ? { kind: 'scratch' }
        : workspace === 'slot'
          ? { kind: 'worktree', repoId: repo, branch: branch?.trim() || `popbot/chat-${Date.now()}`, baseBranch: baseBranch?.trim() || null }
          : { kind: 'root', repoId: repo };
      const chatId = `chat_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const kind = agent ?? parent?.body.agent ?? 'claude';
      const same = parent?.body.agent === kind ? parent.body : null;
      const body: HostSpawnBody = {
        agent: kind,
        chatName: name.trim(),
        // It runs under its maker's permission rules and models.
        rules: parent?.body.rules ?? { chat: [], global: [] },
        popbotMcp: true,
        workspace: want,
        claudeModel: same?.claudeModel ?? null,
        claudeReasoningEffort: same?.claudeReasoningEffort ?? null,
        codexModel: same?.codexModel ?? null,
        codexReasoningEffort: same?.codexReasoningEffort ?? null,
      };
      try {
        if (want.kind !== 'scratch') await d.workspaces.ensure(chatId, want);
      } catch (err) {
        return fail(`could not make its workspace: ${err instanceof Error ? err.message : String(err)}`);
      }
      const chat = sessions.roster.created(chatId, body);
      dlog('host.popbot.create', { by: caller, chatId, kind: want.kind, repo });
      if (firstMessage?.trim()) {
        const from = { id: caller ?? '', name: nameOf(caller) };
        const text = firstMessage.trim();
        void sessions.wake(chatId)
          .then(() => sessions.prompt(chatId, text, from, caller ? attributeCrossChatMessage(text, from, false) : text))
          .catch((err: unknown) => dlog('host.popbot.first-message-failed', { chatId, error: err instanceof Error ? err.message : String(err) }));
      }
      return { chat: summarize(chat, caller) };
    },

    async closeChat({ chatId }, caller) {
      if (chatId === caller) return fail('you cannot close the chat you are running in');
      const chat = findChat(chatId);
      if (!chat) return fail(`no chat ${chatId} on ${d.hostName}`);
      if (!chat.open) return fail(`chat ${chat.id} is already closed`);
      // Its workspace stays as it is, as when the desktop closes a host chat.
      await sessions.closeByHost(chat.id);
      dlog('host.popbot.close', { by: caller, chatId: chat.id });
      return { ok: true, chatId: chat.id };
    },

    async reopenChat({ chatId }, caller) {
      const chat = findChat(chatId);
      if (!chat) return fail(`no chat ${chatId} on ${d.hostName}`);
      if (!chat.open) {
        sessions.reopenByHost(chat.id);
        dlog('host.popbot.reopen', { by: caller, chatId: chat.id });
      }
      return { chat: summarize(sessions.roster.get(chat.id) ?? chat, caller) };
    },

    async startCodeReview() { return away('Starting a code review'); },
    async openTicketChat() { return away('Opening a ticket chat'); },

    getTranscript({ chatId: wanted, from, to, includeTools, maxChars }, caller) {
      const chatId = wanted ? (findChat(wanted)?.id ?? botChat(wanted) ?? wanted) : caller;
      if (!chatId) return fail('pass chatId');
      const frames = sessions.framesOf(chatId);
      if (!frames) return fail(`no chat ${chatId} on ${d.hostName}`);
      const entries = frameEntries(frames, { includeTools });
      const r = renderTranscript(entries, { from, to, maxChars });
      const note = `(The recent part of this chat, as ${d.hostName} has it while PopBot's desktop is away; #numbers are this host's.)\n\n`;
      return { chatId, text: note + r.text, count: r.count, total: entries.length, truncated: r.truncated };
    },

    searchTranscripts({ query, chatId: wanted, allChats, includeClosed, mode, contextChars, maxResults, caseSensitive }, caller) {
      const scope: Array<{ id: string; name: string; closed: boolean }> = [];
      if (!allChats && !includeClosed) {
        const id = wanted ? (findChat(wanted)?.id ?? botChat(wanted) ?? wanted) : caller;
        if (!id) return fail('pass chatId, allChats or includeClosed');
        const known = sessions.roster.get(id);
        const bot = bots.list().find((b) => b.chatId === id);
        if (!known && !bot) return fail(`no chat ${id} on ${d.hostName}`);
        scope.push({ id, name: known?.name ?? bot!.name, closed: known ? !known.open : false });
      } else {
        for (const c of sessions.roster.list()) if (c.open || includeClosed) scope.push({ id: c.id, name: c.name, closed: !c.open });
        for (const b of bots.list()) scope.push({ id: b.chatId, name: b.name, closed: false });
      }
      // "fts": every word, anywhere in a message; the match shown is the first.
      const terms = mode === 'fts' ? query.split(/\s+/).filter(Boolean) : [query];
      const fold = (s: string): string => (caseSensitive ? s : s.toLowerCase());
      const matches: TranscriptSearchHit[] = [];
      for (const chat of scope) {
        if (matches.length >= maxResults) break;
        const entries = frameEntries(sessions.framesOf(chat.id) ?? [], { includeTools: true })
          .filter((e) => terms.every((t) => fold(e.text).includes(fold(t))));
        for (const m of searchTranscript(entries, terms[0] ?? '', { contextChars, maxResults: maxResults - matches.length, caseSensitive })) {
          matches.push({ chatId: chat.id, chatName: chat.name, closed: chat.closed, messageId: m.id, index: m.index, role: m.role, kind: entries.find((e) => e.id === m.id)?.kind ?? 'text', ts: m.ts, offset: m.offset, before: m.before, match: m.match, after: m.after });
        }
      }
      return { matches };
    },
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

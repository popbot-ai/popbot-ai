/**
 * The popbot MCP tools, for real: what server.ts exposes, implemented
 * against PopBot's DB, its chat workspace code and AgentHost. Each tool
 * does the same thing the renderer does for the same action — a review
 * chat from here is the review chat the Reviews list would have made,
 * template and all — and tells the renderer afterwards (`chats-changed`).
 */
import { homedir } from 'node:os';
import type { CreateChatInput, CreateChatResult } from '@shared/ipc';
import { type CrossChatOrigin,
  CLAUDE_REASONING_EFFORTS,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  DEFAULT_CODEX_REASONING_EFFORT,
  closestReasoningEffort,
  codexReasoningEffortsForModel,
  normalizeClaudeModel,
  normalizeCodexModel,
  type ChatRecord,
} from '@shared/persistence';
import { DEFAULT_SOURCE_CONTROL, SOURCE_CONTROL_PROVIDERS } from '@shared/sourceControl';
import {
  DEFAULT_START_CL_REVIEW_TEMPLATE,
  DEFAULT_START_CODE_REVIEW_TEMPLATE,
  DEFAULT_START_TICKET_TEMPLATE,
  expandTemplate,
} from '@shared/templates';
import { AgentHost } from '../agents/AgentHost';
import { dlog } from '../diagLog';
import { closeChatWithWorkspace, createChatWithWorkspace, reopenChatWithWorkspace } from '../ipc/chats';
import { getChat, listChatRefs, listClosedChats, listOpenChats } from '../persistence/chats';
import { getMessage, listMessages } from '../persistence/messages';
import { getRepo, listRepos } from '../persistence/repos';
import { getSetting } from '../persistence/settings';
import { getReviewByNumber } from '../reviews';
import { getSourceControlProvider } from '../scm';
import { activeTicketSource } from '../tickets/registry';
import type { ChatSummary, PopbotToolHandlers, ToolFailure } from './server';
import { searchTranscripts } from '../search/transcriptSearch';
import { renderTranscript, transcriptEntries } from './transcript';

const CLOSED_LOOKBACK = 500;

function fail(error: string): ToolFailure {
  return { error };
}

function summarize(chat: ChatRecord, caller: string | null, closed: boolean): ChatSummary {
  return {
    id: chat.id,
    name: chat.name,
    status: chat.status,
    agent: chat.agent,
    repoId: chat.repoId,
    branch: chat.branch,
    ticket: chat.ticket,
    pr: chat.pr,
    cloud: !!chat.cloud,
    closed,
    lastActiveAt: chat.lastActiveAt,
    isCaller: chat.id === caller,
  };
}

function isOpen(chatId: string): boolean {
  return listOpenChats().some((c) => c.id === chatId);
}

function findByPr(prNumber: number): { chat: ChatRecord; closed: boolean } | null {
  const open = listOpenChats().find((c) => c.pr === prNumber);
  if (open) return { chat: open, closed: false };
  const closed = listClosedChats(CLOSED_LOOKBACK).find((c) => c.pr === prNumber);
  return closed ? { chat: closed, closed: true } : null;
}

function findByTicket(ticket: string): { chat: ChatRecord; closed: boolean } | null {
  const open = listOpenChats().find((c) => c.ticket === ticket);
  if (open) return { chat: open, closed: false };
  const closed = listClosedChats(CLOSED_LOOKBACK).find((c) => c.ticket === ticket);
  return closed ? { chat: closed, closed: true } : null;
}

function describeCreateFailure(r: Exclude<CreateChatResult, { ok: true }>): string {
  switch (r.reason) {
    case 'slots-not-configured': return 'the repository has no slots configured (PopBot Preferences ▸ Repositories)';
    case 'git-not-configured': return 'no repository is configured';
    case 'slot-taken': return `slot ${r.slotId} is taken`;
    case 'no-free-slot': return 'no free slot — close a chat first, or use workspace "repo-root"';
    case 'worktree-failed': return `workspace setup failed: ${r.message}`;
  }
}

/** The renderer's "last agent config + effort defaults" for a new chat. */
function agentDefaults(context: 'general' | 'codeReview'): Pick<CreateChatInput, 'agent' | 'claudeModel' | 'claudeReasoningEffort' | 'codexModel' | 'codexReasoningEffort'> {
  const last = getSetting<{ agent?: string; claudeModel?: string; codexModel?: string }>('chatCreate.lastAgentConfig') ?? {};
  const d = getSetting<{
    claudeReasoningEffort?: string; codexReasoningEffort?: string;
    codeReviewClaudeReasoningEffort?: string; codeReviewCodexReasoningEffort?: string;
  }>('agent.effortDefaults') ?? {};
  const codexModel = normalizeCodexModel(last.codexModel);
  return {
    agent: last.agent === 'codex' ? 'codex' : 'claude',
    claudeModel: normalizeClaudeModel(last.claudeModel),
    codexModel,
    claudeReasoningEffort: closestReasoningEffort(
      context === 'codeReview' ? d.codeReviewClaudeReasoningEffort : d.claudeReasoningEffort,
      CLAUDE_REASONING_EFFORTS,
      DEFAULT_CLAUDE_REASONING_EFFORT,
    ),
    codexReasoningEffort: closestReasoningEffort(
      context === 'codeReview' ? d.codeReviewCodexReasoningEffort : d.codexReasoningEffort,
      codexReasoningEffortsForModel(codexModel),
      DEFAULT_CODEX_REASONING_EFFORT,
    ),
  };
}

async function branchUsername(): Promise<string> {
  const override = getSetting<{ username?: string }>('git')?.username?.trim();
  if (override) return override;
  try {
    return (await getSourceControlProvider().deriveUsername(homedir())) || 'pop';
  } catch {
    return 'pop';
  }
}

function slugify(text: string, maxWords = 6): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join('-')
    .replace(/-+/g, '-');
}

function lastRepoId(): string {
  return getSetting<string>('chatCreate.lastRepoId') || 'app';
}

function templates(): Record<string, string | undefined> {
  return getSetting<Record<string, string | undefined>>('templates') ?? {};
}

function priorityLabel(p: number): string {
  return ({ 1: 'urgent', 2: 'high', 3: 'med', 4: 'low' } as Record<number, string>)[p] ?? '';
}

function sendInBackground(chatId: string, text: string, origin?: CrossChatOrigin): void {
  void AgentHost.send(chatId, text, undefined, origin).catch((err) => {
    dlog('mcp.popbot.send-failed', { chatId, error: err instanceof Error ? err.message : String(err) });
  });
}

function changed(chatId: string, reason: 'created' | 'closed' | 'reopened'): void {
  AgentHost.emit({ type: 'chats-changed', chatId, reason, ts: Date.now() });
}

export function createPopbotToolHandlers(): PopbotToolHandlers {
  return {
    listChats({ includeClosed }, caller) {
      const open = listOpenChats().map((c) => summarize(c, caller, false));
      const closed = includeClosed ? listClosedChats(200).map((c) => summarize(c, caller, true)) : [];
      return [...open, ...closed];
    },

    async createChat(input, caller) {
      const repoId = input.repoId?.trim() || lastRepoId();
      const repo = getRepo(repoId);
      if (!repo) {
        const known = listRepos().map((r) => r.id).join(', ') || 'none configured';
        return fail(`unknown repository "${repoId}" (known: ${known})`);
      }
      const name = input.name.trim();
      const base: CreateChatInput = {
        name,
        type: 'lite',
        repoId,
        ...agentDefaults('general'),
        ...(input.agent ? { agent: input.agent } : {}),
      };
      let result: CreateChatResult;
      if (input.workspace === 'cloud') {
        result = await createChatWithWorkspace({ ...base, agent: 'claude', cloud: true });
      } else if (input.workspace === 'slot') {
        const isPerforce = (repo.scm ?? 'git') === 'perforce';
        const branch = input.branch?.trim() || `${await branchUsername()}/${slugify(name) || 'chat'}`;
        result = await createChatWithWorkspace({
          ...base,
          allocateSlot: true,
          branch,
          baseBranch: isPerforce ? 'latest' : (input.baseBranch?.trim() || repo.defaultBase || 'main'),
        });
      } else {
        result = await createChatWithWorkspace(base);
      }
      if (!result.ok) return fail(describeCreateFailure(result));
      dlog('mcp.popbot.create', { by: caller, chatId: result.chat.id, workspace: input.workspace });
      changed(result.chat.id, 'created');
      if (input.firstMessage?.trim()) sendInBackground(result.chat.id, input.firstMessage.trim());
      return { chat: summarize(result.chat, caller, false) };
    },

    async closeChat({ chatId, keepChanges }, caller) {
      if (chatId === caller) return fail('you cannot close the chat you are running in');
      const chat = getChat(chatId);
      if (!chat) return fail(`no chat ${chatId}`);
      if (!isOpen(chatId)) return fail(`chat ${chatId} is already closed`);
      await closeChatWithWorkspace(chatId, { stash: keepChanges });
      dlog('mcp.popbot.close', { by: caller, chatId, keepChanges });
      changed(chatId, 'closed');
      return { ok: true, chatId };
    },

    async reopenChat({ chatId }, caller) {
      const chat = getChat(chatId);
      if (!chat) return fail(`no chat ${chatId}`);
      if (isOpen(chatId)) return { chat: summarize(chat, caller, false) };
      const res = await reopenChatWithWorkspace(chatId);
      if (!res.ok) {
        return fail(res.reason === 'no-free-slot'
          ? 'no free slot to reopen it on — close a chat first'
          : res.reason === 'worktree-failed' ? `workspace setup failed: ${res.message}` : res.reason);
      }
      dlog('mcp.popbot.reopen', { by: caller, chatId });
      changed(chatId, 'reopened');
      return { chat: summarize(res.chat, caller, false) };
    },

    async sendToChat({ chatId, text, waitForReply, timeoutSeconds }, caller) {
      if (chatId === caller) return fail('you cannot message the chat you are running in — that would wait on your own turn');
      const chat = getChat(chatId);
      if (!chat) return fail(`no chat ${chatId}`);
      if (!isOpen(chatId)) return fail(`chat ${chatId} is closed; reopen it first`);
      // The message lands as a user turn in the other chat: the origin
      // on the row shows it in a cross-agent box, and the agent gets an
      // attribution saying who it is from and how to answer.
      const senderId = caller ?? '';
      const origin: CrossChatOrigin = {
        chatId: senderId,
        chatName: (caller && getChat(caller)?.name) || senderId || 'another chat',
        waiting: waitForReply,
      };
      if (!waitForReply) {
        sendInBackground(chatId, text, origin);
        return { outcome: 'sent', reply: '', entries: 0 };
      }
      const { outcome, messages } = await AgentHost.sendAndWait(chatId, text, timeoutSeconds * 1000, origin);
      const entries = transcriptEntries(messages, { includeTools: false });
      const reply = entries.filter((e) => e.role === 'agent').map((e) => e.text).join('\n\n')
        || entries.map((e) => e.text).join('\n');
      dlog('mcp.popbot.sendToChat', { by: caller, chatId, outcome, replyChars: reply.length });
      return { outcome, reply, entries: messages.length };
    },

    async startCodeReview({ prNumber, scm }, caller) {
      const res = await getReviewByNumber(prNumber, scm === 'perforce' ? 'perforce' : 'git');
      if (!res.ok) return fail(`review #${prNumber} not found (${res.reason}${res.error ? `: ${res.error}` : ''})`);
      const pr = res.pr;
      const existing = findByPr(pr.number);
      if (existing) {
        if (!existing.closed) return { chat: summarize(existing.chat, caller, false), existing: true };
        const reopened = await reopenChatWithWorkspace(existing.chat.id);
        if (reopened.ok) {
          changed(existing.chat.id, 'reopened');
          return { chat: summarize(reopened.chat, caller, false), existing: true };
        }
      }
      const isSwarm = pr.scm === 'swarm';
      const repoId = isSwarm ? listRepos().find((r) => r.scm === 'perforce')?.id : lastRepoId();
      if (!repoId) return fail('no Perforce repository is configured for a Swarm review');
      const result = await createChatWithWorkspace({
        name: `[CR] PR #${pr.number} · ${pr.title.slice(0, 80)}`,
        pr: pr.number,
        prUrl: pr.url,
        type: 'lite',
        repoId,
        ...agentDefaults('codeReview'),
      });
      if (!result.ok) return fail(describeCreateFailure(result));
      const tmpl = (isSwarm
        ? (templates().startClReview ?? DEFAULT_START_CL_REVIEW_TEMPLATE)
        : (templates().startCodeReview ?? DEFAULT_START_CODE_REVIEW_TEMPLATE)).trim();
      if (tmpl) {
        sendInBackground(result.chat.id, isSwarm
          ? expandTemplate(tmpl, { reviewid: pr.number, reviewtitle: pr.title, reviewurl: pr.url })
          : expandTemplate(tmpl, { prnum: pr.number, prtitle: pr.title, branch: pr.headRefName, slot: '' }));
      }
      dlog('mcp.popbot.review', { by: caller, chatId: result.chat.id, pr: pr.number });
      changed(result.chat.id, 'created');
      return { chat: summarize(result.chat, caller, false), existing: false };
    },

    async openTicketChat({ ticket, repoId: wantedRepo, baseBranch: wantedBase }, caller) {
      const res = await activeTicketSource().getIssue(ticket.trim());
      if (!res.ok) return fail(`ticket ${ticket} not found (${res.reason}${res.error ? `: ${res.error}` : ''})`);
      const issue = res.issue;
      const id = issue.identifier;
      const existing = findByTicket(id);
      if (existing) {
        if (!existing.closed) return { chat: summarize(existing.chat, caller, false), existing: true };
        const reopened = await reopenChatWithWorkspace(existing.chat.id);
        if (reopened.ok) {
          changed(existing.chat.id, 'reopened');
          return { chat: summarize(reopened.chat, caller, false), existing: true };
        }
      }
      const repoId = wantedRepo?.trim() || lastRepoId();
      const repo = getRepo(repoId);
      if (!repo) return fail(`unknown repository "${repoId}"`);
      const scm = repo.scm ?? DEFAULT_SOURCE_CONTROL;
      const idSlug = id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const branch = `${await branchUsername()}/${idSlug}-${slugify(issue.title)}`;
      const baseBranch = scm === 'perforce' ? 'latest' : (wantedBase?.trim() || repo.defaultBase || 'main');
      const result = await createChatWithWorkspace({
        name: `${id} · ${issue.title.slice(0, 60)}`,
        ticket: id,
        branch,
        baseBranch,
        type: 'lite',
        allocateSlot: true,
        repoId,
        ...agentDefaults('general'),
      });
      if (!result.ok) return fail(describeCreateFailure(result));
      void activeTicketSource().promoteIssue(id).catch(() => undefined);
      const tmpl = (templates().startTicket ?? DEFAULT_START_TICKET_TEMPLATE).trim();
      if (tmpl) {
        const description = issue.description ?? '';
        const scmVars = (SOURCE_CONTROL_PROVIDERS[scm] ?? SOURCE_CONTROL_PROVIDERS[DEFAULT_SOURCE_CONTROL]).promptVars;
        sendInBackground(result.chat.id, expandTemplate(tmpl, {
          ticketid: id,
          tickettitle: issue.title,
          description,
          markdown: description,
          ticketurl: issue.url ?? '',
          priority: priorityLabel(issue.priority),
          project: issue.project?.name ?? '',
          branch,
          ...scmVars,
          slot: result.chat.slotId ?? '',
        }));
      }
      dlog('mcp.popbot.ticket', { by: caller, chatId: result.chat.id, ticket: id });
      changed(result.chat.id, 'created');
      return { chat: summarize(result.chat, caller, false), existing: false };
    },

    listRefs() {
      return listChatRefs();
    },

    goToMessage({ chatId, messageId }, caller) {
      const chat = getChat(chatId);
      if (!chat) return fail(`no chat ${chatId}`);
      const message = getMessage(messageId);
      if (!message || message.chatId !== chatId) return fail(`no message ${messageId} in chat ${chatId}`);
      AgentHost.emit({ type: 'go-to-message', chatId, messageId, ts: Date.now() });
      dlog('mcp.popbot.goTo', { by: caller, chatId, messageId });
      return { ok: true };
    },

    getTranscript({ chatId: wanted, from, to, includeTools, maxChars }, caller) {
      const chatId = wanted ?? caller;
      if (!chatId) return fail('pass chatId');
      if (!getChat(chatId)) return fail(`no chat ${chatId}`);
      const entries = transcriptEntries(listMessages(chatId), { includeTools });
      const r = renderTranscript(entries, { from, to, maxChars });
      return { chatId, text: r.text, count: r.count, total: entries.length, truncated: r.truncated };
    },

    searchTranscripts({ query, chatId: wanted, allChats, includeClosed, mode, contextChars, maxResults, caseSensitive }, caller) {
      // Scope: one chat, every open chat, or everything.
      let chatIds: string[] | undefined;
      if (!allChats && !includeClosed) {
        const id = wanted ?? caller;
        if (!id || !getChat(id)) return fail(wanted ? `no chat ${wanted}` : 'pass chatId, allChats or includeClosed');
        chatIds = [id];
      }
      const res = searchTranscripts(query, { chatIds, includeClosed, mode, contextChars, maxResults, caseSensitive });
      if (!res.ok) return fail(res.error);
      dlog('mcp.popbot.search', { by: caller, mode, scope: chatIds ? 'chat' : includeClosed ? 'all' : 'open', matches: res.hits.length });
      return { matches: res.hits };
    },


  };
}

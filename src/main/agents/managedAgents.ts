/**
 * The pure half of the Managed Agents backend: everything that turns
 * Anthropic session events into PopBot AgentEvents, and the small
 * derivations around it (repo URLs, agent keys, the first-message
 * preamble). No SDK calls, no DB — see ManagedAgentsBackend.ts for the
 * session that drives it.
 *
 * Managed Agents session events map onto PopBot's model like so:
 *   event_start / event_delta (agent.message)  → message-start / text-delta
 *   agent.message                              → the rest of the text + message-end
 *   agent.tool_use / agent.mcp_tool_use        → tool-use (+ permission-request when asked)
 *   agent.tool_result / agent.mcp_tool_result  → tool-result
 *   session.status_running                     → turn-start + running
 *   session.status_idle                        → idle / paused (+ an error for the sad reasons)
 *   session.error                              → error (notice while retrying)
 *   session.status_terminated / session.deleted→ ended (the next message starts a new session)
 *   span.model_request_end                     → usage (context size of the last request)
 *   agent.thread_context_compacted             → compaction done
 */
import type { AgentEvent } from '@shared/agent';
import type { ClaudeModelId, ClaudeReasoningEffort } from '@shared/persistence';
import type {
  BetaManagedAgentsDocumentBlock,
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsRedactedBlock,
  BetaManagedAgentsSearchResultBlock,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsTextBlock,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';

/** Context window PopBot assumes for the gauge; the API reports usage
 *  per request, never the window. */
export const CLOUD_CONTEXT_BUDGET = 200_000;

export type CloudStreamEvent = BetaManagedAgentsStreamSessionEvents;

/** What the translator carries from one event to the next. */
export interface CloudTurnState {
  chatId: string;
  /** agent.message previews being streamed: event id → text so far. */
  previews: Map<string, string>;
  /** Tool calls the session is holding for our confirmation. */
  pendingConfirmations: Set<string>;
  /** The session is gone; nothing more will arrive on this stream. */
  ended: boolean;
}

export function newTurnState(chatId: string): CloudTurnState {
  return { chatId, previews: new Map(), pendingConfirmations: new Set(), ended: false };
}

type ResultBlock =
  | BetaManagedAgentsTextBlock
  | BetaManagedAgentsImageBlock
  | BetaManagedAgentsDocumentBlock
  | BetaManagedAgentsSearchResultBlock
  | BetaManagedAgentsRedactedBlock;

/** Flatten result / message content to the text PopBot shows. */
export function blocksToText(blocks: ReadonlyArray<ResultBlock> | undefined | null): string {
  if (!blocks) return '';
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        parts.push(b.text);
        break;
      case 'redacted':
        parts.push('[redacted]');
        break;
      case 'image':
        parts.push('[image]');
        break;
      case 'document':
        parts.push(b.title ? `[document: ${b.title}]` : '[document]');
        break;
      case 'search_result':
        parts.push(`${b.title} — ${b.source}\n${b.content.map((c) => c.text).join('\n')}`);
        break;
      default:
        break;
    }
  }
  return parts.join('');
}

/** PopBot's name for an MCP tool — the same `mcp__<server>__<tool>`
 *  shape the Claude CLI uses, so saved permission rules apply. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * Translate one session event into PopBot events, updating `st`.
 * Deltas are best-effort on the API side (they can be shed under load),
 * so the final `agent.message` is authoritative: whatever of it the
 * deltas did not carry is emitted as one last delta.
 */
export function translateEvent(ev: CloudStreamEvent, st: CloudTurnState, ts: number): AgentEvent[] {
  const chatId = st.chatId;
  switch (ev.type) {
    case 'event_start': {
      if (ev.event.type !== 'agent.message') return [];
      st.previews.set(ev.event.id, '');
      return [{ type: 'message-start', chatId, messageId: ev.event.id, role: 'agent', ts }];
    }
    case 'event_delta': {
      const streamed = st.previews.get(ev.event_id);
      if (streamed === undefined) return [];
      if (ev.delta.type !== 'content_delta' || ev.delta.content.type !== 'text') return [];
      const delta = ev.delta.content.text;
      if (!delta) return [];
      st.previews.set(ev.event_id, streamed + delta);
      return [{ type: 'text-delta', chatId, messageId: ev.event_id, delta, ts }];
    }
    case 'agent.message': {
      const text = blocksToText(ev.content);
      const streamed = st.previews.get(ev.id);
      st.previews.delete(ev.id);
      if (streamed === undefined) {
        if (!text.trim()) return [];
        return [
          { type: 'message-start', chatId, messageId: ev.id, role: 'agent', ts },
          { type: 'text-delta', chatId, messageId: ev.id, delta: text, ts },
          { type: 'message-end', chatId, messageId: ev.id, ts },
        ];
      }
      // The deltas may have covered all, part, or (if shed) none of it.
      const rest = text.startsWith(streamed) ? text.slice(streamed.length) : text;
      const out: AgentEvent[] = [];
      if (rest) out.push({ type: 'text-delta', chatId, messageId: ev.id, delta: rest, ts });
      out.push({ type: 'message-end', chatId, messageId: ev.id, ts });
      return out;
    }
    case 'agent.tool_use':
    case 'agent.mcp_tool_use': {
      const name = ev.type === 'agent.mcp_tool_use' ? mcpToolName(ev.mcp_server_name, ev.name) : ev.name;
      const out: AgentEvent[] = [
        { type: 'tool-use', chatId, messageId: '', toolUseId: ev.id, name, args: ev.input, ts },
      ];
      if (ev.evaluated_permission === 'ask') {
        st.pendingConfirmations.add(ev.id);
        out.push({ type: 'permission-request', chatId, permissionId: ev.id, tool: name, args: ev.input, ts });
      }
      return out;
    }
    case 'agent.tool_result':
      return [{
        type: 'tool-result', chatId, messageId: '', toolUseId: ev.tool_use_id,
        isError: !!ev.is_error, text: blocksToText(ev.content), ts,
      }];
    case 'agent.mcp_tool_result':
      return [{
        type: 'tool-result', chatId, messageId: '', toolUseId: ev.mcp_tool_use_id,
        isError: !!ev.is_error, text: blocksToText(ev.content), ts,
      }];
    case 'session.status_running':
      return [
        { type: 'turn-start', chatId, ts },
        { type: 'session-status', chatId, status: 'running', ts },
      ];
    case 'session.status_idle': {
      const reason = ev.stop_reason;
      switch (reason.type) {
        case 'requires_action':
          for (const id of reason.event_ids) st.pendingConfirmations.add(id);
          return [{ type: 'session-status', chatId, status: 'paused', ts }];
        case 'retries_exhausted':
          return [
            { type: 'error', chatId, level: 'error', retryable: false, ts,
              message: 'The cloud agent stopped after repeated errors. Send a message to try again.' },
            { type: 'session-status', chatId, status: 'errored', ts },
          ];
        case 'budget_reached':
          return [
            { type: 'error', chatId, level: 'warning', retryable: false, ts,
              message: 'The cloud session reached its spending budget and paused.' },
            { type: 'session-status', chatId, status: 'idle', ts },
          ];
        default:
          return [{ type: 'session-status', chatId, status: 'idle', ts }];
      }
    }
    case 'session.error': {
      const err = ev.error;
      const retry = err.retry_status.type;
      if (retry === 'retrying') {
        return [{ type: 'error', chatId, level: 'notice', retryable: false, ts,
          message: `${err.message} — the cloud is retrying…` }];
      }
      if (retry === 'terminal') st.ended = true;
      return [
        { type: 'error', chatId, level: err.type === 'billing_error' ? 'warning' : 'error', retryable: false, ts,
          message: retry === 'terminal' ? `${err.message} The cloud session has ended.` : err.message },
      ];
    }
    case 'session.status_terminated':
    case 'session.deleted': {
      if (st.ended) return [];
      st.ended = true;
      return [
        { type: 'note', chatId, prefix: 'cloud', ts,
          text: 'The cloud session has ended. Your next message starts a new one, primed with this conversation.' },
        { type: 'session-status', chatId, status: 'idle', ts },
      ];
    }
    case 'span.model_request_end': {
      const u = ev.model_usage;
      const used = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens;
      return [{ type: 'usage', chatId, tokens: { used, budget: CLOUD_CONTEXT_BUDGET }, ts }];
    }
    case 'agent.thread_context_compacted':
      return [{ type: 'compaction', chatId, phase: 'done', trigger: 'auto', ts }];
    default:
      return [];
  }
}

/** Events that carry an id we can resume from; the transient preview
 *  events do not. */
export function eventId(ev: CloudStreamEvent): string | null {
  if (ev.type === 'event_start' || ev.type === 'event_delta') return null;
  return typeof (ev as { id?: unknown }).id === 'string' ? (ev as { id: string }).id : null;
}

/**
 * `https://github.com/<owner>/<repo>` for a git remote URL, or null when
 * the remote is not on GitHub. Managed Agents accepts exactly this form:
 * no `.git`, no SSH.
 */
export function githubRepoUrl(remote: string): string | null {
  const s = remote.trim();
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|git:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}`;
}

/** Where the sandbox clones `url` by default: `/workspace/<repo>`. */
export function mountPathFor(url: string): string {
  const name = url.split('/').pop() ?? 'repo';
  return `/workspace/${name}`;
}

/** One agent per model + effort; the key of the settings cache. */
export function agentCacheKey(model: ClaudeModelId, effort: ClaudeReasoningEffort): string {
  return `${model}|${effort}`;
}

/** The system prompt every PopBot cloud agent runs with. Chat-specific
 *  facts (the mounted repo, its branch) ride on the first message. */
export const CLOUD_SYSTEM_PROMPT =
  'You are a software engineering agent run by PopBot, working in an Anthropic cloud sandbox. ' +
  'The user talks to you from the PopBot desktop app; your replies appear in their chat. ' +
  'Work autonomously and finish what you are asked: the session keeps running while the user is away. ' +
  'Be precise about what you did and where.';

/**
 * What the agent is told on the first message of a session: where the
 * repository is and how work gets back to the user.
 */
export function cloudPreamble(
  repo: { url: string; branch: string; mountPath: string } | null,
  languageDirective: string,
): string {
  const now = new Date().toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
  const where = repo
    ? `The repository ${repo.url} is cloned at ${repo.mountPath} on branch ${repo.branch}; work there. ` +
      `When a piece of work is done, commit it and push it to branch ${repo.branch} on origin (the clone is ` +
      `authenticated), then say in your reply what you pushed. Never push to another branch. ` +
      `If a push is rejected, say so and keep the commits local.`
    : 'No repository is mounted; use /workspace as scratch space and put results in your reply.';
  return `[System] Starting up at ${now} (the user's local time) in an Anthropic cloud sandbox. ${where}${languageDirective}\n\n`;
}

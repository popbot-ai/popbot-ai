import {
  query as sdkQuery,
  type Options as SdkOptions,
  type PermissionResult,
  type Query as SdkQuery,
  type SDKAssistantMessageError,
  type SDKCompactBoundaryMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKStatusMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ContentBlockParam,
  ImageBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages';
import { extname } from 'node:path';
import { promises as fsp } from 'node:fs';
import type { AgentEvent, PermissionDecision } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_REASONING_EFFORT,
} from '@shared/persistence';
import { DEFAULT_CONTEXT_BUDGET } from '@shared/contextUsage';
import type { AgentBackend, AgentSession, SpawnOpts } from './types';
import { dlog } from '../diagLog';
import { sqliteSessionStore } from './sqliteSessionStore';

/** Anthropic image API only accepts these media types. The picker
 *  permits a wider set of extensions (heic/svg/avif) for UX, but if
 *  the SDK can't accept it we fall back to a text-reference block
 *  rather than corrupting the request. */
type AnthropicImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const SUPPORTED_IMAGE_MEDIA: Record<string, AnthropicImageMime> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Turn failures a retry cannot possibly fix — bad credentials, a
 * missing binary, a session the CLI won't accept. ONLY these earn the
 * red treatment and a stop.
 *
 * Everything else is assumed retryable, which is the deliberate
 * default: timeout, overload, dropped stream, empty reply, or some
 * subtype we've never seen — from the user's seat they're all just "it
 * didn't answer", and the useful response to that is to try again
 * rather than to explain. Listing what's hopeless is a much shorter and
 * more stable list than trying to enumerate everything transient.
 */
const FATAL_TURN_ERROR =
  /unauthor|forbidden|\b401\b|\b403\b|invalid[_ ]?api[_ ]?key|authenticat|credential|not logged in|no conversation found|enoent|command not found|permission denied|usage limit|rate limit reached|quota|out of (?:tokens|credit)|insufficient (?:credit|quota|balance)|billing|payment|upgrade your plan|limit (?:will )?reset|usage credits|usage allocation|seat type/i;

/**
 * Of the failures a retry can't fix, these are the ORDINARY ones —
 * you've used your tokens, the plan limit resets at 2pm, the session
 * needs re-authenticating. Nothing is broken; the user just has to know,
 * and probably to wait. They get a yellow notification, never red.
 *
 * Red is for actual breakage: exceptions, a broken API, a dead
 * connection, a corrupted database.
 *
 * "usage credits" / "usage allocation" / "seat type" cover the
 * credit-gated tiers: picking Claude Fable 5.1 (or Fable 5) on a plan
 * without usage credits comes back as "Fable … requires usage credits",
 * and the same wording family is what the CLI uses for "out of usage
 * credits" and "your seat type doesn't include usage".
 */
const EXPECTED_LIMIT =
  /usage limit|rate limit reached|quota|out of (?:tokens|credit)|insufficient (?:credit|quota|balance)|billing|payment|upgrade your plan|limit (?:will )?reset|usage credits|usage allocation|seat type|unauthor|\b401\b|\b403\b|invalid[_ ]?api[_ ]?key|authenticat|credential|not logged in/i;

/**
 * How to treat an API-level failure the CLI reports as a synthetic
 * assistant message (`SDKAssistantMessage.error`). The message's text is
 * a one-liner such as "Failed to authenticate. API Error: 401 OAuth
 * access token has expired." — rendering that as prose is how a sign-in
 * expiry used to look like the agent talking, with nothing done about it.
 *
 * `retryable` hands the turn to AgentHost's replay, which respawns the
 * CLI. That is the actual fix for an expired token: a fresh process reads
 * the credentials another process (or the user) has since refreshed;
 * the long-lived one keeps using the token it started with. If every
 * retry fails the same way, the user gets the yellow warning with what
 * to do. `max_output_tokens` is deliberately absent: that reply has real
 * content and renders normally.
 */
const API_ERROR_TREATMENT: Partial<Record<
  SDKAssistantMessageError,
  { level: 'error' | 'warning' | 'notice'; retryable: boolean }
>> = {
  authentication_failed: { level: 'warning', retryable: true },
  rate_limit: { level: 'notice', retryable: true },
  overloaded: { level: 'notice', retryable: true },
  server_error: { level: 'notice', retryable: true },
  billing_error: { level: 'warning', retryable: false },
  account_on_hold: { level: 'warning', retryable: false },
  oauth_org_not_allowed: { level: 'warning', retryable: false },
  model_not_found: { level: 'warning', retryable: false },
  invalid_request: { level: 'error', retryable: false },
  unknown: { level: 'error', retryable: false },
};

/** The biggest context window among the models a result reports usage
 *  for — the fallback budget when the CLI's own measurement is
 *  unavailable. */
function largestContextWindow(
  modelUsage: Record<string, { contextWindow: number }> | undefined,
): number | null {
  if (!modelUsage) return null;
  let best = 0;
  for (const u of Object.values(modelUsage)) {
    if (u.contextWindow > best) best = u.contextWindow;
  }
  return best > 0 ? best : null;
}

/** Read an attached image off disk, base64-encode it, and wrap it in
 *  the SDK's `image` content-block shape. Returns null if the file
 *  can't be read or the extension isn't one Anthropic accepts (the
 *  caller falls back to a text-reference block in that case). */
async function tryBuildImageBlock(att: PickedAttachment): Promise<ImageBlockParam | null> {
  const ext = extname(att.path).toLowerCase();
  const media_type = SUPPORTED_IMAGE_MEDIA[ext];
  if (!media_type) return null;
  try {
    const buf = await fsp.readFile(att.path);
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type,
        data: buf.toString('base64'),
      },
    };
  } catch (err) {
    dlog('claude.image-attach.read-failed', {
      path: att.path,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Real Claude backend. Wraps `@anthropic-ai/claude-agent-sdk` query() in
 * streaming-input mode so each chat is one long-lived session that
 * accepts multiple user turns.
 *
 * Per CORE_MODEL.md: this backend never writes to the DB. It emits
 * AgentEvents via the constructor-supplied onEvent callback; AgentHost
 * persists + broadcasts.
 */
export const ClaudeBackend: AgentBackend = {
  id: 'claude',
  capabilities: { skills: true, memory: true, subAgents: true, mcpHttp: true },

  spawn(opts: SpawnOpts): AgentSession {
    return new ClaudeSession(opts);
  },
};

class ClaudeSession implements AgentSession {
  private readonly chatId: string;
  private readonly cwd: string | null;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly initialSessionId: string | null;
  private readonly onSessionId?: (sessionId: string) => void;
  private readonly pathToClaudeCodeExecutable: string | null;
  private readonly resolveRule?: (toolName: string) => 'allow' | 'deny' | null;
  /** Per-slot HTTP MCP servers (e.g. this chat's Unity/Unreal editor). */
  private readonly mcpServers?: Record<string, { type: 'http'; url: string }>;
  private readonly model: string;
  private readonly reasoningEffort: SdkOptions['effort'];
  private query: SdkQuery | null = null;
  /** Latest session_id we've seen from the SDK; used to deduplicate
   *  the onSessionId callback so we only persist on changes. */
  private knownSessionId: string | null = null;

  // Streaming-input plumbing — the SDK pulls user messages from this
  // async iterable; we feed it via sendUser().
  private pending: SDKUserMessage[] = [];
  private waiters: Array<(msg: SDKUserMessage | null) => void> = [];
  private closed = false;

  // Permission requests waiting for a renderer decision.
  // Map of pending permission callbacks keyed by tool-use id. We
  // capture the original `input` alongside the resolve fn because the
  // SDK's allow-shape PermissionResult requires `updatedInput` — the
  // (possibly modified) tool input echoed back so the SDK can pass
  // it to the tool. Returning `{ behavior: 'allow' }` without it
  // fails the SDK's Zod union schema and surfaces as a tool error
  // ("expected record, received undefined" at `updatedInput`).
  private pendingPerms = new Map<string, {
    resolve: (r: PermissionResult) => void;
    input: Record<string, unknown>;
  }>();

  // The current in-flight assistant message id, used to group text deltas
  // into the same row.
  private currentMessageId: string | null = null;
  /** Message ids that produced at least one streamed text_delta.
   *  Assistant text reaches the UI through those deltas alone, so this
   *  is how we know whether a finished message actually said anything —
   *  see the backfill in the `assistant` branch of handleSDKMessage. */
  private streamedText = new Set<string>();
  /** Did the current turn emit ANYTHING the user can see — text or a
   *  tool call? A turn that ends having produced nothing is the
   *  "I sent a message and it just went quiet" failure, and it must
   *  never pass silently. Reset at each turn start. */
  private turnProducedOutput = false;
  /** Prompt tokens of the latest main-loop reply — what the conversation
   *  occupies right now. The fallback for the context-usage refresh when
   *  the CLI's own measurement can't be had. */
  private lastPromptTokens = 0;
  /** Window the last usage refresh measured against: the autocompact
   *  window the CLI resolves for the model (200K on 1M-window models by
   *  default), not the raw limit. Reused when a compaction boundary
   *  reports its new token count. */
  private contextBudget: number | null = null;
  /** Compaction in flight this turn. `succeeded` means the CLI said so
   *  but the boundary with the before/after counts hasn't arrived yet —
   *  the result branch reports completion if it never does. */
  private compactionPending: 'started' | 'succeeded' | null = null;
  /** The turn ended in an API-level failure reported through an
   *  assistant message (see API_ERROR_TREATMENT). The result that
   *  follows is a plain `success`, so without this it would also read
   *  as an empty turn and trigger a second retry. */
  private turnFailedByApi = false;

  constructor(opts: SpawnOpts) {
    this.chatId = opts.chatId;
    this.cwd = opts.cwd ?? null;
    this.onEvent = opts.onEvent;
    this.initialSessionId = opts.sessionId ?? null;
    this.onSessionId = opts.onSessionId;
    this.pathToClaudeCodeExecutable = opts.pathToClaudeCodeExecutable ?? null;
    this.resolveRule = opts.resolveRule;
    this.mcpServers = opts.mcpServers;
    this.model = opts.claudeModel ?? DEFAULT_CLAUDE_MODEL;
    this.reasoningEffort = opts.claudeReasoningEffort ?? DEFAULT_CLAUDE_REASONING_EFFORT;
    dlog('claude.start', {
      chatId: this.chatId,
      cwd: this.cwd,
      resumeId: this.initialSessionId,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      claudePath: this.pathToClaudeCodeExecutable,
    });
    this.start();
  }

  private async *userMessages(): AsyncIterable<SDKUserMessage> {
    while (true) {
      if (this.pending.length > 0) {
        yield this.pending.shift()!;
        continue;
      }
      if (this.closed) return;
      const msg = await new Promise<SDKUserMessage | null>((resolve) =>
        this.waiters.push(resolve),
      );
      if (msg === null) return;
      yield msg;
    }
  }

  private start(): void {
    const options: SdkOptions = {
      includePartialMessages: true,
      canUseTool: this.handleCanUseTool.bind(this),
      model: this.model,
      effort: this.reasoningEffort,
      // Establish the agent's project root. When set, the SDK uses
      // this as the cwd for tool invocations and as the boundary
      // outside of which permission prompts must trigger.
      ...(this.cwd ? { cwd: this.cwd } : {}),
      // When pinned, resume the existing transcript so the model
      // retains conversation history across chat reopens. When null,
      // the SDK creates a fresh session and we capture its UUID off
      // the first message (see handleSDKMessage).
      ...(this.initialSessionId ? { resume: this.initialSessionId } : {}),
      // CRITICAL for packaged builds: tell the SDK exactly where the
      // user's `claude` binary lives. Without this the SDK looks for
      // its own bundled native binary, which Vite-bundling strips —
      // resulting in "Native CLI binary for darwin-arm64 not found".
      ...(this.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable }
        : {}),
      // SDK-side transcript persistence. With this set, the CLI's
      // append-on-disk JSONL becomes a redundant local cache and our
      // SQLite is the canonical context store. On resume, the SDK
      // reads from us via `load(key)` and materializes the transcript
      // for the subprocess — no need for the file at
      // `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` to exist.
      sessionStore: sqliteSessionStore,
      // Per-slot editor MCP (Unity/Unreal on a slot-specific port), passed
      // in-memory so nothing is written to ~/.claude.json or the repo's
      // .mcp.json — each chat's agent connects to its own slot's editor.
      ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
    };
    try {
      this.query = sdkQuery({ prompt: this.userMessages(), options });
    } catch (err) {
      // Synchronous SDK setup error (e.g. SDK can't construct its
      // Query object). Surface as a chat error event before bubbling
      // so the user sees something even if the host's catch path is
      // bypassed for any reason.
      const message = err instanceof Error ? err.message : String(err);
      dlog('claude.start.failed', { chatId: this.chatId, error: message });
      this.onEvent({ type: 'error', chatId: this.chatId, message, ts: Date.now() });
      this.onEvent({ type: 'session-status', chatId: this.chatId, status: 'errored', ts: Date.now() });
      this.consumed = true;
      throw err;
    }
    void this.consume();
  }

  /** Set when the SDK's query iterator has finished (either naturally
   *  after a turn or via thrown error). Once true, this session is a
   *  no-op zombie — sendUser pushes into a queue nobody reads. The
   *  host calls isAlive() before reusing and respawns when needed. */
  private consumed = false;

  isAlive(): boolean {
    return !this.closed && !this.consumed;
  }

  private async consume(): Promise<void> {
    if (!this.query) return;
    try {
      for await (const msg of this.query) {
        this.handleSDKMessage(msg);
      }
      // Stream ended without throwing — the SDK considers the query
      // finished. Mark dead so the host respawns on the next turn.
      this.consumed = true;
    } catch (err) {
      if (this.closed) return;
      // Mark this session as a zombie even on error — without this,
      // isAlive() keeps returning true for a session whose for-await
      // is broken, and the next sendUser pushes into a queue nobody
      // is reading. The host's getOrSpawnSession respawns on
      // consumed; this catch path was the missing flip.
      this.consumed = true;
      const message = err instanceof Error ? err.message : String(err);
      this.onEvent({ type: 'error', chatId: this.chatId, message, ts: Date.now() });
      this.onEvent({
        type: 'session-status',
        chatId: this.chatId,
        status: 'errored',
        ts: Date.now(),
      });
    }
  }

  private handleSDKMessage(msg: SDKMessage): void {
    // After dispose() the SDK query can still flush one or two more
    // messages from its internal buffer; ignore them so we don't
    // re-persist a session_id from a session we just abandoned.
    if (this.closed) return;
    // Most SDK messages carry the session_id. We capture it locally
    // (knownSessionId), but we only report it up to the host for
    // pinning when it's safe to do so.
    //
    // Pin policy:
    //   - Fresh spawn (no initialSessionId) → SDK assigns a real id;
    //     pin it. This is the first-turn case for a new chat.
    //   - Resume (initialSessionId set) AND SDK echoes back the same
    //     id → no-op; the chat is already pinned to this id.
    //   - Resume AND SDK reports a DIFFERENT id → the resume failed.
    //     The SDK created a transient session that has no content
    //     and will likely error immediately. Pinning to it would
    //     corrupt our pin and break the next resume (the
    //     "session-id pin drift" cascade we saw on slot-6). Skip
    //     the pin and let bad-session self-heal pick a durable id.
    const sid = (msg as { session_id?: string }).session_id;
    if (sid && sid !== this.knownSessionId) {
      const prior = this.knownSessionId;
      this.knownSessionId = sid;
      const safeToPin = this.initialSessionId === null;
      if (safeToPin) {
        this.onSessionId?.(sid);
      } else if (sid !== this.initialSessionId) {
        // Diverged from a requested resume — log so we can correlate
        // with bad-session events. Don't promote.
        dlog('claude.session-id.drift-suppressed', {
          chatId: this.chatId,
          requestedResume: this.initialSessionId,
          reported: sid,
          priorKnown: prior,
        });
      }
    }
    const ts = Date.now();
    if (process.env.POPBOT_DEBUG_SDK === '1') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const os = require('node:os') as typeof import('node:os');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('node:path') as typeof import('node:path');
        const summary: Record<string, unknown> = { type: msg.type };
        if ('subtype' in msg) summary.subtype = msg.subtype;
        if (msg.type === 'stream_event') {
          summary.event_type = msg.event.type;
          if (msg.event.type === 'content_block_start') {
            summary.block_type = msg.event.content_block.type;
            if (msg.event.content_block.type === 'tool_use') {
              summary.tool_name = msg.event.content_block.name;
              summary.tool_id = msg.event.content_block.id;
            }
          }
        }
        if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
          summary.blocks = msg.message.content.map((b) => b.type);
        }
        fs.appendFileSync(path.join(os.tmpdir(), 'popbot-sdk-debug.log'),
          `${new Date().toISOString()} ${JSON.stringify(summary)}\n`);
      } catch {
        // ignore debug failures
      }
    }

    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (ev.type === 'message_start') {
        this.currentMessageId = msg.uuid;
        this.turnProducedOutput = true;
        this.onEvent({
          type: 'message-start',
          chatId: this.chatId,
          messageId: msg.uuid,
          role: 'agent',
          ts,
        });
      } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
        this.turnProducedOutput = true;
        // Emit tool-use as soon as we see the block start (we get name + id
        // here; input arrives via input_json_delta + finalizes in the full
        // assistant message). Persisting early means tool-result never
        // arrives before the row exists.
        this.onEvent({
          type: 'tool-use',
          chatId: this.chatId,
          messageId: this.currentMessageId ?? msg.uuid,
          toolUseId: ev.content_block.id,
          name: ev.content_block.name,
          args: (ev.content_block.input as Record<string, unknown>) ?? {},
          ts,
        });
      } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        const messageId = this.currentMessageId ?? msg.uuid;
        this.streamedText.add(messageId);
        this.onEvent({
          type: 'text-delta',
          chatId: this.chatId,
          messageId,
          delta: ev.delta.text,
          ts,
        });
      }
      return;
    }

    if (msg.type === 'assistant') {
      const content = msg.message.content;
      if (!Array.isArray(content)) return;

      const apiError = (msg as { error?: SDKAssistantMessageError }).error;
      if (apiError && msg.parent_tool_use_id === null && API_ERROR_TREATMENT[apiError]) {
        this.handleApiError(apiError, content, ts);
        return;
      }

      // Main-loop replies carry the API usage of the request that
      // produced them, and its prompt size IS the context in use.
      if (msg.parent_tool_use_id === null && msg.message.usage) {
        const u = msg.message.usage;
        const prompt =
          (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (prompt > 0) this.lastPromptTokens = prompt + (u.output_tokens ?? 0);
      }

      // TEXT BACKFILL — the "it went quiet and never answered" bug.
      //
      // Assistant text reaches the UI only through streamed text_delta
      // events. When a turn completes without them — the message
      // arrives whole rather than in pieces — the row that message_start
      // created stays empty, message-end flushes nothing, and the chat
      // drops to idle having rendered NO reply at all. No error, because
      // as far as the SDK is concerned the turn succeeded.
      //
      // The finalized assistant message always carries the complete
      // text, so use it as the source of truth whenever nothing
      // streamed for this message. Guarded on streamedText so the
      // normal streaming path can't double-render.
      const textBlocks = content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (textBlocks.length > 0) {
        const messageId = this.currentMessageId ?? msg.uuid;
        if (!this.streamedText.has(messageId)) {
          dlog('claude.text.backfilled', {
            chatId: this.chatId,
            sessionId: this.knownSessionId,
            messageId,
            chars: textBlocks.length,
            hadMessageStart: this.currentMessageId !== null,
          });
          // No message_start either (nothing streamed at all) — open the
          // row first, otherwise the delta has nothing to land in.
          if (this.currentMessageId === null) {
            this.currentMessageId = msg.uuid;
            this.onEvent({
              type: 'message-start',
              chatId: this.chatId,
              messageId,
              role: 'agent',
              ts,
            });
          }
          this.streamedText.add(messageId);
          this.turnProducedOutput = true;
          this.onEvent({
            type: 'text-delta',
            chatId: this.chatId,
            messageId,
            delta: textBlocks,
            ts,
          });
        }
      }

      for (const block of content) {
        if (block.type === 'tool_use') {
          // Log every finalized tool_use the SDK emits — pairs with
          // perm.request to confirm the SDK saw the same tool we
          // approved/denied, and with sdk.tool-result to confirm
          // execution actually happened.
          this.turnProducedOutput = true;
          dlog('sdk.tool-use', {
            chatId: this.chatId,
            sessionId: this.knownSessionId,
            tool: block.name,
            toolUseId: block.id,
          });
          // Re-emit with the now-finalized input. The renderer + persistence
          // upsert/merge so the earlier stream_event-based emission gets
          // patched with the complete args here.
          this.onEvent({
            type: 'tool-use',
            chatId: this.chatId,
            messageId: msg.uuid,
            toolUseId: block.id,
            name: block.name,
            args: (block.input as Record<string, unknown>) ?? {},
            ts,
          });
        }
      }
      return;
    }

    if (msg.type === 'user') {
      const content = msg.message.content;
      if (typeof content === 'string') return;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type === 'tool_result') {
          let text = '';
          if (typeof block.content === 'string') {
            text = block.content;
          } else if (Array.isArray(block.content)) {
            text = block.content
              .map((c) => (c.type === 'text' ? c.text : ''))
              .join('');
          }
          // Log tool_result reception — this is the proof that a
          // tool actually executed and produced output. If we have
          // perm.resolve.allow but no matching sdk.tool-result, the
          // tool didn't run.
          dlog('sdk.tool-result', {
            chatId: this.chatId,
            sessionId: this.knownSessionId,
            toolUseId: block.tool_use_id,
            isError: !!block.is_error,
            textLen: text.length,
            // First 200 chars to fingerprint without bloating the log.
            textHead: text.slice(0, 200),
          });
          this.onEvent({
            type: 'tool-result',
            chatId: this.chatId,
            // SDKUserMessage.uuid is optional; messageId is informational
            // here (the row is keyed by toolUseId in AgentHost.persist).
            messageId: msg.uuid ?? '',
            toolUseId: block.tool_use_id,
            isError: !!block.is_error,
            text,
            ts,
          });
        }
      }
      return;
    }

    if (msg.type === 'system') {
      const subtype = (msg as { subtype?: string }).subtype;
      // Compaction progress: a status pair brackets the work, and a
      // boundary with the before/after counts follows a success.
      if (subtype === 'status') {
        this.handleStatus(msg as unknown as SDKStatusMessage, ts);
        return;
      }
      if (subtype === 'compact_boundary') {
        this.handleCompactBoundary(msg as unknown as SDKCompactBoundaryMessage, ts);
        return;
      }
      // The first SDKSystemMessage with subtype 'init' is the SDK's
      // explicit "subprocess is alive, session is initialized" signal.
      // We don't surface anything else from it; the session_id capture
      // above already handled the meaningful content.
      if (subtype === 'init') {
        dlog('claude.init', {
          chatId: this.chatId,
          sessionId: this.knownSessionId,
        });
        this.turnProducedOutput = false;
        this.turnFailedByApi = false;
        // The CLI has dequeued a message and is starting a turn on it.
        // AgentHost counts these against the messages we've handed over,
        // so it can tell "all caught up" from "your last message is
        // still queued behind the turn that just ended".
        this.onEvent({ type: 'turn-start', chatId: this.chatId, ts });
      }
      return;
    }

    // NOTE: previously handled `msg.type === 'status'` (compaction
    // ping) and `msg.type === 'mirror_error'` (SessionStore append
    // failure). Both were removed from the SDK's SDKMessage union
    // in 0.2.140. If the SDK reintroduces persistence-failure or
    // long-internal-work signals under different names, add handlers
    // here. For now session-store failures will surface through
    // result.subtype + the `errors[]` field we already capture
    // and forward into the chat as a user-visible error.

    if (msg.type === 'result') {
      if (this.currentMessageId) {
        this.onEvent({
          type: 'message-end',
          chatId: this.chatId,
          messageId: this.currentMessageId,
          ts,
        });
      }
      if (this.compactionPending === 'succeeded') {
        // The CLI said the compaction succeeded but never sent the
        // boundary carrying the before/after counts. Still say it's done.
        this.compactionPending = null;
        this.onEvent({ type: 'compaction', chatId: this.chatId, phase: 'done', ts });
      }
      if (msg.subtype === 'success') void this.refreshContextUsage(msg);
      // Terminal status: success → idle, anything else → error. The SDK
      // uses subtypes like 'error_max_turns' and 'error_during_execution'
      // for real turn failures; previously we treated them all as success.
      if (msg.subtype === 'success') {
        // A "successful" turn that produced no text and made no tool
        // call has, from the user's seat, ignored them: the cursor
        // spins for a moment and the chat goes quiet with nothing to
        // show. The SDK reports success, so nothing else will ever
        // flag it. Say so rather than leave them staring at silence.
        if (!this.turnProducedOutput && !this.turnFailedByApi) {
          dlog('claude.turn.empty', {
            chatId: this.chatId,
            sessionId: this.knownSessionId,
            usage: (msg as { usage?: unknown }).usage,
          });
          this.onEvent({
            type: 'error',
            chatId: this.chatId,
            message: 'the agent ended its turn without saying anything',
            level: 'notice',
            // Nothing was produced, so replaying can't duplicate work.
            retryable: true,
            ts,
          });
        }
        this.onEvent({ type: 'session-status', chatId: this.chatId, status: 'idle', ts });
      } else {
        const subtype = (msg as { subtype?: string }).subtype ?? 'error';
        // Dump the full result payload so we can see what Claude
        // actually said went wrong — without this we only know the
        // subtype, which is insufficient for diagnosing surprises
        // like "tool input rejected by Zod" or "session not found".
        // structuredClone strips non-cloneable handles cleanly; the
        // JSON path is a final fallback for exotic types.
        let resultDetail: unknown;
        try {
          resultDetail = structuredClone(msg);
        } catch {
          // Some SDK versions stash non-cloneable handles on the
          // message; in that case, dump just the keys we know are
          // safe so we still capture *something* for postmortem.
          const safe = msg as Record<string, unknown>;
          resultDetail = {
            unstringifiable: true,
            subtype: safe.subtype,
            type: safe.type,
            session_id: safe.session_id,
          };
        }
        dlog('claude.result.error', {
          chatId: this.chatId,
          subtype,
          detail: resultDetail,
        });
        // Pull the actual SDK error string into the chat-visible
        // message so the user can paste it back to us for debugging.
        // The SDK puts human-readable text in `errors: string[]`;
        // we join with " · " so multiple errors are readable, then
        // fall through to the subtype if errors is empty for some
        // reason. Capped at 500 chars so a stack trace from the
        // CLI subprocess doesn't drown the chat.
        const sdkErrors = (msg as { errors?: unknown }).errors;
        let detailText = '';
        if (Array.isArray(sdkErrors)) {
          detailText = sdkErrors
            .filter((e): e is string => typeof e === 'string' && e.length > 0)
            .join(' · ')
            .slice(0, 500);
        }
        // Retry unless it's provably hopeless. A turn that failed
        // having produced nothing can always be redone safely, so the
        // only question is whether redoing it could ever help.
        const fatal = FATAL_TURN_ERROR.test(`${subtype} ${detailText}`);
        const recoverable = !fatal && !this.turnProducedOutput;
        const userMessage = detailText
          ? `${subtype}: ${detailText}`
          : `the agent's turn ended early (${subtype})`;
        this.onEvent({
          type: 'error',
          chatId: this.chatId,
          message: userMessage,
          // Grey if we're retrying it; yellow for an ordinary limit the
          // user must wait out; red only for real breakage.
          level: !fatal ? 'notice' : EXPECTED_LIMIT.test(`${subtype} ${detailText}`) ? 'warning' : 'error',
          retryable: recoverable,
          ts,
        });
        // A retryable turn isn't a dead end — AgentHost is about to
        // replay it, so don't paint the chat red on the way past.
        if (!recoverable) {
          this.onEvent({ type: 'session-status', chatId: this.chatId, status: 'errored', ts });
        }
      }
      this.currentMessageId = null;
      // Ids are per-turn; drop them so a long session doesn't accumulate.
      this.streamedText.clear();
    }
  }

  private async handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ): Promise<PermissionResult> {
    const permissionId = options.toolUseID;
    // Log every canUseTool invocation: the SDK is asking us to gate a
    // tool. We capture the input *keys* (not values — bash commands and
    // file contents can be huge) so we can correlate to the SDK's own
    // permission_denials list without bloating the log.
    dlog('perm.request', {
      chatId: this.chatId,
      sessionId: this.knownSessionId,
      tool: toolName,
      permissionId,
      inputKeys: Object.keys(input),
      // bash command is the most useful single field for triage
      command: typeof input.command === 'string' ? input.command : undefined,
      signalAlreadyAborted: options.signal.aborted,
    });
    // Consult stored permission rules (per-chat first, then global)
    // before bothering the user. A matching rule short-circuits the
    // prompt and resolves immediately — that's what makes "Allow
    // always" actually save you clicks. No 'permission-request'
    // event is dispatched in this path so the renderer never shows
    // a card; we still log the auto-decision for the audit trail.
    const ruleDecision = this.resolveRule?.(toolName) ?? null;
    if (ruleDecision === 'allow') {
      dlog('perm.auto.allow', {
        chatId: this.chatId,
        sessionId: this.knownSessionId,
        tool: toolName,
        permissionId,
      });
      return { behavior: 'allow', updatedInput: input };
    }
    if (ruleDecision === 'deny') {
      dlog('perm.auto.deny', {
        chatId: this.chatId,
        sessionId: this.knownSessionId,
        tool: toolName,
        permissionId,
      });
      return { behavior: 'deny', message: 'denied by saved rule' };
    }
    this.onEvent({
      type: 'permission-request',
      chatId: this.chatId,
      permissionId,
      tool: toolName,
      args: input,
      ts: Date.now(),
    });
    return new Promise<PermissionResult>((resolve) => {
      this.pendingPerms.set(permissionId, { resolve, input });
      options.signal.addEventListener('abort', () => {
        if (this.pendingPerms.delete(permissionId)) {
          dlog('perm.resolve.aborted', {
            chatId: this.chatId,
            sessionId: this.knownSessionId,
            tool: toolName,
            permissionId,
          });
          resolve({ behavior: 'deny', message: 'aborted' });
        }
      });
    });
  }

  /** An API-level failure reported as an assistant message. Never shown
   *  as prose: it becomes the turn's error, retried or not per
   *  API_ERROR_TREATMENT, and the turn is marked failed so the plain
   *  `success` result that follows isn't mistaken for an empty reply. */
  private handleApiError(
    kind: SDKAssistantMessageError,
    content: Array<{ type: string; text?: string }>,
    ts: number,
  ): void {
    const treatment = API_ERROR_TREATMENT[kind];
    if (!treatment) return;
    const said = content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join(' ')
      .trim()
      .slice(0, 300);
    this.turnFailedByApi = true;
    dlog('claude.api-error', { chatId: this.chatId, sessionId: this.knownSessionId, kind, said });
    const message = kind === 'authentication_failed'
      ? `Claude sign-in has expired${said ? ` (${said})` : ''}. `
        + 'Run `claude` in a terminal and sign in again, then press Retry.'
      : said || `Claude API error: ${kind}`;
    this.onEvent({
      type: 'error',
      chatId: this.chatId,
      message,
      level: treatment.level,
      // Nothing was produced, so replaying can't duplicate work — and
      // the replay spawns a fresh CLI, which is what picks up refreshed
      // credentials.
      retryable: treatment.retryable,
      ts,
    });
  }

  /** Manual compaction. The CLI handles `/compact` itself when it arrives
   *  as a user turn — the same path a user typing the slash command
   *  takes — and reports progress through the status / compact_boundary
   *  messages handled below. It answers with its own init and result, so
   *  the host's turn bookkeeping applies unchanged. */
  async compact(): Promise<void> {
    await this.sendUser('/compact');
  }

  private handleStatus(msg: SDKStatusMessage, ts: number): void {
    if (msg.status === 'compacting') {
      this.compactionPending = 'started';
      // Compaction IS this turn's output. A successful /compact ends in
      // a zero-usage result with no assistant text; without this it
      // would read as an empty turn, and AgentHost would replay the
      // user's previous message on top of the freshly compacted context.
      this.turnProducedOutput = true;
      dlog('claude.compact.start', { chatId: this.chatId, sessionId: this.knownSessionId });
      this.onEvent({ type: 'compaction', chatId: this.chatId, phase: 'started', ts });
      return;
    }
    if (msg.compact_result === 'failed') {
      this.compactionPending = null;
      this.turnProducedOutput = true;
      dlog('claude.compact.failed', {
        chatId: this.chatId,
        sessionId: this.knownSessionId,
        error: msg.compact_error,
      });
      this.onEvent({
        type: 'compaction',
        chatId: this.chatId,
        phase: 'failed',
        error: msg.compact_error,
        ts,
      });
      return;
    }
    if (msg.compact_result === 'success') {
      // The boundary with the token counts follows; report on it (or on
      // the result, if it never comes).
      this.compactionPending = 'succeeded';
      this.turnProducedOutput = true;
    }
  }

  private handleCompactBoundary(msg: SDKCompactBoundaryMessage, ts: number): void {
    const meta = msg.compact_metadata;
    this.compactionPending = null;
    this.turnProducedOutput = true;
    dlog('claude.compact.done', {
      chatId: this.chatId,
      sessionId: this.knownSessionId,
      trigger: meta.trigger,
      preTokens: meta.pre_tokens,
      postTokens: meta.post_tokens,
      durationMs: meta.duration_ms,
    });
    this.onEvent({
      type: 'compaction',
      chatId: this.chatId,
      phase: 'done',
      trigger: meta.trigger,
      preTokens: meta.pre_tokens,
      postTokens: meta.post_tokens,
      durationMs: meta.duration_ms,
      ts,
    });
    // The window just shrank — show it now rather than after the next turn.
    if (typeof meta.post_tokens === 'number') {
      this.lastPromptTokens = meta.post_tokens;
      this.onEvent({
        type: 'usage',
        chatId: this.chatId,
        tokens: { used: meta.post_tokens, budget: this.contextBudget ?? DEFAULT_CONTEXT_BUDGET },
        ts,
      });
    }
  }

  /**
   * Report how full the context window is, as a `usage` event: the
   * tokens the conversation occupies against the window the CLI will
   * autocompact at. Asked of the CLI after each turn; the summary detail
   * answers from the last response's usage without an API call. Falls
   * back to the last reply's own prompt size against the model's window.
   */
  private async refreshContextUsage(
    msg: Extract<SDKResultMessage, { subtype: 'success' }>,
  ): Promise<void> {
    const u = msg.usage;
    const promptTokens =
      (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
    // No API usage this turn — a slash command such as /compact. There
    // is nothing new to measure, and the CLI's estimate for such a turn
    // over-counts, so keep the last reading.
    if (promptTokens === 0) return;
    const query = this.query;
    if (!query || this.closed) return;
    let used = this.lastPromptTokens;
    let budget = this.contextBudget ?? largestContextWindow(msg.modelUsage) ?? DEFAULT_CONTEXT_BUDGET;
    try {
      const ctx = await query.getContextUsage({ detail: 'summary' });
      if (ctx.totalTokens > 0 && ctx.rawMaxTokens > 0) {
        used = ctx.totalTokens;
        budget = ctx.rawMaxTokens;
      }
    } catch (err) {
      dlog('claude.context-usage.failed', {
        chatId: this.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (this.closed) return;
    this.contextBudget = budget;
    dlog('claude.context-usage', { chatId: this.chatId, sessionId: this.knownSessionId, used, budget });
    this.onEvent({ type: 'usage', chatId: this.chatId, tokens: { used, budget }, ts: Date.now() });
  }

  async sendUser(text: string, attachments?: PickedAttachment[]): Promise<void> {
    // Build the user MessageParam. Without attachments, content is a
    // plain string (cheapest representation, equivalent to a single
    // text block). With attachments, we have to use the array form
    // so we can include `image` content blocks for image files —
    // base64-encoded bytes the model sees natively, instead of
    // forcing it to call Read on the path.
    let content: MessageParam['content'];
    if (!attachments || attachments.length === 0) {
      content = text;
    } else {
      const blocks: ContentBlockParam[] = [];
      for (const att of attachments) {
        if (att.isImage) {
          const block = await tryBuildImageBlock(att);
          if (block) {
            blocks.push(block);
            continue;
          }
        }
        // Non-image (or image we couldn't read): fall back to a text
        // reference so Claude can pick it up via Read. Same shape as
        // the old in-text "Attached file: `path`" hint, just emitted
        // as its own text block so the user's message stays clean.
        blocks.push({
          type: 'text',
          text: `${att.isImage ? 'Attached image' : 'Attached file'}: \`${att.path}\``,
        });
      }
      // The user's typed message goes last so the agent reads the
      // attachments first as context, then the actual ask.
      if (text.trim().length > 0) {
        blocks.push({ type: 'text', text });
      }
      content = blocks;
    }
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    if (this.waiters.length > 0) {
      this.waiters.shift()!(msg);
    } else {
      this.pending.push(msg);
    }
    this.onEvent({
      type: 'session-status',
      chatId: this.chatId,
      status: 'running',
      ts: Date.now(),
    });
  }

  approve(permissionId: string, decision: PermissionDecision): void {
    const pending = this.pendingPerms.get(permissionId);
    if (!pending) {
      // Log this — could indicate a race where approve arrived after
      // dispose, or a bogus permissionId from the renderer.
      dlog('perm.resolve.miss', {
        chatId: this.chatId,
        sessionId: this.knownSessionId,
        permissionId,
        decision,
        pendingCount: this.pendingPerms.size,
      });
      return;
    }
    this.pendingPerms.delete(permissionId);
    // Any 'allow*' variant resolves with allow + echoed input. The
    // scope (chat vs everywhere) only affects whether AgentHost
    // persists a rule — that's already happened by the time we get
    // here, so the SDK only needs to know the binary outcome.
    if (decision.startsWith('allow')) {
      // Echo the original input back unchanged — required by the SDK's
      // PermissionResult schema. We don't modify the tool input on
      // user-allow, so passing the original record satisfies the
      // contract without affecting behavior.
      const result = { behavior: 'allow' as const, updatedInput: pending.input };
      dlog('perm.resolve.allow', {
        chatId: this.chatId,
        sessionId: this.knownSessionId,
        permissionId,
        // Log the exact shape we're returning so we can confirm the
        // SDK is receiving what we think we're sending.
        resultBehavior: result.behavior,
        resultInputKeys: Object.keys(result.updatedInput),
      });
      pending.resolve(result);
    } else {
      const result = { behavior: 'deny' as const, message: 'user denied' };
      dlog('perm.resolve.deny', {
        chatId: this.chatId,
        sessionId: this.knownSessionId,
        permissionId,
        resultBehavior: result.behavior,
        resultMessage: result.message,
      });
      pending.resolve(result);
    }
  }

  stop(): void {
    // Log who's interrupting and how many perms were in flight — if
    // a stop arrives mid-permission, the SDK aborts the request and
    // the abort signal fires our resolve.aborted path. Capturing the
    // pending count lets us correlate a stop event with the
    // aborted_streaming we sometimes see in result errors.
    dlog('claude.stop', {
      chatId: this.chatId,
      sessionId: this.knownSessionId,
      pendingPerms: this.pendingPerms.size,
    });
    void this.query?.interrupt().catch(() => undefined);
  }

  /**
   * Async dispose. We await `query.interrupt()` so the SDK's child
   * `claude` process has a chance to flush its session JSONL before
   * the app exits. Without this, hitting ⌘Q while the agent was
   * mid-stream would lose the in-flight JSONL writes — causing
   * "no conversation found" rejections when the chat is reopened.
   *
   * The 5s cap is a safety net: in the rare case the SDK never
   * resolves the interrupt, we don't wedge `before-quit` indefinitely.
   */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    dlog('claude.dispose.begin', { chatId: this.chatId, sessionId: this.knownSessionId });
    try {
      await Promise.race([
        this.query?.interrupt().catch(() => undefined) ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // best-effort — never throw from dispose
    }
    while (this.waiters.length > 0) {
      this.waiters.shift()!(null);
    }
    if (this.pendingPerms.size > 0) {
      // Log dispose-time drain so we can spot cases where the session
      // tore down with permission requests still in flight (e.g. user
      // closed the chat mid-prompt, or a forced respawn ate the
      // pending callback).
      dlog('perm.drain.dispose', {
        chatId: this.chatId,
        sessionId: this.knownSessionId,
        drainedCount: this.pendingPerms.size,
        permissionIds: [...this.pendingPerms.keys()],
      });
    }
    for (const pending of this.pendingPerms.values()) {
      pending.resolve({ behavior: 'deny', message: 'session disposed' });
    }
    this.pendingPerms.clear();
    dlog('claude.dispose.done', { chatId: this.chatId, sessionId: this.knownSessionId });
  }
}

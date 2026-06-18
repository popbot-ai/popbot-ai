import type { AgentEvent, PermissionDecision } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import type {
  ClaudeModelId,
  ClaudeReasoningEffort,
  CodexModelId,
  CodexReasoningEffort,
} from '@shared/persistence';

/**
 * The thin contract between AgentHost and a concrete backend (Claude SDK,
 * Codex SDK, stub, etc.). Each session is one chat's lifetime.
 *
 * Sessions push AgentEvents synchronously via the constructor-supplied
 * `onEvent` callback. The host re-broadcasts to renderer + persistence.
 */
export interface AgentBackend {
  readonly id: 'claude' | 'codex' | 'stub';
  readonly capabilities: {
    skills: boolean;
    memory: boolean;
    subAgents: boolean;
    mcpHttp: boolean;
  };

  spawn(opts: SpawnOpts): AgentSession;
}

export interface SpawnOpts {
  chatId: string;
  /**
   * Initial transcript replayed at session start so the agent has context.
   * Each item is a (role, text) pair; tool / permission entries are included
   * as a flattened transcript narration (we don't replay them as live tool
   * calls — that would re-execute side effects).
   */
  history: Array<{ role: 'user' | 'agent' | 'system'; text: string }>;
  /**
   * Working directory the agent should treat as the project root. For
   * slot-backed chats this is the chat's worktree; for ad-hoc chats
   * (no slot) it's null and the backend can pick a sane default.
   * Backends that respect this (Claude/Codex SDKs) use it to scope
   * file-system permissions.
   */
  cwd?: string | null;
  /**
   * Pinned Claude SDK session UUID. When set, the backend resumes this
   * session so the agent retains conversation history; when null, a
   * fresh session is started and the backend reports the new
   * session_id back via `onSessionId` so the host can persist it.
   */
  sessionId?: string | null;
  /** Provider-specific model and effort selections. Stored separately
   *  because chats can switch between Claude and Codex. */
  claudeModel?: ClaudeModelId | null;
  claudeReasoningEffort?: ClaudeReasoningEffort | null;
  codexModel?: CodexModelId | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  onEvent(event: AgentEvent): void;
  /** Raw Codex stream cache hook. AgentHost persists these events so
   *  PopBot owns a recovery copy even though Codex resumes from its
   *  native ~/.codex session store. */
  onCodexEvent?(event: {
    chatId: string;
    threadId: string;
    eventType: string;
    payload: unknown;
  }): void;
  /**
   * Called once when the backend learns its session UUID. Either echoes
   * the resumed `sessionId` (no-op for the host) or reports a new one
   * for the host to pin to the chat.
   */
  onSessionId?(sessionId: string): void;
  /**
   * Absolute path to the `claude` CLI binary, when known. Required in
   * packaged builds because the SDK's bundled-binary lookup doesn't
   * survive Vite bundling — without this the SDK errors with "Native
   * CLI binary for darwin-arm64 not found." The host fills this in
   * from the startup probe. Null is safe in dev when claude is on PATH.
   */
  pathToClaudeCodeExecutable?: string | null;
  /** Absolute path to the `codex` CLI binary, when known. If omitted,
   *  the Codex SDK falls back to its packaged CLI dependency. */
  pathToCodexExecutable?: string | null;
  /**
   * Permission rule resolver. Called from the backend's `canUseTool`
   * before prompting the user. Returns 'allow' or 'deny' to skip the
   * prompt entirely (consults per-chat rules first, then global), or
   * null to fall through and prompt as normal.
   */
  resolveRule?(toolName: string): 'allow' | 'deny' | null;
}

export interface AgentSession {
  /** Send a user message; agent will respond by streaming events.
   *  Optional `attachments` are images / files attached to this turn:
   *  the backend reads each from disk, base64-encodes images, and
   *  builds a proper `MessageParam` content array so Claude sees the
   *  image natively rather than having to Read the path back. */
  sendUser(text: string, attachments?: PickedAttachment[]): Promise<void>;
  /** Resolve a pending permission request. */
  approve(permissionId: string, decision: PermissionDecision): void;
  /** Cancel any in-flight work. The session can still receive new messages after stop(). */
  stop(): void;
  /** Tear down the session. Async because real backends spawn a child
   *  `claude` process that needs a beat to flush its session JSONL —
   *  without awaiting it, ⌘Q can amputate writes mid-flight and the
   *  next resume hits "no conversation found". */
  dispose(): Promise<void>;
  /** False once the underlying SDK query has finished iterating —
   *  any messages pushed after this would be silently dropped, so the
   *  host should dispose + respawn. */
  isAlive(): boolean;
}

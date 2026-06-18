/**
 * Agent event stream — what the main process pushes to the renderer for a
 * live chat session. Modeled on the Claude Agent SDK's event shape so the
 * stub backend and the real backend produce indistinguishable streams.
 */

import type { MessageRecord } from './persistence';

export type AgentEventType =
  | 'message-start'
  | 'text-delta'
  | 'tool-use'
  | 'tool-result'
  | 'permission-request'
  | 'message-end'
  | 'session-status'
  | 'usage'
  | 'error';

export interface MessageStartEvent {
  type: 'message-start';
  chatId: string;
  messageId: string;
  role: 'agent';
  ts: number;
}

export interface TextDeltaEvent {
  type: 'text-delta';
  chatId: string;
  messageId: string;
  delta: string;
  ts: number;
}

export interface ToolUseEvent {
  type: 'tool-use';
  chatId: string;
  messageId: string;
  toolUseId: string;
  name: string;
  args: Record<string, unknown>;
  ts: number;
}

export interface ToolResultEvent {
  type: 'tool-result';
  chatId: string;
  messageId: string;
  toolUseId: string;
  isError: boolean;
  /** Stringified result (markdown / text / JSON). */
  text: string;
  ts: number;
}

export interface PermissionRequestEvent {
  type: 'permission-request';
  chatId: string;
  permissionId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Agent's stated reason for wanting this. */
  reason?: string;
  ts: number;
}

export interface MessageEndEvent {
  type: 'message-end';
  chatId: string;
  messageId: string;
  ts: number;
}

export interface SessionStatusEvent {
  type: 'session-status';
  chatId: string;
  status: 'running' | 'idle' | 'paused' | 'errored' | 'complete';
  ts: number;
}

export interface UsageEvent {
  type: 'usage';
  chatId: string;
  tokens: { used: number; budget: number };
  ts: number;
}

export interface ErrorEvent {
  type: 'error';
  chatId: string;
  message: string;
  ts: number;
}

/**
 * Emitted when AgentHost has just inserted a complete row into the DB
 * outside the streaming-text flow (e.g. the user's own message). Lets the
 * renderer's useMessages append it without waiting for a refetch.
 */
export interface MessageAddedEvent {
  type: 'message-added';
  chatId: string;
  message: MessageRecord;
  ts: number;
}

/**
 * Emitted when the user's allow/deny on a permission card has been
 * recorded into the row's body. Renderer uses this to flip its in-memory
 * permission message from undecided → decided so the big card collapses.
 */
export interface PermissionDecidedEvent {
  type: 'permission-decided';
  chatId: string;
  permissionId: string;
  decision: PermissionDecision;
  ts: number;
}

export type AgentEvent =
  | MessageStartEvent
  | TextDeltaEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionDecidedEvent
  | MessageEndEvent
  | MessageAddedEvent
  | SessionStatusEvent
  | UsageEvent
  | ErrorEvent;

/**
 * User decision on a permission prompt. The scope determines whether
 * we also persist a rule that auto-resolves matching future prompts:
 *   - `allow` / `deny`           — once, no rule stored
 *   - `allow-chat`               — allow rule stored on the chat record
 *   - `allow-everywhere` / `deny-everywhere` — rule stored in global settings
 *
 * Asymmetric on purpose: we expose three allow scopes (once / chat / global)
 * because "trust this tool here but not elsewhere" is a real workflow,
 * but we only expose two deny scopes (once / global). A per-chat deny
 * is rarely useful — if you don't trust a tool at all, you want it off
 * everywhere; if you do trust it, you decide per-call.
 *
 * Rules are tool-name only in v1; command-pattern matching is deferred.
 */
export type PermissionDecision =
  | 'allow'
  | 'allow-chat'
  | 'allow-everywhere'
  | 'deny'
  | 'deny-everywhere';

/** Stored permission rule. v1: tool-name only. */
export interface PermissionRule {
  tool: string;
  action: 'allow' | 'deny';
}
